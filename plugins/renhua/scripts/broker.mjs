#!/usr/bin/env node
// Long-lived per-session process that keeps one `codex app-server` warm and runs translations on request.
//
// Protocol: one JSON object per line over a Unix socket.
//   {"id":1,"method":"ping"}                    -> health
//   {"id":2,"method":"run","params":{...}}      -> {"text": "...", "ms": 1234}
//   {"id":3,"method":"shutdown"}                -> {}
// Errors come back as {"id":n,"error":{"code":"timeout"|"codex"|"unavailable"|"bad-request","message":"..."}}.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { CodexClient, LEAN_ARGS } from "./lib/app-server.mjs";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const START_TIMEOUT_MS = 20_000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      options[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

function log(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

function rpcError(code, message) {
  const error = new Error(message);
  error.rpcCode = code;
  return error;
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(rpcError("timeout", `超过 ${Math.round(ms / 1000)} 秒没有完成`));
      }, ms);
    })
  ]).finally(() => clearTimeout(timer));
}

const [subcommand, ...rest] = process.argv.slice(2);
if (subcommand !== "serve") {
  process.stderr.write("用法：node broker.mjs serve --socket <path> [--idle-ms <ms>]\n");
  process.exit(2);
}
const options = parseArgs(rest);
const socketPath = options.socket;
if (!socketPath) {
  process.stderr.write("缺少 --socket\n");
  process.exit(2);
}
const workDir = path.dirname(socketPath);
const idleMs = Number(options["idle-ms"] || process.env.RENHUA_IDLE_MS || DEFAULT_IDLE_MS);

const health = { ok: false, reason: "starting", detail: null, lean: true, models: [], pid: process.pid, startedAt: new Date().toISOString() };
const runs = new Map();
let codex = null;
let server = null;
let lastActivity = Date.now();
let shuttingDown = false;

async function connectCodex(extraArgs) {
  const client = new CodexClient();
  try {
    await withTimeout(client.start({ cwd: workDir, extraArgs, env: process.env }), START_TIMEOUT_MS);
    return client;
  } catch (error) {
    client.proc?.kill("SIGKILL");
    throw error;
  }
}

function markUnavailable(reason, detail) {
  health.ok = false;
  health.reason = reason;
  health.detail = detail ?? null;
  log(`unavailable: ${reason} ${detail ?? ""}`);
}

async function startCodex() {
  try {
    codex = await connectCodex(LEAN_ARGS);
  } catch (error) {
    log(`lean start failed (${error.message}); retrying without lean flags`);
    try {
      codex = await connectCodex([]);
      health.lean = false;
    } catch (retryError) {
      const missing = retryError.code === "ENOENT" || error.code === "ENOENT";
      markUnavailable(missing ? "codex-missing" : "codex-failed", retryError.stderr || retryError.message);
      return;
    }
  }

  codex.setNotificationHandler(handleNotification);
  codex.setExitHandler((error) => {
    markUnavailable("codex-exited", error?.stderr || error?.message);
    for (const run of runs.values()) {
      run.reject(rpcError("codex", "Codex 进程意外退出"));
    }
    shutdown("codex exited");
  });

  try {
    const account = await codex.request("account/read", { refreshToken: false });
    if (!account.account && account.requiresOpenaiAuth !== false) {
      markUnavailable("not-logged-in", "Codex 没有登录");
      return;
    }
  } catch (error) {
    markUnavailable("codex-failed", error.message);
    return;
  }

  try {
    const list = await codex.request("model/list", {});
    health.models = (list.data ?? []).map((model) => model.id);
  } catch {
    health.models = [];
  }

  health.ok = true;
  health.reason = null;
  log(`ready (lean=${health.lean}, models=${health.models.join(",")})`);
}

function handleNotification(message) {
  const params = message.params ?? {};
  const run = runs.get(params.threadId);
  if (!run) {
    return;
  }
  switch (message.method) {
    case "item/completed":
      if (params.item?.type === "agentMessage" && params.item.text) {
        run.text = params.item.text;
        if (params.item.phase === "final_answer") {
          run.finalText = params.item.text;
        }
      }
      break;
    case "error":
      if (!params.willRetry) {
        run.error = params.error?.message ?? "Codex 出错";
      }
      break;
    case "turn/completed":
      run.complete(params.turn ?? {});
      break;
    default:
      break;
  }
}

