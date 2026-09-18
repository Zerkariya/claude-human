#!/usr/bin/env node
// Entry point for all renhua hooks. Never blocks Claude: every failure becomes at most a one-line notice.

import fs from "node:fs";
import process from "node:process";

import { call, ensureBroker, stopBroker } from "./lib/broker-client.mjs";
import { shouldSkipInput, shouldSkipOutput } from "./lib/skip.mjs";
import {
  appendLog,
  isQuotaError,
  loadConfig,
  loadSession,
  pruneSessions,
  recordFailure,
  recordSuccess,
  removeSession,
  saveSession
} from "./lib/state.mjs";
import { conversationTail, readTranscript, turnActions } from "./lib/transcript.mjs";
import {
  buildInputRequest,
  buildOutputRequest,
  formatInputForClaude,
  formatInputForUser,
  formatOutputForUser,
  parseResult
} from "./lib/translate.mjs";

const SESSION_START_WAIT_MS = 2500;
const BROKER_WAIT_MS = 3000;
const STALE_SESSION_MS = 2 * 24 * 60 * 60 * 1000;

const UNAVAILABLE_MESSAGES = {
  "not-logged-in": "renhua：Codex 没有登录，本次会话不翻译。在终端运行 codex login 后，敲 /renhua:on",
  "codex-missing": "renhua：没找到 codex 命令，本次会话不翻译。装好 Codex CLI 后敲 /renhua:on",
  "codex-failed": "renhua：Codex 启动失败，本次会话不翻译。/renhua:status 看详情，/renhua:on 重试"
};

const PAUSED_REASONS = {
  quota: "Codex 额度用完",
  failures: "连续失败 3 次"
};

// "这句没翻译" for the user's prompt, "这次没有人话版" for Claude's reply.
const MISSED = { input: "这句没翻译", output: "这次没有人话版" };

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

