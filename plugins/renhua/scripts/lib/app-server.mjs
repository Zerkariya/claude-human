// Minimal JSON-RPC client for `codex app-server` over stdio.
// Adapted from openai/codex-plugin-cc (scripts/lib/app-server.mjs). This file stays under the
// Apache License 2.0 (see LICENSE-APACHE and NOTICE); the rest of renhua is MIT.

import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";

const CLIENT_INFO = { title: "renhua", name: "renhua", version: "0.1.0" };
const CAPABILITIES = {
  experimentalApi: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

// Features and settings that make no sense for a pure translator. Your own notify hook, plugins
// and MCP servers stay untouched in ~/.codex; they are only switched off for this process.
export const LEAN_ARGS = [
  "--disable", "plugins",
  "--disable", "remote_plugin",
  "--disable", "multi_agent",
  "--disable", "goals",
  "--disable", "hooks",
  "--disable", "computer_use",
  "--disable", "browser_use",
  "--disable", "browser_use_external",
  "--disable", "in_app_browser",
  "--disable", "image_generation",
  "--disable", "skill_search",
  "--disable", "apps",
  "-c", "mcp_servers={}",
  "-c", "notify=[]",
  "-c", 'web_search="disabled"'
];

export function codexBinary() {
  return process.env.RENHUA_CODEX_BIN || "codex";
}

function protocolError(message, data) {
  const error = new Error(message);
  error.data = data;
  return error;
}

export class CodexClient {
  /** Spawns `codex app-server`, performs the initialize handshake and returns a ready client. */
  static async connect({ cwd, extraArgs = [], env = process.env } = {}) {
    const client = new CodexClient();
    await client.start({ cwd, extraArgs, env });
    return client;
  }

  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exited = false;
    this.notificationHandler = null;
    this.exitHandler = null;
  }

  async start({ cwd, extraArgs, env }) {
    this.proc = spawn(codexBinary(), ["app-server", ...extraArgs], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    this.proc.on("error", (error) => this.handleExit(error));
    this.proc.on("exit", (code, signal) => {
      this.handleExit(code === 0 ? null : protocolError(`codex app-server 意外退出（${signal ?? `exit ${code}`}）`));
    });
    this.proc.stdin.on("error", () => {});
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this.handleLine(line));

    await this.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES });
    this.notify("initialized", {});
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setExitHandler(handler) {
    this.exitHandler = handler;
  }

  request(method, params) {
    if (this.closed || this.exited) {
      return Promise.reject(new Error("codex app-server 已关闭"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (!this.closed && !this.exited) {
      this.send({ method, params });
    }
  }

  send(message) {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && message.method) {
      // We never grant approvals or answer server-side prompts: the translator must not act.
      this.send({ id: message.id, error: { code: -32601, message: `renhua 不支持 ${message.method}` } });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(protocolError(message.error.message ?? `${pending.method} 失败`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      this.notificationHandler?.(message);
    }
  }

  handleExit(error) {
    if (this.exited) {
      return;
    }
    this.exited = true;
    const reason = error ?? new Error("codex app-server 已关闭");
    if (this.stderr.trim() && reason.message) {
      reason.stderr = this.stderr.trim();
    }
    for (const pending of this.pending.values()) {
      pending.reject(reason);
    }
    this.pending.clear();
    this.exitHandler?.(reason);
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.proc?.stdin.end();
    const proc = this.proc;
    setTimeout(() => {
      if (proc && proc.exitCode === null && !proc.killed) {
        proc.kill("SIGTERM");
      }
    }, 200).unref();
  }
}
