// Decides which messages are not worth a Codex round trip.

const ACK_TOKENS = [
  "好的", "好", "行", "可以的", "可以", "对的", "对", "是的", "是", "嗯嗯", "嗯",
  "继续吧", "继续", "没问题", "谢谢", "收到", "明白", "开始吧", "开始",
  "okay", "ok", "yes", "yep", "yeah", "y", "sure", "thanks", "thx",
  "keepgoing", "goon", "go", "continue", "lgtm"
];

const MIN_REPLY_CHARS = 60;

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

// True when the text is made up entirely of acknowledgement tokens, e.g. "对的继续".
function isAcknowledgement(normalized) {
  const reachable = new Array(normalized.length + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < normalized.length; i += 1) {
    if (!reachable[i]) {
      continue;
    }
    for (const token of ACK_TOKENS) {
      if (normalized.startsWith(token, i)) {
        reachable[i + token.length] = true;
      }
    }
  }
  return reachable[normalized.length];
}

/** @returns {string | null} skip reason, or null when the prompt should be translated */
export function shouldSkipInput(prompt) {
  const text = String(prompt ?? "").trim();
  if (text.startsWith("/")) {
    return "slash-command";
  }
  const normalized = normalize(text);
  if ([...normalized].length <= 2) {
    return "too-short";
  }
  if (isAcknowledgement(normalized)) {
    return "acknowledgement";
  }
  return null;
}

/** @returns {string | null} skip reason, or null when the reply should be translated */
export function shouldSkipOutput({ reply, actions }) {
  if (actions.prompt?.trim().startsWith("/renhua:")) {
    return "renhua-command";
  }
  const text = String(reply ?? "").trim();
  if (!text) {
    return "empty-reply";
  }
  const didSomething = actions.edits.length + actions.commands.length + actions.otherTools.length > 0;
  if (!didSomething && [...text].length < MIN_REPLY_CHARS) {
    return "short-reply";
  }
  return null;
}
