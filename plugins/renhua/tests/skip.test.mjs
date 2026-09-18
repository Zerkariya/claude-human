import test from "node:test";
import assert from "node:assert/strict";

import { shouldSkipInput, shouldSkipOutput } from "../scripts/lib/skip.mjs";

test("slash commands are skipped", () => {
  assert.equal(shouldSkipInput("/renhua:status"), "slash-command");
  assert.equal(shouldSkipInput("  /goal 做完为止"), "slash-command");
});

test("empty and very short prompts are skipped", () => {
  assert.equal(shouldSkipInput(""), "too-short");
  assert.equal(shouldSkipInput("   "), "too-short");
  assert.equal(shouldSkipInput("B"), "too-short");
  assert.equal(shouldSkipInput("好。"), "too-short");
});

test("common acknowledgements are skipped", () => {
  for (const text of ["好的", "继续", "OK!", "谢谢"]) {
    assert.notEqual(shouldSkipInput(text), null, text);
  }
  for (const text of ["对的 继续", "可以的", "Yes", "没问题", "keep going", "好的，继续吧"]) {
    assert.equal(shouldSkipInput(text), "acknowledgement", text);
  }
});

test("real requests are translated", () => {
  assert.equal(shouldSkipInput("把那个按钮弄好看点"), null);
  assert.equal(shouldSkipInput("好的，那把登录页也改一下"), null);
  assert.equal(shouldSkipInput("继续，但是先别动数据库"), null);
});

test("output with no actions and a short reply is skipped", () => {
  assert.equal(shouldSkipOutput({ reply: "好的。", actions: emptyActions() }), "short-reply");
  assert.equal(shouldSkipOutput({ reply: "", actions: emptyActions() }), "empty-reply");
});

test("output with actions is translated even when the reply is short", () => {
  const actions = { ...emptyActions(), edits: ["src/a.ts"] };
  assert.equal(shouldSkipOutput({ reply: "改好了。", actions }), null);
});

test("long output is translated", () => {
  assert.equal(shouldSkipOutput({ reply: "这".repeat(80), actions: emptyActions() }), null);
});

test("output for renhua's own commands is skipped", () => {
  const actions = { ...emptyActions(), prompt: "/renhua:status" };
  assert.equal(shouldSkipOutput({ reply: "这".repeat(80), actions }), "renhua-command");
});

function emptyActions() {
  return { prompt: "", edits: [], commands: [], otherTools: [], errors: [] };
}
