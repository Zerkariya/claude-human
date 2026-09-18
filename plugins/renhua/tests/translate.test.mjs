import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInputRequest,
  buildOutputRequest,
  formatInputForClaude,
  formatInputForUser,
  formatOutputForUser,
  parseResult
} from "../scripts/lib/translate.mjs";

const noActions = { prompt: "", edits: [], commands: [], otherTools: [], errors: [] };

test("input request carries the instructions, the recent conversation and the new prompt", () => {
  const request = buildInputRequest({
    prompt: "把那个按钮弄好看点",
    tail: [
      { role: "user", text: "做个登录页" },
      { role: "assistant", text: "做好了，有登录按钮和提交按钮。" }
    ]
  });
  assert.match(request.instructions, /翻译官/);
  assert.match(request.input, /用户：做个登录页/);
  assert.match(request.input, /Claude：做好了/);
  assert.match(request.input, /【用户刚刚说的话】\n把那个按钮弄好看点/);
  assert.deepEqual(request.outputSchema.required, ["references", "intent", "unclear", "for_claude"]);
});

test("input request says so when there is no earlier conversation", () => {
  const request = buildInputRequest({ prompt: "你好，帮我建个项目", tail: [] });
  assert.match(request.input, /（这是对话的第一句）/);
});

test("output request lists the recorded actions and the reply", () => {
  const request = buildOutputRequest({
    reply: "已修复。",
    actions: {
      prompt: "修一下登录",
      edits: ["src/a.ts", "src/b.ts"],
      commands: ["Run unit tests"],
      otherTools: ["Read", "Grep"],
      errors: ["Bash: Exit code 1"]
    }
  });
  assert.match(request.instructions, /翻译官/);
  assert.match(request.input, /【用户这一轮说的话】\n修一下登录/);
  assert.match(request.input, /改动的文件（2 个）：src\/a.ts、src\/b.ts/);
  assert.match(request.input, /运行的命令：Run unit tests\n（除了下面"出错的地方"列出的，其余命令都正常结束了）/);
  assert.match(request.input, /用到的其他工具：Read、Grep/);
  assert.match(request.input, /出错的地方：\n- Bash: Exit code 1/);
  assert.match(request.input, /【Claude 最后的回复】\n已修复。/);
  assert.deepEqual(request.outputSchema.required, ["did", "result", "todo"]);
});

test("output request marks a turn without actions and caps long lists", () => {
  const edits = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
  const quiet = buildOutputRequest({ reply: "解释一下……", actions: noActions });
  assert.match(quiet.input, /没有改文件，也没有运行命令/);
  const busy = buildOutputRequest({ reply: "好了", actions: { ...noActions, edits } });
  assert.match(busy.input, /改动的文件（30 个）：f0.ts、.*f19.ts 等 30 个/);
  const clean = buildOutputRequest({ reply: "好了", actions: { ...noActions, commands: ["npm test"] } });
  assert.match(clean.input, /运行的命令：npm test\n（这些命令都正常结束，没有报错）/);
});

test("parseResult accepts plain JSON and fenced JSON", () => {
  const plain = parseResult("input", '{"intent":"你想改按钮","unclear":["哪个按钮？",""],"for_claude":"改按钮"}');
  assert.deepEqual(plain, { intent: "你想改按钮", unclear: ["哪个按钮？"], for_claude: "改按钮" });
  const fenced = parseResult("output", '```json\n{"did":"a","result":"b","todo":"没有"}\n```');
  assert.deepEqual(fenced, { did: "a", result: "b", todo: "没有" });
});

test("a reference with several candidates becomes a question unless one already covers it", () => {
  const references = [{ phrase: "那个按钮", candidates: ["登录按钮", "忘记密码按钮"] }];
  const silent = parseResult("input", JSON.stringify({ references, intent: "你想美化按钮", unclear: [], for_claude: "美化按钮" }));
  assert.deepEqual(silent.unclear, ["“那个按钮”指的是登录按钮，还是忘记密码按钮？"]);

  const asked = parseResult("input", JSON.stringify({ references, intent: "x", unclear: ["你是说登录按钮吗？"], for_claude: "" }));
  assert.deepEqual(asked.unclear, ["你是说登录按钮吗？"]);

  const three = parseResult("input", JSON.stringify({
    references: [{ phrase: "它", candidates: ["A", "B", "C", "A"] }, { phrase: "这个文件", candidates: ["a.ts"] }],
    intent: "x",
    unclear: [],
    for_claude: ""
  }));
  assert.deepEqual(three.unclear, ["“它”指的是A、B，还是C？"]);
});

test("parseResult rejects malformed answers with a format error", () => {
  assert.throws(() => parseResult("input", "我觉得用户想要改按钮"), { code: "format" });
  assert.throws(() => parseResult("output", '{"did":"a"}'), { code: "format" });
  assert.throws(() => parseResult("input", '{"intent":"","unclear":[],"for_claude":""}'), { code: "format" });
});

test("user-facing input block is framed as Codex's and lists the open questions", () => {
  assert.equal(
    formatInputForUser({ intent: "你想改按钮", unclear: ["哪个按钮？"], for_claude: "x" }),
    [
      "┏━ Codex 对你这句话的理解 ━━━━",
      "┃ 你想要：你想改按钮",
      "┃ 不确定：哪个按钮？",
      "┃ → 已提醒 Claude 先问你",
      "┗━ 以上是 Codex 写的 ━━━━━━━━━━"
    ].join("\n")
  );
  assert.equal(
    formatInputForUser({ intent: "你想改按钮", unclear: ["哪个按钮？", "什么风格？"], for_claude: "x" }),
    [
      "┏━ Codex 对你这句话的理解 ━━━━",
      "┃ 你想要：你想改按钮",
      "┃ 不确定：",
      "┃   · 哪个按钮？",
      "┃   · 什么风格？",
      "┃ → 已提醒 Claude 先问你",
      "┗━ 以上是 Codex 写的 ━━━━━━━━━━"
    ].join("\n")
  );
});

test("Claude-facing context puts the original words first and asks to confirm open questions", () => {
  const clear = formatInputForClaude({ intent: "你想改按钮", unclear: [], for_claude: "把登录按钮改好看" });
  assert.match(clear, /以用户原话为准/);
  assert.match(clear, /更精确的说法：把登录按钮改好看/);
  assert.doesNotMatch(clear, /先用一两句话向用户确认/);

  const unclear = formatInputForClaude({ intent: "你想改按钮", unclear: ["哪个按钮？"], for_claude: "" });
  assert.doesNotMatch(unclear, /更精确的说法/);
  assert.match(unclear, /不确定的地方：哪个按钮？/);
  assert.match(unclear, /先用一两句话向用户确认/);
});

test("user-facing output block has the three fixed sections, framed as Codex's", () => {
  assert.equal(
    formatOutputForUser({ did: "修好了登录", result: "测试全过", todo: "没有" }),
    [
      "┏━ Codex 翻译的人话版 ━━━━",
      "┃ 做了什么：修好了登录",
      "┃ 结果：测试全过",
      "┃ 要你做的：没有",
      "┗━ 以上是 Codex 写的 ━━━━━━━━━━"
    ].join("\n")
  );
});
