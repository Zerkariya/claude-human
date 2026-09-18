import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readTranscript, conversationTail, turnActions } from "../scripts/lib/transcript.mjs";

const FIXTURE = new URL("./fixtures/session.jsonl", import.meta.url).pathname;

test("readTranscript skips unparseable lines and missing files", () => {
  const entries = readTranscript(FIXTURE);
  assert.equal(entries.at(-1).uuid, "s9");
  assert.deepEqual(readTranscript("/nonexistent/file.jsonl"), []);
  assert.deepEqual(readTranscript(undefined), []);
});

test("readTranscript only reads the tail of very large files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renhua-test-"));
  const file = path.join(dir, "big.jsonl");
  const line = JSON.stringify({ type: "user", uuid: "x", message: { role: "user", content: "填充".repeat(50) } });
  fs.writeFileSync(file, `${line}\n`.repeat(2000) + JSON.stringify({ type: "user", uuid: "last", message: { role: "user", content: "hi" } }) + "\n");
  const entries = readTranscript(file, { maxBytes: 10_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(entries.length < 2000);
  assert.equal(entries.at(-1).uuid, "last");
  assert.ok(entries.every((entry) => entry.uuid));
});

test("conversationTail keeps user prompts, option answers and the last assistant text of each stretch", () => {
  const tail = conversationTail(readTranscript(FIXTURE), { userTurns: 10 });
  assert.deepEqual(tail, [
    { role: "user", text: "帮我看下登录页为什么报错" },
    { role: "assistant", text: "原因是 token 过期后没有刷新。你想让我直接修，还是先解释？" },
    { role: "user", text: "（选项回答）\"怎么处理？\"=\"直接修\"." },
    { role: "assistant", text: "好，我来修。" },
    { role: "user", text: "/renhua:status" },
    { role: "user", text: "把刷新逻辑加上，顺便跑下测试" },
    { role: "assistant", text: "已在 `refreshToken()` 里加上过期刷新，并补了单测，测试全部通过。" }
  ]);
});

test("conversationTail limits to the last N user turns", () => {
  const tail = conversationTail(readTranscript(FIXTURE), { userTurns: 2 });
  assert.equal(tail[0].text, "/renhua:status");
  assert.equal(tail.length, 3);
});

test("conversationTail drops the current prompt when it is already recorded", () => {
  const tail = conversationTail(readTranscript(FIXTURE), { userTurns: 10, currentPrompt: "把刷新逻辑加上，顺便跑下测试" });
  assert.equal(tail.at(-1).text, "已在 `refreshToken()` 里加上过期刷新，并补了单测，测试全部通过。");
  const withoutAssistant = conversationTail(readTranscript(FIXTURE).slice(0, 16), {
    userTurns: 10,
    currentPrompt: "把刷新逻辑加上，顺便跑下测试"
  });
  assert.equal(withoutAssistant.at(-1).text, "/renhua:status");
});

test("conversationTail shortens long texts keeping head and tail", () => {
  const entries = [
    { type: "user", message: { role: "user", content: "开头" + "中".repeat(2000) + "结尾" } }
  ];
  const [only] = conversationTail(entries, { maxChars: 100 });
  assert.ok(only.text.startsWith("开头"));
  assert.ok(only.text.endsWith("结尾"));
  assert.ok([...only.text].length <= 101);
});

test("turnActions collects edits, commands, other tools and errors since the last prompt", () => {
  const actions = turnActions(readTranscript(FIXTURE), { cwd: "/proj" });
  assert.equal(actions.prompt, "把刷新逻辑加上，顺便跑下测试");
  assert.deepEqual(actions.edits, ["src/auth.ts", "src/auth.test.ts"]);
  assert.deepEqual(actions.commands, ["Run unit tests", "npm test -- --run"]);
  assert.deepEqual(actions.otherTools, []);
  assert.deepEqual(actions.errors, ["Bash: Exit code 1 FAIL src/auth.test.ts > refreshes token"]);
  assert.equal(actions.lastUuid, "s9");
});

test("turnActions only looks after sinceUuid when it falls inside the current turn", () => {
  const entries = readTranscript(FIXTURE);
  const later = turnActions(entries, { cwd: "/proj", sinceUuid: "r4" });
  assert.deepEqual(later.edits, ["src/auth.ts", "src/auth.test.ts"]);
  assert.deepEqual(later.commands, ["npm test -- --run"]);
  assert.deepEqual(later.errors, []);

  const stale = turnActions(entries, { cwd: "/proj", sinceUuid: "m3" });
  assert.deepEqual(stale.commands, ["Run unit tests", "npm test -- --run"]);
});

test("turnActions reports non-edit tools of an earlier turn", () => {
  const entries = readTranscript(FIXTURE).slice(0, 11);
  const actions = turnActions(entries, { cwd: "/proj" });
  assert.equal(actions.prompt, "帮我看下登录页为什么报错");
  assert.deepEqual(actions.otherTools, ["Read", "AskUserQuestion"]);
});
