// Talks to the per-session broker: starts it, checks it is alive, restarts it, sends work, stops it.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadSession, saveSession } from "./state.mjs";

const BROKER_SCRIPT = fileURLToPath(new URL("../broker.mjs", import.meta.url));
const PING_TIMEOUT_MS = 1500;

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Sends one request to the broker socket and waits for its answer. */
export function call(socketPath, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = net.createConnection({ path: socketPath });
    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, brokerError("broker-timeout", `常驻 Codex 超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`)), timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      let message;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(reject, brokerError("broker-protocol", "常驻 Codex 回复无法解析"));
        return;
      }
      if (message.error) {
        finish(reject, brokerError(message.error.code ?? "codex", message.error.message ?? "Codex 出错"));
      } else {
        finish(resolve, message.result);
      }
    });
    socket.on("error", (error) => finish(reject, brokerError("broker-unreachable", error.message)));
    socket.on("close", () => finish(reject, brokerError("broker-unreachable", "常驻 Codex 断开了连接")));
  });
}

function isAlive(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killBroker(broker) {
  if (isAlive(broker?.pid)) {
    try {
      process.kill(broker.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  if (broker?.dir) {
    fs.rmSync(broker.dir, { recursive: true, force: true });
  }
}

/** Starts a fresh broker for the session without waiting for it to become ready. */
export function spawnBroker(sessionId) {
  killBroker(loadSession(sessionId).broker);
  // Keep the path short: Unix socket paths are limited to about 100 bytes on macOS.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renhua-"));
  const socket = path.join(dir, "b.sock");
  const logFd = fs.openSync(path.join(dir, "broker.log"), "a");
  const child = spawn(process.execPath, [BROKER_SCRIPT, "serve", "--socket", socket], {
    cwd: dir,
    env: process.env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  const broker = { socket, dir, pid: child.pid, startedAt: new Date().toISOString() };
  saveSession(sessionId, { broker });
  return broker;
}

/**
 * Pings the broker until it has finished starting or waitMs runs out.
 * Returns its latest health (possibly still { reason: "starting" }), or null when it never answered.
 */
export async function waitForBroker(broker, waitMs) {
  const deadline = Date.now() + waitMs;
  let health = null;
  for (;;) {
    const remaining = deadline - Date.now();
    try {
      health = await call(broker.socket, "ping", {}, Math.max(Math.min(remaining, PING_TIMEOUT_MS), 200));
      if (health.reason !== "starting") {
        return health;
      }
    } catch (error) {
      if (error.code === "broker-timeout" || !isAlive(broker.pid)) {
        return health;
      }
    }
    if (Date.now() >= deadline) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Makes sure the session has a live broker and returns { broker, health }.
 * A broker that does not answer at all is killed and replaced; one that is still starting is left alone.
 */
export async function ensureBroker(sessionId, { waitMs = 3000 } = {}) {
  let broker = loadSession(sessionId).broker;
  let health = broker?.socket && isAlive(broker.pid) ? await waitForBroker(broker, waitMs) : null;
  if (!health) {
    broker = spawnBroker(sessionId);
    health = await waitForBroker(broker, waitMs);
  }
  if (!health || health.reason === "starting") {
    throw brokerError("broker-start", `常驻 Codex ${Math.round(waitMs / 1000)} 秒内没有启动好`);
  }
  return { broker, health };
}

export async function stopBroker(sessionId) {
  const broker = loadSession(sessionId).broker;
  if (!broker) {
    return;
  }
  if (broker.socket) {
    await call(broker.socket, "shutdown", {}, 800).catch(() => {});
  }
  killBroker(broker);
  saveSession(sessionId, { broker: null });
}

export async function brokerStatus(sessionId) {
  const broker = loadSession(sessionId).broker;
  if (!broker?.socket || !isAlive(broker.pid)) {
    return null;
  }
  try {
    return await call(broker.socket, "ping", {}, 800);
  } catch {
    return null;
  }
}
