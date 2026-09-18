import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { call, ensureBroker, stopBroker } from "../scripts/lib/broker-client.mjs";
import { loadSession, saveSession } from "../scripts/lib/state.mjs";

const FAKE_CODEX = new URL("./fake-codex.mjs", import.meta.url).pathname;
fs.chmodSync(FAKE_CODEX, 0o755);

let counter = 0;

function setup(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renhua-broker-test-"));
  const logFile = path.join(dir, "fake.log");
  const saved = { ...process.env };
  Object.assign(process.env, {
    RENHUA_DATA_DIR: dir,
    RENHUA_CODEX_BIN: FAKE_CODEX,
    FAKE_CODEX_LOG: logFile,
    FAKE_CODEX_MODE: "ok",
    ...env
  });
  counter += 1;
  const sessionId = `test-${process.pid}-${counter}`;
  t.after(async () => {
    await stopBroker(sessionId);
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { sessionId, requests: () => readRequests(logFile) };
}

function readRequests(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const runParams = {
  instructions: "你是翻译官",
  input: "用户这句话：测试",
  outputSchema: { type: "object", required: ["intent", "unclear", "for_claude"] },
  model: "gpt-5.6-luna",
  effort: "low",
  timeoutMs: 5000
};

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a healthy broker runs a translation in a lean, read-only, throwaway Codex thread", async (t) => {
  const { sessionId, requests } = setup(t);
  const { broker, health } = await ensureBroker(sessionId);
  assert.equal(health.ok, true);
  assert.equal(health.lean, true);
  assert.deepEqual(health.models, ["gpt-5.6-luna", "gpt-5.5"]);

  const result = await call(broker.socket, "run", runParams, 5000);
  assert.deepEqual(JSON.parse(result.text), { references: [], intent: "你想测试一下", unclear: [], for_claude: "请测试" });
  assert.equal(typeof result.ms, "number");

  const log = requests();
  assert.ok(log[0].argv.includes("--disable"));
  assert.ok(log[0].argv.includes("notify=[]"));
  const threadStart = log.find((entry) => entry.method === "thread/start").params;
  assert.equal(threadStart.sandbox, "read-only");
  assert.equal(threadStart.approvalPolicy, "never");
  assert.equal(threadStart.ephemeral, true);
  assert.equal(threadStart.model, "gpt-5.6-luna");
  assert.equal(threadStart.developerInstructions, "你是翻译官");
  assert.equal(threadStart.serviceTier, null);
  assert.notEqual(threadStart.cwd, process.cwd());
  const turnStart = log.find((entry) => entry.method === "turn/start").params;
  assert.equal(turnStart.effort, "low");
  assert.deepEqual(turnStart.outputSchema, runParams.outputSchema);
  assert.ok(await waitUntil(() => requests().some((entry) => entry.method === "thread/unsubscribe")));
});

test("fast mode asks for the priority tier and unknown models fall back to Codex's default", async (t) => {
  const { sessionId, requests } = setup(t);
  const { broker } = await ensureBroker(sessionId);
  await call(broker.socket, "run", { ...runParams, model: "no-such-model", fast: true }, 5000);
  const threadStart = requests().find((entry) => entry.method === "thread/start").params;
  assert.equal(threadStart.model, null);
  assert.equal(threadStart.serviceTier, "priority");
});

test("the same broker is reused while it is alive", async (t) => {
  const { sessionId } = setup(t);
  const first = await ensureBroker(sessionId);
  const second = await ensureBroker(sessionId);
  assert.equal(first.broker.pid, second.broker.pid);
});

test("a run that takes too long times out and Codex is told to stop", async (t) => {
  const { sessionId, requests } = setup(t, { FAKE_CODEX_MODE: "hang" });
  const { broker } = await ensureBroker(sessionId);
  await assert.rejects(call(broker.socket, "run", { ...runParams, timeoutMs: 300 }, 5000), { code: "timeout" });
  assert.ok(await waitUntil(() => requests().some((entry) => entry.method === "turn/interrupt")));
  // The broker is still usable afterwards.
  const health = await call(broker.socket, "ping", {}, 1000);
  assert.equal(health.ok, true);
});

test("a logged-out Codex is reported and refuses work", async (t) => {
  const { sessionId } = setup(t, { FAKE_CODEX_MODE: "logged-out" });
  const { broker, health } = await ensureBroker(sessionId);
  assert.equal(health.ok, false);
  assert.equal(health.reason, "not-logged-in");
  await assert.rejects(call(broker.socket, "run", runParams, 5000), { code: "unavailable" });
});

test("a missing codex binary is reported as codex-missing", async (t) => {
  const { sessionId } = setup(t, { RENHUA_CODEX_BIN: "/nonexistent/codex" });
  const { health } = await ensureBroker(sessionId);
  assert.equal(health.ok, false);
  assert.equal(health.reason, "codex-missing");
});

test("a codex that crashes on start is reported as codex-failed", async (t) => {
  const { sessionId } = setup(t, { FAKE_CODEX_MODE: "crash" });
  const { health } = await ensureBroker(sessionId);
  assert.equal(health.ok, false);
  assert.equal(health.reason, "codex-failed");
});

test("if the lean flags are rejected the broker retries without them", async (t) => {
  const { sessionId } = setup(t, { FAKE_CODEX_MODE: "reject-flags" });
  const { health } = await ensureBroker(sessionId);
  assert.equal(health.ok, true);
  assert.equal(health.lean, false);
});

test("quota errors come back with Codex's own message", async (t) => {
  const { sessionId } = setup(t, { FAKE_CODEX_MODE: "quota" });
  const { broker } = await ensureBroker(sessionId);
  await assert.rejects(call(broker.socket, "run", runParams, 5000), (error) => {
    assert.equal(error.code, "codex");
    assert.match(error.message, /usage limit/);
    return true;
  });
});

test("when Codex dies mid-run the broker exits and the next ensure starts a new one", async (t) => {
  const { sessionId } = setup(t, { FAKE_CODEX_MODE: "die-on-turn" });
  const { broker } = await ensureBroker(sessionId);
  await assert.rejects(call(broker.socket, "run", runParams, 5000), { code: "codex" });
  assert.ok(await waitUntil(() => !isAlive(broker.pid)));

  process.env.FAKE_CODEX_MODE = "ok";
  const next = await ensureBroker(sessionId);
  assert.notEqual(next.broker.pid, broker.pid);
  assert.equal(next.health.ok, true);
});

test("a broker recorded for the session that no longer answers is replaced", async (t) => {
  const { sessionId } = setup(t);
  saveSession(sessionId, { broker: { socket: "/tmp/renhua-nothing-here.sock", pid: 999999, dir: null } });
  const { broker, health } = await ensureBroker(sessionId);
  assert.equal(health.ok, true);
  assert.notEqual(broker.pid, 999999);
});

test("a broker that is still starting is waited for, not killed", async (t) => {
  const { sessionId } = setup(t, { FAKE_CODEX_MODE: "slow-start", FAKE_START_DELAY_MS: "800" });
  await assert.rejects(ensureBroker(sessionId, { waitMs: 200 }), { code: "broker-start" });
  const pid = loadSession(sessionId).broker.pid;
  const { broker, health } = await ensureBroker(sessionId, { waitMs: 3000 });
  assert.equal(broker.pid, pid);
  assert.equal(health.ok, true);
});

test("an idle broker exits on its own", async (t) => {
  const { sessionId } = setup(t, { RENHUA_IDLE_MS: "300" });
  const { broker } = await ensureBroker(sessionId);
  assert.ok(await waitUntil(() => !isAlive(broker.pid), 5000));
  assert.ok(!fs.existsSync(broker.socket));
});

test("stopBroker shuts the broker down and forgets it", async (t) => {
  const { sessionId } = setup(t);
  const { broker } = await ensureBroker(sessionId);
  await stopBroker(sessionId);
  assert.ok(await waitUntil(() => !isAlive(broker.pid)));
  assert.equal(loadSession(sessionId).broker, null);
  assert.ok(!fs.existsSync(broker.dir));
});