function resolveModel(requested) {
  if (!requested) {
    return null;
  }
  return health.models.length === 0 || health.models.includes(requested) ? requested : null;
}

async function runTranslation(params) {
  if (typeof params?.input !== "string" || typeof params?.instructions !== "string") {
    throw rpcError("bad-request", "run 需要 instructions 和 input");
  }
  await ready;
  if (!health.ok) {
    throw rpcError("unavailable", health.reason);
  }

  const startedAt = Date.now();
  const model = resolveModel(params.model);
  const run = { text: "", finalText: null, error: null, threadId: null, turnId: null, abandoned: false };
  run.done = new Promise((resolve, reject) => {
    run.complete = resolve;
    run.reject = reject;
  });

  const work = (async () => {
    const thread = await codex.request("thread/start", {
      cwd: workDir,
      model,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      serviceName: "renhua",
      serviceTier: params.fast ? "priority" : null,
      developerInstructions: params.instructions
    });
    if (run.abandoned) {
      // Timed out while the thread was being created; nobody is waiting for it any more.
      codex.request("thread/unsubscribe", { threadId: thread.thread.id }).catch(() => {});
      return run.done;
    }
    run.threadId = thread.thread.id;
    runs.set(run.threadId, run);

    const turn = await codex.request("turn/start", {
      threadId: run.threadId,
      input: [{ type: "text", text: params.input, text_elements: [] }],
      model,
      effort: params.effort ?? "low",
      outputSchema: params.outputSchema ?? null
    });
    run.turnId = turn.turn?.id ?? null;
    if (run.abandoned && run.turnId) {
      codex.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
    }
    if (turn.turn?.status && turn.turn.status !== "inProgress") {
      run.complete(turn.turn);
    }
    return run.done;
  })();

  try {
    const finalTurn = await withTimeout(work, Number(params.timeoutMs) || DEFAULT_RUN_TIMEOUT_MS, () => {
      if (run.threadId && run.turnId) {
        codex.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
      }
    });
    if (finalTurn.status === "completed") {
      return { text: run.finalText ?? run.text, ms: Date.now() - startedAt };
    }
    if (finalTurn.status === "interrupted") {
      throw rpcError("timeout", "Codex 被中断");
    }
    throw rpcError("codex", finalTurn.error?.message ?? run.error ?? `Codex 本轮状态：${finalTurn.status}`);
  } finally {
    run.abandoned = true;
    if (run.threadId) {
      runs.delete(run.threadId);
      codex.request("thread/unsubscribe", { threadId: run.threadId }).catch(() => {});
    }
  }
}

function send(socket, message) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

async function handleRequest(socket, message) {
  lastActivity = Date.now();
  try {
    if (message.method === "ping") {
      // Answer right away, even while Codex is still starting, so callers can tell "busy" from "stuck".
      send(socket, { id: message.id, result: { ...health } });
    } else if (message.method === "run") {
      const result = await runTranslation(message.params);
      send(socket, { id: message.id, result });
    } else if (message.method === "shutdown") {
      send(socket, { id: message.id, result: {} });
      shutdown("requested");
    } else {
      send(socket, { id: message.id, error: { code: "bad-request", message: `未知方法 ${message.method}` } });
    }
  } catch (error) {
    send(socket, { id: message.id, error: { code: error.rpcCode ?? "codex", message: error.message } });
  } finally {
    lastActivity = Date.now();
  }
}

function shutdown(reason) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log(`shutting down: ${reason}`);
  codex?.close();
  server?.close();
  fs.rmSync(socketPath, { force: true });
  setTimeout(() => process.exit(0), 300).unref();
}

const ready = startCodex();

fs.rmSync(socketPath, { force: true });
server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send(socket, { id: null, error: { code: "bad-request", message: "不是合法的 JSON" } });
        continue;
      }
      handleRequest(socket, message);
    }
  });
  socket.on("error", () => {});
});
server.listen(socketPath, () => log(`listening on ${socketPath}`));

// A broker whose Codex is unusable has nothing to offer, so it does not wait the full idle time.
const UNHEALTHY_IDLE_MS = 60_000;
setInterval(() => {
  const limit = health.ok || health.reason === "starting" ? idleMs : Math.min(idleMs, UNHEALTHY_IDLE_MS);
  if (runs.size === 0 && Date.now() - lastActivity > limit) {
    shutdown("idle");
  }
}, Math.min(idleMs, 30_000)).unref();

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
