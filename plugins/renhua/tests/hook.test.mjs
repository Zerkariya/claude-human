import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { stopBroker } from "../scripts/lib/broker-client.mjs";

const HOOK = new URL("../scripts/hook.mjs", import.meta.url).pathname;
const FAKE_CODEX = new URL("./fake-codex.mjs", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/session.jsonl", import.meta.url).pathname;
fs.chmodSync(FAKE_CODEX, 0o755);

let counter = 0;

function setup(t, { env = {}, config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renhua-hook-test-"));
  if (config) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  }
  counter += 1;
  const sessionId = `hook-${process.pid}-${counter}`;
  const fakeLog = path.join(dir, "fake.log");
  const baseEnv = {
    ...process.env,
    RENHUA_DATA_DIR: dir,
    RENHUA_CODEX_BIN: FAKE_CODEX,
    FAKE_CODEX_LOG: fakeLog,
    FAKE_CODEX_MODE: "ok",
    ...env
  };
  delete baseEnv.CLAUDE_PLUGIN_DATA;

  const run = (event, input, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [HOOK, event], {
      input: typeof input === "string" ? input : JSON.stringify({ session_id: sessionId, cwd: "/proj", ...input }),
      env: { ...baseEnv, ...extraEnv },
      encoding: "utf8",
      timeout: 20_000
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };

  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const session = () => {
    try {
      return readJson(path.join("sessions", `${sessionId}.json`));
    } catch {
      return {};
    }
  };
  const log = () =>
    fs.existsSync(path.join(dir, "log.jsonl"))
      ? fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
  const fakeRequests = () =>
    fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];

  t.after(async () => {
    process.env.RENHUA_DATA_DIR = dir;
    await stopBroker(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { run, sessionId, dir, session, config: () => readJson("config.json"), log, fakeRequests };
}

const prompt = (text) => ({ hook_event_name: "UserPromptSubmit", prompt: text, transcript_path: FIXTURE });

test("a clear prompt is translated for Claude only; nothing extra is shown to the user", (t) => {
  const { run, log } = setup(t);
  const output = run("UserPromptSubmit", prompt("把那个按钮弄好看点"));
  assert.equal(output.systemMessage, undefined);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /^\[renhua\]/);
  assert.match(output.hookSpecificOutput.additionalContext, /更精确的说法：请测试/);
  const [entry] = log();
  assert.equal(entry.kind, "input");
  assert.equal(entry.ok, true);
  assert.equal(typeof entry.ms, "number");
});

test("the recent conversation from the transcript is passed to Codex", (t) => {
  const { run, fakeRequests } = setup(t);
  run("UserPromptSubmit", prompt("那再把退出也做了"));
  const input = fakeRequests().find((entry) => entry.method === "turn/start").params.input[0].text;
  assert.match(input, /用户：把刷新逻辑加上，顺便跑下测试/);
  assert.match(input, /【用户刚刚说的话】\n那再把退出也做了/);
});

test("open questions are shown to the user and Claude is told to ask first", (t) => {
  const { run } = setup(t, {
    env: { FAKE_REPLY: JSON.stringify({ intent: "你想美化按钮", unclear: ["是登录按钮还是提交按钮？"], for_claude: "美化按钮" }) }
  });
  const output = run("UserPromptSubmit", prompt("把那个按钮弄好看点"));
  assert.match(output.systemMessage, /^┏━ Codex 对你这句话的理解/);
  assert.match(output.systemMessage, /┃ 不确定：是登录按钮还是提交按钮？\n┃ → 已提醒 Claude 先问你\n┗━ 以上是 Codex 写的/);
  assert.match(output.hookSpecificOutput.additionalContext, /先用一两句话向用户确认/);
});

test("acknowledgements and slash commands are not translated and start no broker", (t) => {
  const { run, session } = setup(t);
  assert.equal(run("UserPromptSubmit", prompt("好的，继续")), null);
  assert.equal(run("UserPromptSubmit", prompt("/renhua:status")), null);
  assert.equal(session().broker, undefined);
});

test("nothing happens while renhua is switched off", (t) => {
  const { run } = setup(t, { config: { enabled: false, pausedReason: "manual" } });
  assert.equal(run("UserPromptSubmit", prompt("把那个按钮弄好看点")), null);
});

test("a malformed Codex answer lets the prompt through with a one-line notice", (t) => {
  const { run, config, log } = setup(t, { env: { FAKE_CODEX_MODE: "garbage" } });
  const output = run("UserPromptSubmit", prompt("把那个按钮弄好看点"));
  assert.equal(output.systemMessage, "renhua：Codex 回复格式异常，这句没翻译");
  assert.equal(output.hookSpecificOutput, undefined);
  assert.equal(config().consecutiveFailures, 1);
  assert.equal(log()[0].ok, false);
  assert.equal(log()[0].error, "format");
});

test("a slow Codex times out within the configured limit", (t) => {
  const { run } = setup(t, { env: { FAKE_CODEX_MODE: "hang" }, config: { inputTimeoutMs: 400 } });
  const started = Date.now();
  const output = run("UserPromptSubmit", prompt("把那个按钮弄好看点"));
  assert.equal(output.systemMessage, "⏱ renhua：Codex 超时，这句没翻译");
  assert.ok(Date.now() - started < 5000);
});

test("running out of quota pauses renhua", (t) => {
  const { run, config } = setup(t, { env: { FAKE_CODEX_MODE: "quota" } });
  const output = run("UserPromptSubmit", prompt("把那个按钮弄好看点"));
  assert.equal(output.systemMessage, "renhua：Codex 额度用完，已暂停翻译。额度恢复后敲 /renhua:on");
  assert.equal(config().enabled, false);
  assert.equal(config().pausedReason, "quota");
});

test("three failures in a row pause renhua", (t) => {
  const { run, config } = setup(t, { env: { FAKE_CODEX_MODE: "garbage" } });
  run("UserPromptSubmit", prompt("第一句话要翻译"));
  run("UserPromptSubmit", prompt("第二句话要翻译"));
  const output = run("UserPromptSubmit", prompt("第三句话要翻译"));
  assert.equal(
    output.systemMessage,
    "renhua：Codex 回复格式异常，这句没翻译\nrenhua：连续失败 3 次，已暂停翻译。/renhua:status 看原因，/renhua:on 恢复"
  );
  assert.equal(config().enabled, false);
  assert.equal(run("UserPromptSubmit", prompt("第四句话")), null);
});

test("a logged-out Codex is reported once, then the session stays quiet", (t) => {
  const { run, session } = setup(t, { env: { FAKE_CODEX_MODE: "logged-out" } });
  const first = run("UserPromptSubmit", prompt("把那个按钮弄好看点"));
  assert.equal(first.systemMessage, "renhua：Codex 没有登录，本次会话不翻译。在终端运行 codex login 后，敲 /renhua:on");
  assert.equal(session().unavailable, "not-logged-in");
  assert.equal(run("UserPromptSubmit", prompt("把那个按钮弄好看点")), null);
});

test("session start warms up the broker quietly when Codex is fine", (t) => {
  const { run, session } = setup(t);
  assert.equal(run("SessionStart", { hook_event_name: "SessionStart", source: "startup" }), null);
  assert.ok(session().broker.pid);
});

test("session start reports an unusable Codex once", (t) => {
  const { run, session } = setup(t, { env: { RENHUA_CODEX_BIN: "/nonexistent/codex" } });
  const output = run("SessionStart", { hook_event_name: "SessionStart", source: "startup" });
  assert.equal(output.systemMessage, "renhua：没找到 codex 命令，本次会话不翻译。装好 Codex CLI 后敲 /renhua:on");
  assert.equal(session().unavailable, "codex-missing");
});

test("session start reminds the user when renhua was paused automatically", (t) => {
  const { run } = setup(t, { config: { enabled: false, pausedReason: "quota" } });
  const output = run("SessionStart", { hook_event_name: "SessionStart", source: "startup" });
  assert.equal(output.systemMessage, "renhua 目前是暂停的（Codex 额度用完）。/renhua:on 恢复");
});

test("session start exports the session id for the slash commands", (t) => {
  const { run, dir, sessionId } = setup(t);
  const envFile = path.join(dir, "claude.env");
  run("SessionStart", { hook_event_name: "SessionStart", source: "startup" }, { CLAUDE_ENV_FILE: envFile });
  assert.match(fs.readFileSync(envFile, "utf8"), new RegExp(`export RENHUA_SESSION_ID='${sessionId}'`));
});

const stop = (reply, extra = {}) => ({
  hook_event_name: "Stop",
  transcript_path: FIXTURE,
  last_assistant_message: reply,
  stop_hook_active: false,
  ...extra
});

test("Claude's reply is summarised in three sections with the turn's recorded actions", (t) => {
  const { run, session, fakeRequests } = setup(t);
  const output = run("Stop", stop("已在 `refreshToken()` 里加上过期刷新，并补了单测，测试全部通过。"));
  assert.equal(
    output.systemMessage,
    "┏━ Codex 翻译的人话版 ━━━━\n┃ 做了什么：做了测试\n┃ 结果：成功\n┃ 要你做的：没有\n┗━ 以上是 Codex 写的 ━━━━━━━━━━"
  );
  const input = fakeRequests().find((entry) => entry.method === "turn/start").params.input[0].text;
  assert.match(input, /改动的文件（2 个）：src\/auth.ts、src\/auth.test.ts/);
  assert.match(input, /出错的地方：\n- Bash: Exit code 1/);
  assert.equal(session().lastTranslatedUuid, "s9");
});

test("a later stop in the same turn only reports what happened since the last summary", (t) => {
  const { run, fakeRequests } = setup(t);
  run("Stop", stop("第一次停下来的时候写的一段比较长的说明文字，用来确保不会因为太短而被跳过。"));
  const output = run("Stop", stop("第二次停下来，什么都没做，只说了一句。"));
  assert.equal(output, null);
  assert.equal(fakeRequests().filter((entry) => entry.method === "turn/start").length, 1);
});

test("short replies without actions are not summarised", (t) => {
  const { run, session } = setup(t);
  const fixture = path.join(os.tmpdir(), `renhua-quiet-${process.pid}.jsonl`);
  fs.writeFileSync(fixture, `${JSON.stringify({ type: "user", uuid: "q1", message: { role: "user", content: "你好呀" } })}\n`);
  t.after(() => fs.rmSync(fixture, { force: true }));
  assert.equal(run("Stop", stop("你好！", { transcript_path: fixture })), null);
  assert.equal(session().lastTranslatedUuid, "q1");
});

test("the reply falls back to the transcript when the hook input lacks it", (t) => {
  const { run, fakeRequests } = setup(t);
  run("Stop", { hook_event_name: "Stop", transcript_path: FIXTURE });
  const input = fakeRequests().find((entry) => entry.method === "turn/start").params.input[0].text;
  assert.match(input, /【Claude 最后的回复】\n已在 `refreshToken\(\)` 里加上过期刷新/);
});

test("a failed summary shows a one-line notice", (t) => {
  const { run } = setup(t, { env: { FAKE_CODEX_MODE: "hang" }, config: { outputTimeoutMs: 400 } });
  const output = run("Stop", stop("已在 `refreshToken()` 里加上过期刷新，并补了单测，测试全部通过。"));
  assert.equal(output.systemMessage, "⏱ renhua：Codex 超时，这次没有人话版");
});

test("session end stops the broker and forgets the session", (t) => {
  const { run, session } = setup(t);
  run("SessionStart", { hook_event_name: "SessionStart", source: "startup" });
  const { pid } = session().broker;
  run("SessionEnd", { hook_event_name: "SessionEnd", reason: "exit" });
  assert.deepEqual(session(), {});
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    try {
      process.kill(pid, 0);
      spawnSync("sleep", ["0.05"]);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false);
});

test("garbage on stdin never breaks the session", (t) => {
  const { run } = setup(t);
  assert.equal(run("UserPromptSubmit", "{not json"), null);
});
