// Config, per-session state, the translation log and the failure policy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG = {
  enabled: true,
  pausedReason: null,
  model: "gpt-5.6-luna",
  effort: "low",
  fast: false,
  inputTimeoutMs: 15_000,
  outputTimeoutMs: 30_000,
  consecutiveFailures: 0
};

const MAX_FAILURES = 3;
const MAX_LOG_BYTES = 512 * 1024;
const KEEP_LOG_LINES = 200;
const QUOTA_PATTERN = /usage limit|rate limit|quota|\b429\b|too many requests/i;

// Deliberately not $CLAUDE_PLUGIN_DATA: other plugins export their own value of that variable into
// every Bash command of the session, so the slash commands would read a different directory than
// the hooks write to.
export function dataDir() {
  return process.env.RENHUA_DATA_DIR || path.join(os.homedir(), ".claude", "renhua");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function configFile() {
  return path.join(dataDir(), "config.json");
}

export function loadConfig() {
  const saved = readJson(configFile(), {});
  return { ...DEFAULT_CONFIG, ...(saved && typeof saved === "object" ? saved : {}) };
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  writeJson(configFile(), next);
  return next;
}

function sessionFile(sessionId) {
  const safe = String(sessionId ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(dataDir(), "sessions", `${safe}.json`);
}

export function loadSession(sessionId) {
  return readJson(sessionFile(sessionId), {});
}

export function saveSession(sessionId, patch) {
  const next = { ...loadSession(sessionId), ...patch };
  writeJson(sessionFile(sessionId), next);
  return next;
}

export function removeSession(sessionId) {
  fs.rmSync(sessionFile(sessionId), { force: true });
}

export function listSessions() {
  const dir = path.join(dataDir(), "sessions");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // Removed meanwhile.
    }
    return { id: name.slice(0, -".json".length), mtimeMs, state: readJson(file, {}) };
  });
}

/** Forgets sessions that ended without a SessionEnd hook (crash, killed terminal). */
export function pruneSessions(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  for (const session of listSessions()) {
    if (session.mtimeMs && session.mtimeMs < cutoff) {
      removeSession(session.id);
    }
  }
}

function logFile() {
  return path.join(dataDir(), "log.jsonl");
}

export function appendLog(entry) {
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-KEEP_LOG_LINES);
      fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    }
  } catch {
    // Trimming the log is best effort.
  }
}

export function readLog(limit = 10) {
  let text = "";
  try {
    text = fs.readFileSync(logFile(), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.trim().split("\n").slice(-limit)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip damaged lines.
    }
  }
  return entries;
}

export function isQuotaError(message) {
  return QUOTA_PATTERN.test(String(message ?? ""));
}

export function recordSuccess() {
  if (loadConfig().consecutiveFailures !== 0) {
    saveConfig({ consecutiveFailures: 0 });
  }
}

/** @returns {{ paused: "quota" | "failures" | null }} */
export function recordFailure(message) {
  const config = loadConfig();
  if (isQuotaError(message)) {
    saveConfig({ enabled: false, pausedReason: "quota", consecutiveFailures: 0 });
    return { paused: "quota" };
  }
  const failures = config.consecutiveFailures + 1;
  if (failures >= MAX_FAILURES) {
    saveConfig({ enabled: false, pausedReason: "failures", consecutiveFailures: 0 });
    return { paused: "failures" };
  }
  saveConfig({ consecutiveFailures: failures });
  return { paused: null };
}
