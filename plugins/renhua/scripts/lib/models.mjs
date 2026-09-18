// Asks Codex which models this account can use and which reasoning efforts each one supports.

import os from "node:os";
import process from "node:process";

import { CodexClient, LEAN_ARGS } from "./app-server.mjs";

const TIMEOUT_MS = 15_000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`超过 ${Math.round(ms / 1000)} 秒没有回应`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function connect(extraArgs) {
  const client = new CodexClient();
  try {
    await withTimeout(client.start({ cwd: os.tmpdir(), extraArgs, env: process.env }), TIMEOUT_MS);
    return client;
  } catch (error) {
    client.proc?.kill("SIGKILL");
    throw error;
  }
}

/** @returns {Promise<Array<{ id: string, efforts: string[], defaultEffort: string | null }>>} */
export async function fetchModels() {
  let client;
  try {
    client = await connect(LEAN_ARGS);
  } catch {
    client = await connect([]);
  }
  try {
    const list = await withTimeout(client.request("model/list", {}), TIMEOUT_MS);
    return (list.data ?? []).map((model) => ({
      id: model.id,
      efforts: (model.supportedReasoningEfforts ?? [])
        .map((option) => (typeof option === "string" ? option : option?.reasoningEffort))
        .filter(Boolean),
      defaultEffort: model.defaultReasoningEffort ?? null
    }));
  } finally {
    client.close();
  }
}
