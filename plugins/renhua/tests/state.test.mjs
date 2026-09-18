import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendLog,
  isQuotaError,
  loadConfig,
  loadSession,
  readLog,
  recordFailure,
  recordSuccess,
  removeSession,
  saveConfig,
  saveSession
} from "../scripts/lib/state.mjs";

const dirs = [];
test.after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renhua-state-"));
  dirs.push(dir);
  process.env.RENHUA_DATA_DIR = dir;
  return dir;
}

test("config has defaults and merges saved changes", () => {
  freshDataDir();
  const config = loadConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.model, "gpt-5.6-luna");
  assert.equal(config.effort, "low");
  saveConfig({ enabled: false, pausedReason: "manual" });
  assert.equal(loadConfig().enabled, false);
  assert.equal(loadConfig().model, "gpt-5.6-luna");
});

test("a corrupted config falls back to defaults", () => {
  const dir = freshDataDir();
  fs.writeFileSync(path.join(dir, "config.json"), "{not json");
  assert.equal(loadConfig().enabled, true);
});

test("session state is stored per session id and can be removed", () => {
  freshDataDir();
  assert.deepEqual(loadSession("abc"), {});
  saveSession("abc", { lastTranslatedUuid: "u1" });
  saveSession("abc", { unavailable: "not logged in" });
  assert.deepEqual(loadSession("abc"), { lastTranslatedUuid: "u1", unavailable: "not logged in" });
  assert.deepEqual(loadSession("other"), {});
  removeSession("abc");
  assert.deepEqual(loadSession("abc"), {});
});

test("session ids cannot escape the sessions directory", () => {
  const dir = freshDataDir();
  saveSession("../../evil", { x: 1 });
  assert.ok(!fs.existsSync(path.join(dir, "..", "evil.json")));
  assert.deepEqual(loadSession("../../evil"), { x: 1 });
});

test("log keeps the newest entries", () => {
  freshDataDir();
  for (let i = 0; i < 5; i += 1) {
    appendLog({ kind: "input", ms: i });
  }
  const entries = readLog(3);
  assert.deepEqual(entries.map((entry) => entry.ms), [2, 3, 4]);
  assert.ok(entries[0].ts);
});

test("three failures in a row pause translation, a success resets the count", () => {
  freshDataDir();
  assert.equal(recordFailure("timeout").paused, null);
  assert.equal(recordFailure("timeout").paused, null);
  recordSuccess();
  assert.equal(recordFailure("timeout").paused, null);
  assert.equal(recordFailure("timeout").paused, null);
  const third = recordFailure("timeout");
  assert.equal(third.paused, "failures");
  assert.equal(loadConfig().enabled, false);
  assert.equal(loadConfig().pausedReason, "failures");
});

test("quota errors pause translation immediately", () => {
  freshDataDir();
  assert.equal(recordFailure("You've hit your usage limit. Try again later.").paused, "quota");
  assert.equal(loadConfig().enabled, false);
});

test("isQuotaError recognises common quota messages", () => {
  assert.ok(isQuotaError("Rate limit reached for requests"));
  assert.ok(isQuotaError("HTTP 429 Too Many Requests"));
  assert.ok(isQuotaError("insufficient_quota"));
  assert.ok(!isQuotaError("turn timed out"));
});
