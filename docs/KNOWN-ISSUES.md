# 已知坑 — 插件OPG集成
> 高频动态文件：踩坑即记，允许频繁变更。每条必须含 现象 / 原因 / 规避。

## 坑列表（新坑放最上）
<!-- 格式：[YYYY-MM-DD] 现象: …；原因: …；规避: … -->

- [2026-10-23] 现象: npm 上的 `dsh-opencode-session-header` 装完不修自动审查，且所有会话共用一个固定头值；原因: npm 同名包是 beihzb 的另一个项目（全局 fetch 补丁 + `DEFAULT_FALLBACK='dsh-default'`），与 mathangler 仓库不是同一份代码；规避: 只认 GitHub 仓库或本地路径，装前核对 homepage/机制，不要按 npm 名字装。
- [2026-10-23] 现象: 官方 Auto review 在 opencode-go 下报 `400 MissingSessionID`，主 agent 却正常；原因: 评审请求 `ctx.llm.stream` 不带 `sessionId`，pi-ai 原生注入拿不到值；fetch 补丁类插件同样空转；规避: 使用适配器分发点注入 + `agents.currentInitiator()` 回退（本插件），并看 `counters.inherited`/`sessionless` 自检。
- [2026-10-23] 现象: 改完 `lib/` 后运行中的 dsh 行为没变；原因: link 安装的包虽然直接读本目录，但已加载的 ESM 模块不会被重新求值；规避: 用 `plugin_manager` 重新安装（或重启 dsh 进程），再读状态端点确认 `hooked.adapters`。
- [2026-10-23] 现象: 想用 `dsh-auto-review-plus` 直接替换官方插件时安装被跳过；原因: 它的 peerDependencies 精确钉在 `0.2.0-rc.2`，`dsh-app-boot` 的 unmetRequirements 会跳过不匹配 bundle；规避: 若要采用，先改 peers 到 `0.2.1-rc.2`、补 `workingDirectory`/cwd 逻辑并重新构建 `lib/`；当前不需要。
- [2026-10-23] 现象: `node --test test/` 报 `Cannot find module .../test`；原因: Node 22 的 test runner 需要文件 glob 而不是目录；规避: 用 `node --test test/*.test.mjs`（package.json 的 `test` 脚本已按此写）。

## 已修复
<!-- 修好后移入这里，保留日期与修复结论 -->
