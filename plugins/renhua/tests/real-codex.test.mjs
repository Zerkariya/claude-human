// Talks to the real Codex CLI and spends a little quota, so it only runs with RENHUA_REAL=1:
//   npm run test:real
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { call, ensureBroker, stopBroker } from "../scripts/lib/broker-client.mjs";
import { DEFAULT_CONFIG } from "../scripts/lib/state.mjs";
import { buildInputRequest, buildOutputRequest, formatInputForUser, formatOutputForUser, parseResult } from "../scripts/lib/translate.mjs";

const enabled = process.env.RENHUA_REAL === "1";
const sessionId = `real-${process.pid}`;

test("real Codex translates both directions within the time limits", { skip: !enabled }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renhua-real-"));
  process.env.RENHUA_DATA_DIR = dir;
  delete process.env.RENHUA_CODEX_BIN;
  t.after(async () => {
    await stopBroker(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const started = Date.now();
  const { broker, health } = await ensureBroker(sessionId, { waitMs: 10_000 });
  assert.equal(health.ok, true, JSON.stringify(health));
  t.diagnostic(`broker ready in ${Date.now() - started} ms (lean=${health.lean}, models=${health.models.join(",")})`);

  const settings = { model: DEFAULT_CONFIG.model, effort: DEFAULT_CONFIG.effort, fast: false };

  const inputRequest = buildInputRequest({
    prompt: "把那个按钮弄好看点",
    tail: [
      { role: "user", text: "帮我做个登录页" },
      { role: "assistant", text: "登录页做好了，页面上有「登录」按钮和「忘记密码」按钮。" }
    ]
  });
  const input = await call(broker.socket, "run", { ...inputRequest, ...settings, timeoutMs: DEFAULT_CONFIG.inputTimeoutMs }, 20_000);
  const understood = parseResult("input", input.text);
  t.diagnostic(`input translation took ${input.ms} ms`);
  t.diagnostic(formatInputForUser(understood));
  assert.ok(input.ms < DEFAULT_CONFIG.inputTimeoutMs);
  assert.ok(understood.unclear.length > 0, "the vague button reference should be flagged");

  const outputRequest = buildOutputRequest({
    reply:
      "已在 `src/auth/session.ts` 的 `refreshToken()` 中加入对 401 的拦截，并在 `useAuth` hook 里做了重试（最多 1 次，带 jitter 的指数退避）。新增 3 个单测覆盖过期、刷新失败与并发刷新场景，`vitest run` 全部通过。要不要顺便把 `axios` 拦截器也迁移到 `ky`？",
    actions: {
      prompt: "登录老是过一会儿就掉，修一下",
      edits: ["src/auth/session.ts", "src/hooks/useAuth.ts", "src/auth/session.test.ts"],
      commands: ["Run unit tests"],
      otherTools: ["Read", "Grep"],
      errors: []
    }
  });
  const output = await call(broker.socket, "run", { ...outputRequest, ...settings, timeoutMs: DEFAULT_CONFIG.outputTimeoutMs }, 35_000);
  const summary = parseResult("output", output.text);
  t.diagnostic(`output translation took ${output.ms} ms`);
  t.diagnostic(formatOutputForUser(summary));
  assert.ok(output.ms < DEFAULT_CONFIG.outputTimeoutMs);
  assert.notEqual(summary.todo, "没有", "Claude asked a question, so the user has something to answer");
});
