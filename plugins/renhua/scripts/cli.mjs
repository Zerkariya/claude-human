#!/usr/bin/env node
// Backs the /renhua:on, /renhua:off and /renhua:status commands.

import process from "node:process";

import { brokerStatus, ensureBroker, stopBroker } from "./lib/broker-client.mjs";
import { fetchModels } from "./lib/models.mjs";
import { dataDir, listSessions, loadConfig, readLog, saveConfig, saveSession } from "./lib/state.mjs";

const HEALTH_TEXT = {
  "not-logged-in": "Codex 没有登录（在终端运行 codex login）",
  "codex-missing": "没找到 codex 命令",
  "codex-failed": "Codex 启动失败",
  "codex-exited": "Codex 进程退出了",
  starting: "正在启动"
};

const PAUSE_TEXT = {
  manual: "关闭（你手动关的）",
  quota: "暂停（Codex 额度用完）",
  failures: "暂停（连续失败 3 次）"
};

const KIND_TEXT = { input: "你的话", output: "人话版", hook: "钩子" };

const ERROR_TEXT = {
  timeout: "超时",
  "broker-timeout": "超时",
  format: "格式异常",
  "broker-start": "Codex 没启动好",
  crash: "钩子出错"
};

const currentSession = process.env.RENHUA_SESSION_ID || null;

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function clock(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--:--" : date.toTimeString().slice(0, 5);
}

function describeHealth(health) {
  if (!health) {
    return "没在运行（下次用到时会自动启动）";
  }
  if (health.ok) {
    return `运行中（pid ${health.pid}${health.lean ? "" : "，未能精简启动"}）`;
  }
  return `不可用：${HEALTH_TEXT[health.reason] ?? health.reason}${health.detail ? `（${String(health.detail).slice(0, 120)}）` : ""}`;
}

async function on() {
  saveConfig({ enabled: true, pausedReason: null, consecutiveFailures: 0 });
  for (const session of listSessions()) {
    if (session.state.unavailable) {
      saveSession(session.id, { unavailable: null });
    }
  }
  const lines = ["renhua 已开启。之后你发的话和 Claude 的回复都会经过 Codex 翻译。"];
  if (currentSession) {
    // Restart so a fresh login or a newly installed Codex is picked up.
    await stopBroker(currentSession);
    try {
      const { health } = await ensureBroker(currentSession, { waitMs: 5000 });
      lines.push(health.ok ? "Codex 检查正常。" : `但是 Codex 还不能用：${HEALTH_TEXT[health.reason] ?? health.reason}。`);
    } catch {
      lines.push("Codex 还在启动中，发下一句话时会自动接上。");
    }
  }
  return lines.join("\n");
}

async function off() {
  saveConfig({ enabled: false, pausedReason: "manual" });
  if (currentSession) {
    await stopBroker(currentSession);
  }
  return "renhua 已关闭。你的话和 Claude 的回复不再经过 Codex。/renhua:on 重新开启。";
}