function emit(payload) {
  if (payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function isActive(sessionId) {
  return loadConfig().enabled && !loadSession(sessionId).unavailable;
}

function markUnavailable(sessionId, reason) {
  const key = UNAVAILABLE_MESSAGES[reason] ? reason : "codex-failed";
  saveSession(sessionId, { unavailable: key });
  return UNAVAILABLE_MESSAGES[key];
}

function failureMessage(kind, error) {
  if (isQuotaError(error.message)) {
    return "renhua：Codex 额度用完，已暂停翻译。额度恢复后敲 /renhua:on";
  }
  switch (error.code) {
    case "timeout":
    case "broker-timeout":
      return `⏱ renhua：Codex 超时，${MISSED[kind]}`;
    case "format":
      return `renhua：Codex 回复格式异常，${MISSED[kind]}`;
    case "broker-start":
      return `renhua：Codex 还没启动好，${MISSED[kind]}`;
    default: {
      const detail = String(error.message ?? "").replace(/\s+/g, " ").slice(0, 80);
      return `renhua：Codex 出错（${detail}），${MISSED[kind]}`;
    }
  }
}

/**
 * Runs one translation through the session's broker.
 * Returns { result } on success or { message } with the notice to show when something went wrong.
 */
async function translate(sessionId, kind, request) {
  const config = loadConfig();
  const timeoutMs = kind === "input" ? config.inputTimeoutMs : config.outputTimeoutMs;
  const started = Date.now();
  try {
    const { broker, health } = await ensureBroker(sessionId, { waitMs: BROKER_WAIT_MS });
    if (!health.ok) {
      return { message: markUnavailable(sessionId, health.reason) };
    }
    const answer = await call(
      broker.socket,
      "run",
      { ...request, model: config.model, effort: config.effort, fast: config.fast, timeoutMs },
      timeoutMs + 2000
    );
    const result = parseResult(kind, answer.text);
    recordSuccess();
    appendLog({ session: sessionId, kind, ok: true, ms: Date.now() - started, codexMs: answer.ms });
    return { result };
  } catch (error) {
    if (error.code === "unavailable") {
      return { message: markUnavailable(sessionId, error.message) };
    }
    appendLog({ session: sessionId, kind, ok: false, ms: Date.now() - started, error: error.code ?? "error", detail: error.message });
    const { paused } = recordFailure(error.message);
    const message = failureMessage(kind, error);
    if (paused === "failures") {
      return { message: `${message}\nrenhua：连续失败 3 次，已暂停翻译。/renhua:status 看原因，/renhua:on 恢复` };
    }
    return { message };
  }
}

async function onSessionStart(input) {
  const sessionId = input.session_id;
  if (process.env.CLAUDE_ENV_FILE && sessionId) {
    fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export RENHUA_SESSION_ID=${shellQuote(sessionId)}\n`, "utf8");
  }
  pruneSessions(STALE_SESSION_MS);

  const config = loadConfig();
  if (!config.enabled) {
    const reason = PAUSED_REASONS[config.pausedReason];
    return reason ? { systemMessage: `renhua 目前是暂停的（${reason}）。/renhua:on 恢复` } : null;
  }

  try {
    const { health } = await ensureBroker(sessionId, { waitMs: SESSION_START_WAIT_MS });
    if (!health.ok) {
      return { systemMessage: markUnavailable(sessionId, health.reason) };
    }
    saveSession(sessionId, { unavailable: null });
  } catch {
    // Still starting: the first prompt will wait for it.
  }
  return null;
}

async function onPrompt(input) {
  const sessionId = input.session_id;
  const prompt = String(input.prompt ?? "");
  if (!isActive(sessionId) || shouldSkipInput(prompt)) {
    return null;
  }

  const tail = conversationTail(readTranscript(input.transcript_path), { userTurns: 3, maxChars: 600, currentPrompt: prompt });
  const outcome = await translate(sessionId, "input", buildInputRequest({ prompt, tail }));
  if (!outcome.result) {
    return { systemMessage: outcome.message };
  }
  return {
    // Only worth the user's attention when Codex found something to ask about.
    systemMessage: outcome.result.unclear.length ? formatInputForUser(outcome.result) : undefined,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: formatInputForClaude(outcome.result)
    }
  };
}

async function onStop(input) {
  const sessionId = input.session_id;
  if (!isActive(sessionId)) {
    return null;
  }

  const entries = readTranscript(input.transcript_path);
  const actions = turnActions(entries, { cwd: input.cwd, sinceUuid: loadSession(sessionId).lastTranslatedUuid });
  const reply =
    typeof input.last_assistant_message === "string"
      ? input.last_assistant_message
      : conversationTail(entries, { userTurns: 1, maxChars: 100_000 }).filter((u) => u.role === "assistant").at(-1)?.text ?? "";

  // Remember how far we got even when skipping, so the next stop does not repeat these actions.
  saveSession(sessionId, { lastTranslatedUuid: actions.lastUuid });
  if (shouldSkipOutput({ reply, actions })) {
    return null;
  }

  const outcome = await translate(sessionId, "output", buildOutputRequest({ reply, actions }));
  return { systemMessage: outcome.result ? formatOutputForUser(outcome.result) : outcome.message };
}

async function onSessionEnd(input) {
  await stopBroker(input.session_id);
  removeSession(input.session_id);
  return null;
}

const HANDLERS = {
  SessionStart: onSessionStart,
  UserPromptSubmit: onPrompt,
  Stop: onStop,
  SessionEnd: onSessionEnd
};

async function main() {
  const input = readInput();
  if (!input?.session_id) {
    return;
  }
  const handler = HANDLERS[process.argv[2] ?? input.hook_event_name];
  if (handler) {
    emit(await handler(input));
  }
}

main().catch((error) => {
  // A broken hook must never get in the user's way; leave a trace for /renhua:status instead.
  try {
    appendLog({ kind: "hook", ok: false, error: "crash", detail: String(error?.stack ?? error).slice(0, 500) });
  } catch {
    // Nothing else we can do.
  }
});
