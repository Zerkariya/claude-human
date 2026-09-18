---
description: 查看或更换 renhua 翻译用的思考强度（low / medium / high ……）
argument-hint: "[档位，比如 medium；不填就是查看]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" effort "$ARGUMENTS"`

把上面这段命令输出原样放进一个代码块里展示给用户，不要改写，不要补充。
