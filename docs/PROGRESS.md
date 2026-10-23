# PROGRESS — 插件OPG集成
> 最后更新: 2026-10-23 22:25

## 当前状态
插件已实现、测试并安装进本机 web profile（热生效）。核心结论：mathangler 路线的适配器分发点注入在本机
0.2.1-rc.2 可行，官方自动审查路径已用实机探针验证；auto-review-plus 因 peer 钉 0.2.0-rc.2 且需移植，
未采用。剩余可选动作：由用户在 GUI 切一次 Auto 权限做最终人工确认。

## 已完成
- [2026-10-23] 写入插件实现：`lib/session-header.js` + `lib/index.js`（adapter 注入 + initiator 回退 + 状态端点）
- [2026-10-23] 补齐 bundle 资源：`package.json`、`cordis.patch.yml`、`locale/{en,zh}.json`、`icon.svg`、`LICENSE`
- [2026-10-23] 测试：`node --test test/*.test.mjs` 19/19 通过（含本机真实 `PiAiAdapter` 集成）
- [2026-10-23] 网关实测：缺头 400 MissingSessionID / 带头 200（`scripts/verify-gateway.mjs`）
- [2026-10-23] 安装进 web profile：`application: applied`，实机 `hooked.adapters=1`、`routesInScope=["opencode-go"]`
- [2026-10-23] 实机自动审查路径探针：`ok:true`、`inherited:1`、`sessionless:0`（探针已卸载）
- [2026-10-23] 文档：调研对比、设计与实现、验证记录；初始化文件记忆体系（AGENTS.md、docs/PROGRESS.md、KNOWN-ISSUES.md、DECISIONS.md）

## 下一步
- [ ] 在 GUI 权限选择器切到「自动审查」，跑一次 `bash`，再用 `node scripts/status.mjs` 确认 `counters.inherited` 增长、`sessionless` 为 0
- [ ] 决定是否 `git init` 并提交本仓库（用户确认后再做）
- [ ] dsh 升级后复跑 `node --test test/*.test.mjs` 与 `node scripts/status.mjs`，按 KNOWN-ISSUES 更新注入适配

## 已知问题
- 插件依赖 `ctx.llm.adapters` 与 `PiAdapter#streamWithSnapshot` 两个 TS private 内部面，升级 dsh 可能失效（有诊断，不崩）。
- 展示元数据（locale/icon）未做浏览器渲染确认。
