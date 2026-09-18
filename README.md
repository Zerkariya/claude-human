# renhua（人话）

一个 Claude Code 插件：让 Codex 在你和 Claude 之间当翻译官。

- **你说的话**：发给 Claude 之前，先让 Codex 复述一遍你的意思，附给 Claude。你的话有歧义时（比如页面上有两个按钮，你说"那个按钮"），你会看到 Codex 的理解和它发现的问题，Claude 会先问你，而不是自己猜着动手。没有歧义时，屏幕上不多显示任何东西。
- **Claude 的回复**：Claude 说完之后，Codex 用大白话写一段三段式小结，显示在回复下面：

```
┏━ Codex 翻译的人话版 ━━━━
┃ 做了什么：修好了登录过一会儿就掉线的问题，改了 3 个文件。
┃ 结果：自动测试全部通过。
┃ 要你做的：没有。Claude 顺便问要不要换一个发网络请求的工具，不换也不影响。
┗━ 以上是 Codex 写的 ━━━━━━━━━━
```

## 需要什么

- Claude Code
- [Codex CLI](https://github.com/openai/codex)，并且已经登录（在终端运行 `codex login`）。每个人用的是自己的 Codex 账号和额度。
- Node.js 18 或更新版本
- macOS 或 Linux（暂不支持 Windows）

## 安装

在 Claude Code 里输入：

```
/plugin marketplace add Zerkariya/claude-human
/plugin install renhua@claude-human
```

装好后重开一次 Claude Code 就生效了。

以后要更新到新版本，在终端运行下面两条，再重开 Claude Code：

```
claude plugin marketplace update claude-human
claude plugin update renhua@claude-human
```

### 让团队项目自动提示安装

在团队共用项目的 `.claude/settings.json` 里加上这段并提交。同事在 Claude Code 里打开这个项目、信任这个文件夹后，会被提示安装 renhua：

```json
{
  "extraKnownMarketplaces": {
    "claude-human": { "source": { "source": "github", "repo": "Zerkariya/claude-human" } }
  },
  "enabledPlugins": { "renhua@claude-human": true }
}
```

## 怎么分清谁在说话

**每行前面有 `┃` 的是 Codex 写的，其余都是 Claude。** 复制粘贴出来也一样认得出。

```
❯ 把那个按钮的文字改成蓝色
  ⎿  UserPromptSubmit says: ┏━ Codex 对你这句话的理解 ━━━━
     ┃ 你想要：你想把某个按钮的文字改成蓝色。
     ┃ 不确定：你指的是哪个按钮？
     ┃ → 已提醒 Claude 先问你
     ┗━ 以上是 Codex 写的 ━━━━━━━━━━
⏺ 我需要澄清一下——您指的是项目中的哪个按钮？……          ← Claude
  ⎿  Stop says: ┏━ Codex 翻译的人话版 ━━━━
     ┃ 做了什么：还没动手，先向你确认几件事……
     ┃ 结果：还没有改任何东西。
     ┃ 要你做的：请告诉 Claude 要修改的是哪个按钮……
     ┗━ 以上是 Codex 写的 ━━━━━━━━━━
```

在终端里还有一个线索：`⏺` 开头的是 Claude，`⎿ … says:` 开头的是插件（也就是 Codex）。这两个符号复制出来会丢，所以主要看 `┃`。

## 用法

装好之后就自动工作，平时不用管它。有这几个命令：

| 命令 | 作用 |
|---|---|
| `/renhua:off` | 关掉翻译 |
| `/renhua:on` | 打开翻译；也用来在 Codex 登录好之后、或者额度恢复后重新启用 |
| `/renhua:status` | 看开关状态、Codex 是否在运行、最近几次各花了几秒、最近的错误 |
| `/renhua:model` | 看当前用的模型和你的账号能用的所有模型；`/renhua:model gpt-5.6-terra` 换模型 |
| `/renhua:effort` | 看当前的思考强度和可选档位；`/renhua:effort medium` 换档位 |

换模型、换档位之前会先问 Codex 检查一遍，名字打错或者这个模型没有这个档位，就不会保存。改完下一句话就生效，不用重开。模型越大、档位越高，翻译越慢；档位调到 high 及以上，可能会超过等待上限，超时的那次就不翻译。

有些话不会翻译：`/` 开头的命令，以及"好""继续""可以"这类很短的附和。

## 会慢多少

每次翻译大约 4–7 秒（用的是 Codex 里最快的 `gpt-5.6-luna`、最低思考强度）。也就是说，你每发一句话，要多等几秒 Claude 才开始干活；Claude 说完之后，再过几秒人话版才出来。

## 出问题时

插件出任何问题都不会挡住你：翻译失败时，你的话照常发给 Claude，只在下面多一行说明。

- Codex 超时（你的话 15 秒，人话版 30 秒）：这一次不翻译。
- Codex 额度用完，或者连续失败 3 次：自动暂停，`/renhua:on` 恢复。
- Codex 没装或者没登录：这次会话不翻译，开头提示你一次。

## 改设置

模型和思考强度用上面的 `/renhua:model`、`/renhua:effort` 改就行。其他设置要直接改 `~/.claude/renhua/config.json`：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `model` | `gpt-5.6-luna` | 用哪个 Codex 模型；你的账号没有这个模型时，自动用 Codex 的默认模型（可以用 `/renhua:model` 看看你的账号有哪些） |
| `effort` | `low` | 思考强度，调高会更慢 |
| `fast` | `false` | 改成 `true` 用快速档，每次大约快 1 秒，但更费额度 |
| `inputTimeoutMs` | `15000` | 翻译你的话最多等多久（毫秒） |
| `outputTimeoutMs` | `30000` | 写人话版最多等多久（毫秒） |

给 Codex 的指示在 `plugins/renhua/prompts/` 里。

## 开发

```
npm test            # 单元测试，用假 Codex，不花额度
npm run test:real   # 用真 Codex 跑一次，会花一点额度
```

设计文档：`docs/superpowers/specs/2026-09-17-renhua-design.md`

## 许可证

MIT，见 `LICENSE`。

例外：`plugins/renhua/scripts/lib/app-server.mjs` 改编自 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)，这个文件仍然使用 Apache-2.0 许可，见 `plugins/renhua/LICENSE-APACHE` 和 `plugins/renhua/NOTICE`。
