# renhua（人话）设计文档

日期：2026-09-17

## 目标

一个 Claude Code 插件，用 Codex 当"翻译官"，两头翻译：

- **你 → Claude**：你发的每句话，先让 Codex 复述成清楚的意图，附给 Claude；有歧义时提醒 Claude 先问你。
- **Claude → 你**：Claude 每次说完，让 Codex 按固定三段（做了什么 / 结果 / 要你做的）写一段人话版，显示在回复下面。

## 已确认的决定

| 问题 | 决定 |
|---|---|
| 触发方式 | 两头都自动，`/renhua:on`、`/renhua:off` 一键开关；以 `/` 开头的命令和"好""继续"这类很短的附和跳过 |
| 输出形式 | 固定三段式小结：做了什么 / 结果 / 要你做的 |
| 输入处理 | Codex 的理解总是附给 Claude；只有发现歧义时才显示给你看，并提醒 Claude 先问你再动手（2026-09-18 改：原来每句都显示，清楚的话也显示，看着多余） |
| 分清谁在说话 | Codex 写的每一行前面加 `┃`，结尾一行写"以上是 Codex 写的"；复制粘贴后也认得出（2026-09-18 加） |
| 调用 Codex 的方式 | 常驻进程（方案 B）：每个 Claude 会话配一个常驻的 `codex app-server` |

## 平台限制（来自 Claude Code 官方 hooks 文档）

- `UserPromptSubmit` 钩子不能改写用户原话，只能附加 `additionalContext`（Claude 可见）和 `systemMessage`（用户可见）。
- `Stop` 钩子能拿到 `last_assistant_message` 和 `transcript_path`，能用 `systemMessage` 显示内容；没有任何钩子能替换 Claude 已经显示的回复。
- `UserPromptSubmit` 钩子默认超时 30 秒。

## 实测数据（2026-09-17，codex-cli 0.154.0）

`codex app-server` 启动加初始化只要约 0.07 秒。一次翻译（新开线程、带输出格式约束、思考强度 low）的耗时：

| 模型 | 标准档 | 快速档（priority） |
|---|---|---|
| gpt-5.6-luna | 约 5.5 秒 | 约 4.3 秒 |
| gpt-5.6-terra | 约 6–8 秒 | 未测 |
| gpt-5.5 | 约 8.5 秒 | 未测 |

结论：默认用 `gpt-5.6-luna` + `low` + 标准档；快速档做成可选配置（更快，但更费额度）。
关掉插件、MCP、通知等功能对速度几乎没有影响，但仍然要关：用户的 Codex 可能配置了每轮结束时的通知，也可能装了很多翻译用不上的插件，不关的话每翻译一次都会触发。

## 结构

仓库本身就是一个插件市场（marketplace），插件放在 `plugins/renhua/`：

```
plugins/renhua/
├─ .claude-plugin/plugin.json
├─ hooks/hooks.json          SessionStart / UserPromptSubmit / Stop / SessionEnd
├─ commands/                 on.md / off.md / status.md
├─ prompts/                  input.md / output.md（给 Codex 的指示）
├─ scripts/
│   ├─ hook.mjs              钩子入口，按事件分派
│   ├─ broker.mjs            常驻进程：持有一个 codex app-server，对外提供"跑一次翻译"
│   ├─ cli.mjs               on / off / status 命令的实现
│   └─ lib/
│       ├─ app-server.mjs    codex app-server 客户端（改编自 openai/codex-plugin-cc，Apache-2.0）
│       ├─ broker-client.mjs 连接常驻进程、确保它活着、必要时重启
│       ├─ transcript.mjs    从对话记录里取最近几轮、本轮动作
│       ├─ translate.mjs     两个翻译动作 + 格式化
│       ├─ skip.mjs          跳过规则
│       └─ state.mjs         配置、会话状态、日志、失败计数
└─ tests/                    node:test 单元测试 + 假 Codex
```

## 常驻进程（broker）

- 由 `SessionStart` 钩子在后台启动（脱离父进程），一个 Claude 会话一个，靠 `session_id` 区分，互不抢用。
- 对外是一个 Unix socket，协议是一行一个 JSON：
  - `ping` 返回健康状态（Codex 是否可用、是否登录、实际使用的模型）。
  - `run` 传入 `{instructions, input, outputSchema, timeoutMs}`，内部执行 `thread/start`（临时线程、只读、从不请求审批）+ `turn/start`，等到 `turn/completed` 后返回最终文本。超时就调用 `turn/interrupt` 让 Codex 停下来，然后返回超时错误。
  - `shutdown` 关闭。
- 多个 `run` 可以同时进行（每个用自己的线程，通知按 threadId 分发），所以不会报"忙"。
- 启动 Codex 时带精简参数：关闭插件、MCP、通知、浏览器、电脑操作等功能。如果这些参数导致启动失败，就去掉参数重试一次。
- Codex 的工作目录设为 broker 自己的临时目录，而不是你的项目，这样它不会去翻你的代码，也不会加载项目里的 AGENTS.md。
- 启动时读一次模型列表；配置里的模型不存在时，退回 Codex 的默认模型。
- 闲置 30 分钟自动退出；`SessionEnd` 时主动关闭。
- 钩子每次使用前先 `ping`；不通就杀掉进程重新拉起。

