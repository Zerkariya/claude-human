// Builds the Codex requests for both directions, validates the answers and formats them for display.

import fs from "node:fs";

const PROMPTS_DIR = new URL("../../prompts/", import.meta.url);
const MAX_REPLY_CHARS = 6000;
const MAX_PROMPT_CHARS = 3000;
const MAX_LISTED_EDITS = 20;
const MAX_LISTED_COMMANDS = 15;
const MAX_UNCLEAR = 3;

export const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["references", "intent", "unclear", "for_claude"],
  properties: {
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "candidates"],
        properties: {
          phrase: { type: "string" },
          candidates: { type: "array", items: { type: "string" } }
        }
      }
    },
    intent: { type: "string" },
    unclear: { type: "array", items: { type: "string" } },
    for_claude: { type: "string" }
  }
};

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["did", "result", "todo"],
  properties: {
    did: { type: "string" },
    result: { type: "string" },
    todo: { type: "string" }
  }
};

function loadInstructions(kind) {
  return fs.readFileSync(new URL(`${kind}.md`, PROMPTS_DIR), "utf8").trim();
}

function shorten(text, maxChars) {
  const chars = [...String(text ?? "").trim()];
  if (chars.length <= maxChars) {
    return chars.join("");
  }
  const half = Math.floor(maxChars / 2);
  return `${chars.slice(0, half).join("")}\n…（中间省略）…\n${chars.slice(-half).join("")}`;
}

function listWithCap(items, cap) {
  const shown = items.slice(0, cap).join("、");
  return items.length > cap ? `${shown} 等 ${items.length} 个` : shown;
}

export function buildInputRequest({ prompt, tail }) {
  const history = tail.length
    ? tail.map((utterance) => `${utterance.role === "user" ? "用户" : "Claude"}：${utterance.text}`).join("\n\n")
    : "（这是对话的第一句）";
  return {
    instructions: loadInstructions("input"),
    input: `【最近的对话】\n${history}\n\n【用户刚刚说的话】\n${shorten(prompt, MAX_PROMPT_CHARS)}`,
    outputSchema: INPUT_SCHEMA
  };
}

export function buildOutputRequest({ reply, actions }) {
  const facts = [];
  if (actions.edits.length) {
    facts.push(`改动的文件（${actions.edits.length} 个）：${listWithCap(actions.edits, MAX_LISTED_EDITS)}`);
  }
  if (actions.commands.length) {
    const shown = actions.commands.slice(-MAX_LISTED_COMMANDS);
    const more = actions.commands.length > shown.length ? `（共 ${actions.commands.length} 条，只列出最后 ${shown.length} 条）` : "";
    facts.push(`运行的命令${more}：${shown.join("；")}`);
    facts.push(actions.errors.length ? "（除了下面\"出错的地方\"列出的，其余命令都正常结束了）" : "（这些命令都正常结束，没有报错）");
  }
  if (actions.otherTools.length) {
    facts.push(`用到的其他工具：${actions.otherTools.join("、")}`);
  }
  if (actions.errors.length) {
    facts.push(`出错的地方：\n${actions.errors.slice(-5).map((error) => `- ${error}`).join("\n")}`);
  }
  if (!actions.edits.length && !actions.commands.length) {
    facts.push("没有改文件，也没有运行命令。");
  }

  return {
    instructions: loadInstructions("output"),
    input: [
      `【用户这一轮说的话】\n${actions.prompt?.trim() || "（没有记录）"}`,
      `【Claude 这一轮实际做的事】\n${facts.join("\n")}`,
      `【Claude 最后的回复】\n${shorten(reply, MAX_REPLY_CHARS)}`
    ].join("\n\n"),
    outputSchema: OUTPUT_SCHEMA
  };
}

function formatError(message) {
  const error = new Error(message);
  error.code = "format";
  return error;
}

function asText(value) {
  return typeof value === "string" ? value.trim() : null;
}

function joinChoices(choices) {
  return choices.length === 2 ? `${choices[0]}，还是${choices[1]}` : `${choices.slice(0, -1).join("、")}，还是${choices.at(-1)}`;
}

// The model sometimes lists several candidates for "那个按钮" and then quietly picks one anyway.
// Any reference with more than one candidate that no question already covers becomes a question.
function ambiguousReferenceQuestions(references, unclear) {
  if (!Array.isArray(references)) {
    return [];
  }
  const questions = [];
  for (const reference of references) {
    const phrase = asText(reference?.phrase);
    const candidates = Array.isArray(reference?.candidates) ? [...new Set(reference.candidates.map(asText).filter(Boolean))] : [];
    if (!phrase || candidates.length < 2) {
      continue;
    }
    const covered = unclear.some((question) => question.includes(phrase) || candidates.some((candidate) => question.includes(candidate)));
    if (!covered) {
      questions.push(`“${phrase}”指的是${joinChoices(candidates)}？`);
    }
  }
  return questions;
}

/** Validates Codex's JSON answer. Throws an error with code "format" when it is unusable. */
export function parseResult(kind, rawText) {
  const text = String(rawText ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw formatError("Codex 回复不是 JSON");
  }
  if (!value || typeof value !== "object") {
    throw formatError("Codex 回复不是 JSON 对象");
  }

  if (kind === "input") {
    const intent = asText(value.intent);
    const forClaude = asText(value.for_claude);
    if (!intent || forClaude === null || !Array.isArray(value.unclear)) {
      throw formatError("Codex 回复缺少字段");
    }
    const unclear = value.unclear.map(asText).filter(Boolean);
    for (const question of ambiguousReferenceQuestions(value.references, unclear)) {
      unclear.unshift(question);
    }
    return { intent, unclear: unclear.slice(0, MAX_UNCLEAR), for_claude: forClaude };
  }

  const did = asText(value.did);
  const result = asText(value.result);
  const todo = asText(value.todo);
  if (!did || !result || !todo) {
    throw formatError("Codex 回复缺少字段");
  }
  return { did, result, todo };
}

// Every line Codex wrote carries a bar, so it stays recognisable even after copy and paste,
// where Claude Code's own markers are lost.
function codexBlock(title, lines) {
  return [`┏━ ${title} ━━━━`, ...lines.map((line) => `┃ ${line}`), "┗━ 以上是 Codex 写的 ━━━━━━━━━━"].join("\n");
}

export function formatInputForUser({ intent, unclear }) {
  const lines = [`你想要：${intent}`];
  if (unclear.length === 1) {
    lines.push(`不确定：${unclear[0]}`);
  } else if (unclear.length > 1) {
    lines.push("不确定：", ...unclear.map((item) => `  · ${item}`));
  }
  if (unclear.length) {
    lines.push("→ 已提醒 Claude 先问你");
  }
  return codexBlock("Codex 对你这句话的理解", lines);
}

export function formatInputForClaude({ intent, unclear, for_claude: forClaude }) {
  const lines = [
    "[renhua] Codex 对用户上面这句话的理解（仅供参考；与用户原话冲突时，以用户原话为准）：",
    `- 用户想要：${intent}`
  ];
  if (forClaude) {
    lines.push(`- 更精确的说法：${forClaude}`);
  }
  if (unclear.length) {
    lines.push(`- 不确定的地方：${unclear.join("；")}`);
    lines.push("这句话有不确定的地方：先用一两句话向用户确认，确认之前不要改文件，也不要执行有副作用的操作。");
  }
  return lines.join("\n");
}

export function formatOutputForUser({ did, result, todo }) {
  return codexBlock("Codex 翻译的人话版", [`做了什么：${did}`, `结果：${result}`, `要你做的：${todo}`]);
}
