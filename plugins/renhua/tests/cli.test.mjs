import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { stopBroker } from "../scripts/lib/broker-client.mjs";

const CLI = new URL("../scripts/cli.mjs", import.meta.url).pathname;
const FAKE_CODEX = new URL("./fake-codex.mjs", import.meta.url).pathname;
fs.chmodSync(FAKE_CODEX, 0o755);

function setup(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renhua-cli-test-"));
  const sessionId = `cli-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const baseEnv = { ...process.env, RENHUA_DATA_DIR: dir, RENHUA_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: "ok", ...env };
  delete baseEnv.CLAUDE_PLUGIN_DATA;
  delete baseEnv.RENHUA_SESSION_ID;
  const cli = (command, extraEnv = {}, args = []) => {
    const result = spawnSync(process.execPath, [CLI, command, ...args], { env: { ...baseEnv, ...extraEnv }, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const config = () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  t.after(async () => {
    process.env.RENHUA_DATA_DIR = dir;
    await stopBroker(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { cli, config, dir, sessionId };
}

test("status works before anything has happened", (t) => {
  const { cli } = setup(t);
  const output = cli("status");
  assert.match(output, /开关：开启/);
  assert.match(output, /模型：gpt-5.6-luna（思考强度 low，标准档）/);
  assert.match(output, /还没有记录/);
});

test("off and on flip the switch", (t) => {
  const { cli, config } = setup(t);
  assert.match(cli("off"), /renhua 已关闭/);
  assert.equal(config().enabled, false);
  assert.match(cli("status"), /开关：关闭（你手动关的）/);
  assert.match(cli("on"), /renhua 已开启/);
  assert.equal(config().enabled, true);
  assert.equal(config().pausedReason, null);
});

test("on clears an automatic pause and the per-session 'unavailable' mark, then checks Codex", (t) => {
  const { cli, config, dir, sessionId } = setup(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ enabled: false, pausedReason: "failures", consecutiveFailures: 2 }));
  fs.mkdirSync(path.join(dir, "sessions"));
  fs.writeFileSync(path.join(dir, "sessions", `${sessionId}.json`), JSON.stringify({ unavailable: "not-logged-in" }));
  const output = cli("on", { RENHUA_SESSION_ID: sessionId });
  assert.match(output, /Codex 检查正常/);
  assert.equal(config().consecutiveFailures, 0);
  const session = JSON.parse(fs.readFileSync(path.join(dir, "sessions", `${sessionId}.json`), "utf8"));
  assert.equal(session.unavailable, null);
  assert.match(cli("status", { RENHUA_SESSION_ID: sessionId }), /当前会话的常驻 Codex：运行中/);
});

test("on reports a Codex that still cannot be used", (t) => {
  const { cli, sessionId } = setup(t, { FAKE_CODEX_MODE: "logged-out" });
  assert.match(cli("on", { RENHUA_SESSION_ID: sessionId }), /但是 Codex 还不能用：Codex 没有登录/);
});

test("status lists recent translations with timings and the last error", (t) => {
  const { cli, dir } = setup(t);
  const lines = [
    { ts: "2026-09-18T01:00:00.000Z", kind: "input", ok: true, ms: 5400 },
    { ts: "2026-09-18T01:01:00.000Z", kind: "output", ok: true, ms: 6000 },
    { ts: "2026-09-18T01:02:00.000Z", kind: "output", ok: false, ms: 30000, error: "timeout", detail: "超过 30 秒没有完成" }
  ];
  fs.writeFileSync(path.join(dir, "log.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const output = cli("status");
  assert.match(output, /你的话 {2}5.4 秒 {2}成功/);
  assert.match(output, /人话版 {2}30.0 秒 {2}失败：超时/);
  assert.match(output, /平均耗时：你的话 5.4 秒，人话版 6.0 秒/);
  assert.match(output, /最近一次错误详情：超过 30 秒没有完成/);
});

test("model without an argument shows the current model and every model the account can use", (t) => {
  const { cli } = setup(t);
  const output = cli("model");
  assert.match(output, /当前：gpt-5.6-luna（思考强度 low）/);
  assert.match(output, /● gpt-5.6-luna {2}可选思考强度：low \/ medium \/ high \/ xhigh \/ max/);
  assert.match(output, /  gpt-5.5 {2}可选思考强度：low \/ medium \/ high \/ xhigh/);
  assert.match(output, /\/renhua:model 模型名/);
});

test("model switches to a model the account has", (t) => {
  const { cli, config } = setup(t);
  const output = cli("model", {}, ["gpt-5.5"]);
  assert.match(output, /已换成 gpt-5.5（思考强度 low）/);
  assert.equal(config().model, "gpt-5.5");
  assert.equal(config().effort, "low");
});

test("model refuses a name Codex does not know and leaves the setting alone", (t) => {
  const { cli, dir } = setup(t);
  const output = cli("model", {}, ["gpt-9000"]);
  assert.match(output, /没有叫「gpt-9000」的模型/);
  assert.match(output, /gpt-5.6-luna、gpt-5.5/);
  assert.match(output, /设置没改/);
  assert.ok(!fs.existsSync(path.join(dir, "config.json")));
});

test("switching to a model without the current effort falls back to low and says so", (t) => {
  const { cli, config, dir } = setup(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ effort: "max" }));
  const output = cli("model", {}, ["gpt-5.5"]);
  assert.match(output, /gpt-5.5 不支持思考强度 max，已改成 low/);
  assert.equal(config().model, "gpt-5.5");
  assert.equal(config().effort, "low");
});

test("effort without an argument shows the current level and the levels of the current model", (t) => {
  const { cli } = setup(t);
  const output = cli("effort");
  assert.match(output, /当前：low（模型 gpt-5.6-luna）/);
  assert.match(output, /可选：low \/ medium \/ high \/ xhigh \/ max/);
  assert.match(output, /\/renhua:effort 档位/);
});

test("effort switches to a supported level; high levels come with a timeout warning", (t) => {
  const { cli, config } = setup(t);
  const medium = cli("effort", {}, ["medium"]);
  assert.match(medium, /思考强度已改成 medium（模型 gpt-5.6-luna）/);
  assert.doesNotMatch(medium, /等待上限/);
  assert.equal(config().effort, "medium");

  const high = cli("effort", {}, ["high"]);
  assert.match(high, /等待上限/);
  assert.equal(config().effort, "high");
});

test("effort refuses a level the current model does not have", (t) => {
  const { cli, dir } = setup(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "gpt-5.5" }));
  const output = cli("effort", {}, ["max"]);
  assert.match(output, /gpt-5.5 没有「max」这个档位，可选的是：low \/ medium \/ high \/ xhigh/);
  assert.match(output, /设置没改/);
});

test("nothing is changed when Codex cannot be reached to check", (t) => {
  const { cli, dir } = setup(t, { RENHUA_CODEX_BIN: "/nonexistent/codex" });
  assert.match(cli("model", {}, ["gpt-5.5"]), /Codex 现在连不上.*设置没改/s);
  assert.match(cli("effort", {}, ["medium"]), /Codex 现在连不上.*设置没改/s);
  assert.ok(!fs.existsSync(path.join(dir, "config.json")));
});