## 数据流

### 输入（UserPromptSubmit）

1. 开关是关的，或者这个会话已经标记为"Codex 不可用"，直接退出。
2. 符合跳过规则的，直接退出：以 `/` 开头；或者去掉标点空格后长度 ≤ 2；或者是常见附和（好/继续/ok/可以/对……）。
3. 从对话记录里取最近 3 轮（用户原话 + Claude 最终回复，每条截断到 600 字）。
4. 调用 broker 的 `run`，超时 15 秒，要求 Codex 交回 `{references[], intent, unclear[], for_claude}`。`references` 列出这句话里每个指代（"那个按钮"）以及它可能指的对象；只要某个指代的候选超过一个，而 `unclear` 里又没有问到，代码会自动补上一条"指的是 A，还是 B？"。实测：只靠文字指示，5 次里只有 2 次能挑出"两个按钮里的那个"；加上这一步后是 5/5，而只有一个按钮时是 0/5，不会乱问。
5. 返回两样东西：
   - `systemMessage`：给你看的"Codex 的理解"，只在发现歧义时才有；
   - `additionalContext`：给 Claude 看的理解 + "与原话冲突以原话为准" +（有歧义时）"先向用户确认再动手"。

### 输出（Stop）

1. 同样先看开关，以及会话是否已标记为 Codex 不可用。
2. 本轮的用户原话是 `/renhua:` 命令时跳过。
3. 从对话记录里取出上次翻译之后的所有动作：改了哪些文件（Edit/Write/NotebookEdit）、跑了哪些命令（Bash 的 description 或命令本身）、哪些工具调用报错。
4. 本轮什么都没做，并且回复少于 60 个字的，跳过。
5. 调用 `run`，超时 30 秒，要求 Codex 交回 `{did, result, todo}`。
6. 返回 `systemMessage`：三段式人话版。只给你看，不会塞回给 Claude。
7. 记下本次处理到对话记录的哪个位置，下次只翻译这之后的动作。这样 `/goal` 这类会让 Claude 多次停下的情况，不会重复翻译同样的内容。

## 出错处理

总原则：插件出任何问题都不挡住你干活。翻译失败时，原话照常发给 Claude，回复照常显示，只在下面用一行字说明原因。

| 情况 | 处理 |
|---|---|
| Codex 没装 / 没登录 | 会话开始时检测到，就提示一行，并把这个会话标记为"不可用"，之后不再重复提醒 |
| 常驻进程还没启动完 | 最多等 3 秒 |
| 常驻进程死了或卡住 | 杀掉重开 |
| 超时（输入 15 秒 / 输出 30 秒） | 中断 Codex 本轮，提示"这句没翻译" |
| 格式不对 | 提示"格式异常"，并记进日志 |
| 额度用完（错误信息里包含 usage limit / rate limit / quota / 429） | 自动暂停，提示用 `/renhua:on` 恢复 |
| 连续失败 3 次 | 自动暂停 |

## 状态文件

存放在 `~/.claude/renhua` 下。不用 `$CLAUDE_PLUGIN_DATA`，因为别的插件（比如 Codex 插件）会把它们自己的这个变量值导出到会话里的每条命令，导致斜杠命令和钩子读写的不是同一个目录。

- `config.json`：`enabled`、`pausedReason`、`model`、`effort`、`fast`、`consecutiveFailures`
- `sessions/<session_id>.json`：broker 的连接地址和 pid、`unavailable`、`lastTranslatedUuid`
- `log.jsonl`：每次翻译记一行，包括时间、类型、耗时、成败、错误

`/renhua:status` 显示：开关状态、当前会话的 broker 是否活着、最近 10 次耗时、最近的错误。

## 测试

1. **单元测试**（node:test，不碰 Codex）：跳过规则、对话记录解析（样本取自真实会话记录并做脱敏）、格式化、钩子输出的结构、失败计数和自动暂停。
2. **假 Codex**：一个模拟 app-server 协议的小程序，用环境变量 `RENHUA_CODEX_BIN` 指定。它可以模拟正常、卡死、乱回、未登录、启动即崩这几种情况，用来测 broker 的超时、中断、重启和闲置退出。
3. **真 Codex**：`RENHUA_REAL=1` 时才跑，用来测真实耗时。
4. **端到端**：`claude -p --plugin-dir plugins/renhua --output-format stream-json --include-hook-events --verbose`，检查钩子的输出和 Claude 是否收到了附加的理解。显示效果最后由你在交互界面里确认。

## 不做的事（YAGNI）

- 不翻译子代理的输出，也不翻译过程中间的工具输出。
- 不支持 Windows 命名管道（先只支持 macOS/Linux 的 Unix socket）。
- 不做每个项目单独的开关，开关是全局的。
