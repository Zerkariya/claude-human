// Reads Claude Code transcript JSONL files and pulls out what the translators need.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const ANSWER_PREFIX = "Your questions have been answered: ";
const ANSWER_SUFFIX = / You can now continue with these answers in mind\.?\s*$/;
const MAX_ERROR_CHARS = 150;
const MAX_COMMAND_CHARS = 120;
const NON_PROMPT_PREFIXES = ["<local-command", "<bash-", "<task-notification", "<system-reminder"];

export function readTranscript(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!file) {
    return [];
  }
  let text;
  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) {
      text = fs.readFileSync(file, "utf8");
    } else {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(fd, buffer, 0, maxBytes, size - maxBytes);
        text = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      // The first line is almost certainly cut in half.
      text = text.slice(text.indexOf("\n") + 1);
    }
  } catch {
    return [];
  }

  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Ignore partial or foreign lines.
    }
  }
  return entries;
}

function shorten(text, maxChars) {
  const chars = [...String(text ?? "").trim()];
  if (chars.length <= maxChars) {
    return chars.join("");
  }
  const half = Math.floor(maxChars / 2);
  return `${chars.slice(0, half).join("")}…${chars.slice(-half).join("")}`;
}

function oneLine(text, maxChars) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= maxChars ? flat : `${chars.slice(0, maxChars).join("")}…`;
}

function blocks(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : [];
}

function toolResultText(block) {
  if (typeof block.content === "string") {
    return block.content;
  }
  if (Array.isArray(block.content)) {
    return block.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
  }
  return "";
}

/** The text of a real user prompt, or null when the entry is not one. */
export function promptText(entry) {
  if (entry?.type !== "user" || entry.isMeta || entry.isSidechain || entry.message?.role !== "user") {
    return null;
  }
  const content = entry.message.content;
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((block) => block?.type === "tool_result")) {
      return null;
    }
    text = content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  } else {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed || NON_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return null;
  }
  const command = trimmed.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (command) {
    const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? "";
    return args ? `${command[1].trim()} ${args}` : command[1].trim();
  }
  return trimmed;
}

function isMainThread(entry) {
  return !entry?.isSidechain;
}

/**
 * The recent conversation as alternating utterances, limited to the last `userTurns` user utterances.
 * Answers given through AskUserQuestion count as user utterances. For each stretch of assistant
 * output only the final text block is kept, since that is what the user actually read last.
 */
export function conversationTail(entries, { userTurns = 3, maxChars = 600, currentPrompt = null } = {}) {
  const toolNames = new Map();
  const utterances = [];

  for (const entry of entries) {
    if (!isMainThread(entry)) {
      continue;
    }
    const prompt = promptText(entry);
    if (prompt !== null) {
      utterances.push({ role: "user", text: prompt });
      continue;
    }
    for (const block of blocks(entry)) {
      if (entry.type === "assistant" && block?.type === "tool_use") {
        toolNames.set(block.id, block.name);
      } else if (entry.type === "assistant" && block?.type === "text" && block.text?.trim()) {
        const last = utterances.at(-1);
        if (last?.role === "assistant") {
          last.text = block.text.trim();
        } else {
          utterances.push({ role: "assistant", text: block.text.trim() });
        }
      } else if (entry.type === "user" && block?.type === "tool_result" && toolNames.get(block.tool_use_id) === "AskUserQuestion") {
        const answer = toolResultText(block).replace(ANSWER_PREFIX, "").replace(ANSWER_SUFFIX, "").trim();
        if (answer) {
          utterances.push({ role: "user", text: `（选项回答）${answer}` });
        }
      }
    }
  }

  const last = utterances.at(-1);
  if (currentPrompt && last?.role === "user" && last.text === currentPrompt.trim()) {
    utterances.pop();
  }

  let start = 0;
  let seen = 0;
  for (let i = utterances.length - 1; i >= 0; i -= 1) {
    if (utterances[i].role === "user") {
      seen += 1;
      start = i;
      if (seen === userTurns) {
        break;
      }
    }
  }
  return utterances.slice(start).map((utterance) => ({ role: utterance.role, text: shorten(utterance.text, maxChars) }));
}

function displayPath(file, cwd) {
  if (!file) {
    return "";
  }
  if (cwd) {
    const relative = path.relative(cwd, file);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  return file;
}

/**
 * What Claude did in the current turn: since the last real user prompt, or since `sinceUuid`
 * when that entry falls inside the current turn (so repeated Stop events do not repeat work).
 */
export function turnActions(entries, { cwd = null, sinceUuid = null } = {}) {
  let promptIndex = -1;
  let prompt = "";
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const text = isMainThread(entries[i]) ? promptText(entries[i]) : null;
    if (text !== null) {
      promptIndex = i;
      prompt = text;
      break;
    }
  }

  let start = promptIndex + 1;
  if (sinceUuid) {
    const sinceIndex = entries.findIndex((entry) => entry?.uuid === sinceUuid);
    if (sinceIndex > promptIndex) {
      start = sinceIndex + 1;
    }
  }

  const toolNames = new Map();
  const edits = [];
  const commands = [];
  const otherTools = [];
  const errors = [];

  for (const entry of entries.slice(Math.max(start, 0))) {
    if (!isMainThread(entry)) {
      continue;
    }
    for (const block of blocks(entry)) {
      if (entry.type === "assistant" && block?.type === "tool_use") {
        toolNames.set(block.id, block.name);
        if (EDIT_TOOLS.has(block.name)) {
          const file = displayPath(block.input?.file_path ?? block.input?.notebook_path, cwd);
          if (file && !edits.includes(file)) {
            edits.push(file);
          }
        } else if (block.name === "Bash") {
          const label = block.input?.description || block.input?.command;
          if (label) {
            commands.push(oneLine(label, MAX_COMMAND_CHARS));
          }
        } else if (block.name && !otherTools.includes(block.name)) {
          otherTools.push(block.name);
        }
      } else if (entry.type === "user" && block?.type === "tool_result" && block.is_error) {
        const name = toolNames.get(block.tool_use_id) ?? "工具";
        errors.push(`${name}: ${oneLine(toolResultText(block), MAX_ERROR_CHARS)}`);
      }
    }
  }

  const lastUuid = [...entries].reverse().find((entry) => entry?.uuid)?.uuid ?? null;
  return { prompt, edits, commands, otherTools, errors, lastUuid };
}
