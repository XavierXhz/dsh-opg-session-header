# 决策记录 — 插件OPG集成
> 低频稳定文件：记录「为什么这么做」。已定案条目不改写；被取代时新起条目并标注「取代 YYYY-MM-DD 决策」。
> 规则：做出影响后续工作的选择时，定案即记；新决策放最上。

## 决策列表（新决策放最上）

- [2026-10-23] 采用「pi-ai 适配器分发点注入 + initiator 回退」方案（状态: 生效）
- [2026-10-23] 不采用 `dsh-auto-review-plus` 作为本机方案（状态: 生效，保留为备选）
- [2026-10-23] 采用显式文件记忆体系（状态: 生效）

### [2026-10-23] 采用「pi-ai 适配器分发点注入 + initiator 回退」方案

- 背景: dsh 0.2.1-rc.2 下官方 Auto review 的评审请求不带 `sessionId`，走 opencode-go 时 400 MissingSessionID；上游无修复版本。
- 决策: 本地重写一个纯 Host 插件，在 `PiAiAdapter#streamWithSnapshot` + `snapshot.models.streamSimple` 处补 `x-opencode-session`；无 sessionId 时用 `agents.currentInitiator()?.session?.id` 回退；固定路由前缀 `opencode-go`。
- 备选: (a) 装 mathangler 原插件；(b) 移植 auto-review-plus；(c) provider 静态 headers 兜底。
- 原因: 开箱兼容当前版本、覆盖所有无 sessionId 辅助调用、不接管官方 preset、无 client/持久化、卸载即还原；原插件为 ★0 单作者且未上 npm，本地重写便于裁剪与自检（保留 MIT 归属）。静态 headers 会毁缓存亲和，仅作兜底。

### [2026-10-23] 不采用 `dsh-auto-review-plus` 作为本机方案

- 背景: 它 fork 官方自动审查，把 `sessionId`/`reasoningEffort` 写进评审请求，并加按会话审查模型选择器，理论上更接近根因。
- 决策: 不安装、不移植；只保留调研结论与最小移植清单。
- 备选: 改 peer 到 0.2.1-rc.2、补 `workingDirectory` 与 cwd、重新构建 host/client 后安装。
- 原因: peer 精确钉 0.2.0-rc.2 导致安装被跳过；需停用官方行并接管单槽位 `registerAuto`，带 1684 行 client 半边与 149 个 vitest 用例，长期 fork 维护成本高；只修评审路径，不覆盖 session title/compaction。若以后需要「审查单独选模型」再启用该路线。

### [2026-10-23] 初始化文件记忆体系

- 背景: 需要跨会话共享项目状态、约定与决策
- 决策: 采用 AGENTS.md + docs/PROGRESS.md、KNOWN-ISSUES.md、DECISIONS.md
- 备选: 自动记忆插件；单一 README；只靠对话
- 原因: 纯文本可审计、可进 git、跨工具可读；自动记忆不可靠