async function status() {
  const config = loadConfig();
  const lines = ["renhua 状态", ""];
  lines.push(`开关：${config.enabled ? "开启" : PAUSE_TEXT[config.pausedReason] ?? "关闭"}`);
  lines.push(`模型：${config.model}（思考强度 ${config.effort}，${config.fast ? "快速档" : "标准档"}）`);
  lines.push(`超时：你的话 ${seconds(config.inputTimeoutMs)}，人话版 ${seconds(config.outputTimeoutMs)}`);

  if (currentSession) {
    lines.push(`当前会话的常驻 Codex：${describeHealth(await brokerStatus(currentSession))}`);
  } else {
    const live = [];
    for (const session of listSessions()) {
      const health = await brokerStatus(session.id);
      if (health) {
        live.push(`  ${session.id.slice(0, 8)}…  ${describeHealth(health)}`);
      }
    }
    lines.push(`常驻 Codex：${live.length ? "" : "没有在运行的"}`, ...live);
  }

  const entries = readLog(10);
  lines.push("", "最近的翻译：");
  if (!entries.length) {
    lines.push("  还没有记录");
  }
  for (const entry of entries) {
    const outcome = entry.ok ? "成功" : `失败：${ERROR_TEXT[entry.error] ?? entry.detail ?? entry.error}`;
    const time = typeof entry.ms === "number" ? seconds(entry.ms) : "";
    lines.push(`  ${clock(entry.ts)}  ${KIND_TEXT[entry.kind] ?? entry.kind}  ${time}  ${outcome}`);
  }

  const averages = ["input", "output"]
    .map((kind) => {
      const times = entries.filter((entry) => entry.ok && entry.kind === kind).map((entry) => entry.ms);
      return times.length ? `${KIND_TEXT[kind]} ${seconds(times.reduce((a, b) => a + b, 0) / times.length)}` : null;
    })
    .filter(Boolean);
  if (averages.length) {
    lines.push(`平均耗时：${averages.join("，")}`);
  }

  const lastError = [...entries].reverse().find((entry) => !entry.ok && entry.detail);
  if (lastError) {
    lines.push(`最近一次错误详情：${String(lastError.detail).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  lines.push("", `数据目录：${dataDir()}（改 config.json 可以换模型、开快速档、调超时）`);
  return lines.join("\n");
}

// Levels above this tend to push a translation past the wait limits.
const QUICK_EFFORTS = new Set(["low", "medium"]);
const SLOW_WARNING = "注意：档位高了，翻译可能超过等待上限（你的话 15 秒、人话版 30 秒），超时的那次就不翻译；连续 3 次失败会自动暂停。";

async function loadModels() {
  try {
    return { models: await fetchModels() };
  } catch (error) {
    const detail = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 100);
    return { message: `Codex 现在连不上（${detail}），没法检查。设置没改。` };
  }
}

async function model(name) {
  const { models, message } = await loadModels();
  if (!models) {
    return message;
  }
  const config = loadConfig();

  if (!name) {
    return [
      `当前：${config.model}（思考强度 ${config.effort}）`,
      "",
      "你的账号能用的模型：",
      ...models.map((m) => `  ${m.id === config.model ? "●" : " "} ${m.id}  可选思考强度：${m.efforts.join(" / ")}`),
      "",
      "换模型：/renhua:model 模型名，比如 /renhua:model gpt-5.6-terra",
      "大模型更准，但每次翻译要等得更久。"
    ].join("\n");
  }

  const target = models.find((m) => m.id.toLowerCase() === name.toLowerCase());
  if (!target) {
    return `没有叫「${name}」的模型。你的账号能用的是：${models.map((m) => m.id).join("、")}。设置没改。`;
  }

  const lines = [];
  let effort = config.effort;
  if (target.efforts.length && !target.efforts.includes(effort)) {
    const fallback = target.efforts.includes("low") ? "low" : target.defaultEffort ?? target.efforts[0];
    lines.push(`${target.id} 不支持思考强度 ${effort}，已改成 ${fallback}。`);
    effort = fallback;
  }
  saveConfig({ model: target.id, effort });
  lines.unshift(`已换成 ${target.id}（思考强度 ${effort}）。下一句话开始生效。`);
  lines.push("实际每次花几秒，可以用 /renhua:status 看。");
  return lines.join("\n");
}

async function effort(level) {
  const { models, message } = await loadModels();
  if (!models) {
    return message;
  }
  const config = loadConfig();
  const current = models.find((m) => m.id === config.model);
  if (!current) {
    return `当前模型 ${config.model} 不在你账号能用的模型里（翻译时会自动改用 Codex 的默认模型）。先用 /renhua:model 换一个。设置没改。`;
  }

  if (!level) {
    return [
      `当前：${config.effort}（模型 ${config.model}）`,
      `可选：${current.efforts.join(" / ")}`,
      "",
      "换档位：/renhua:effort 档位，比如 /renhua:effort medium",
      "档位越高想得越久，翻译这种活一般 low 就够了。"
    ].join("\n");
  }

  const wanted = level.toLowerCase();
  if (!current.efforts.includes(wanted)) {
    return `${config.model} 没有「${level}」这个档位，可选的是：${current.efforts.join(" / ")}。设置没改。`;
  }
  saveConfig({ effort: wanted });
  const lines = [`思考强度已改成 ${wanted}（模型 ${config.model}）。下一句话开始生效。`];
  if (!QUICK_EFFORTS.has(wanted)) {
    lines.push(SLOW_WARNING);
  }
  return lines.join("\n");
}

const COMMANDS = { on, off, status, model, effort };

const command = COMMANDS[process.argv[2]];
if (!command) {
  process.stdout.write("用法：cli.mjs on|off|status|model [模型名]|effort [档位]\n");
  process.exit(2);
}
const argument = process.argv.slice(3).join(" ").trim();
process.stdout.write(`${await command(argument)}\n`);
