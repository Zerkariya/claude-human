#!/usr/bin/env node
// Stand-in for `codex app-server` used by the tests. Behaviour is chosen with FAKE_CODEX_MODE:
//   ok (default) | hang | garbage | logged-out | crash | reject-flags | quota | die-on-turn | slow-start
// Every request is appended to FAKE_CODEX_LOG (one JSON line each) when that variable is set.

import fs from "node:fs";
import readline from "node:readline";

const mode = process.env.FAKE_CODEX_MODE || "ok";
const delayMs = Number(process.env.FAKE_DELAY_MS || 20);
const logFile = process.env.FAKE_CODEX_LOG;
const args = process.argv.slice(2);

function record(entry) {
  if (logFile) {
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  }
}

record({ argv: args });

if (mode === "crash") {
  process.stderr.write("fake codex: crashed on start\n");
  process.exit(1);
}
if (mode === "reject-flags" && args.includes("--disable")) {
  process.stderr.write("error: unknown feature\n");
  process.exit(2);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function defaultReply(schema) {
  const required = schema?.required ?? [];
  if (required.includes("intent")) {
    return JSON.stringify({ references: [], intent: "你想测试一下", unclear: [], for_claude: "请测试" });
  }
  if (required.includes("did")) {
    return JSON.stringify({ did: "做了测试", result: "成功", todo: "没有" });
  }
  return "hello";
}

let threads = 0;
let turns = 0;
const active = new Map();

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) {
    return;
  }
  record({ method, params });

  switch (method) {
    case "initialize":
      if (mode === "slow-start") {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_START_DELAY_MS || 800)));
      }
      send({ id, result: { userAgent: "fake-codex" } });
      return;
    case "account/read":
      send({ id, result: mode === "logged-out" ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
      return;
    case "model/list":
      send({
        id,
        result: {
          data: [
            {
              id: "gpt-5.6-luna",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort }))
            },
            {
              id: "gpt-5.5",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort }))
            }
          ],
          nextCursor: null
        }
      });
      return;
    case "thread/start":
      threads += 1;
      send({ id, result: { thread: { id: `th-${threads}` } } });
      return;
    case "thread/unsubscribe":
      send({ id, result: {} });
      return;
    case "turn/start": {
      turns += 1;
      const turnId = `tu-${turns}`;
      const threadId = params.threadId;
      send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      if (mode === "die-on-turn") {
        setTimeout(() => process.exit(3), delayMs);
        return;
      }
      if (mode === "hang") {
        active.set(turnId, threadId);
        return;
      }
      setTimeout(() => {
        if (mode === "quota") {
          send({ method: "error", params: { threadId, turnId, willRetry: false, error: { message: "You've hit your usage limit." } } });
          send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: { message: "You've hit your usage limit." } } } });
          return;
        }
        const text = process.env.FAKE_REPLY ?? (mode === "garbage" ? "我觉得用户想测试" : defaultReply(params.outputSchema));
        send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "m1", text, phase: "final_answer" } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } });
      }, delayMs);
      return;
    }
    case "turn/interrupt": {
      send({ id, result: {} });
      const threadId = active.get(params.turnId);
      if (threadId) {
        active.delete(params.turnId);
        send({ method: "turn/completed", params: { threadId, turn: { id: params.turnId, status: "interrupted", error: null } } });
      }
      return;
    }
    default:
      send({ id, error: { code: -32601, message: `fake codex: unknown method ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) {
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
