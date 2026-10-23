# 插件OPG集成

> 类型: 开发 · 规范: project-memory-init/2.3 · 建立: 2026-10-23 · 最后核对: 2026-10-23
> dsh 本地插件：在 pi-ai 适配器分发点补 `x-opencode-session`，修复官方自动审查在 opencode-go 路由上的 400 MissingSessionID。

## 定位与边界
- 是什么/给谁: 本机 dsh `web` profile 的 Host bundle，让官方 Auto review、session title、compaction 等无 sessionId 的辅助调用也能通过 OpenCode Go 网关；面向本机维护者。
- 不做什么: 不接管 Auto preset、不提供审查模型选择器、不改 provider 配置或静态 headers、不修改 dsh 安装目录里的文件。

## 技术栈
- 纯 ESM JavaScript（Node ≥ 22），无运行时依赖、无构建；通过 `dsh.bundle.patch` 以本地目录链接安装。
- 目标环境 dsh `0.2.1-rc.2` + pi-ai 1.3.0；依赖两个 TypeScript `private` 内部面：`ctx.llm.adapters` 与 `PiAiAdapter#streamWithSnapshot`。
- 测试用 Node 内置 `node:test`；真实适配器测试读取本机安装的 dsh，可用 `DSH_ROOT` 覆盖。

## 常用命令
- 安装/重装: `plugin_manager` `install_bundle`，target 为本目录绝对路径
- 测试: `node --test test/*.test.mjs`
- 语法检查: `node --check lib/index.js && node --check lib/session-header.js`
- 网关对照: `node scripts/verify-gateway.mjs`
- 实机状态: `node scripts/status.mjs`

## 项目结构
- `lib/` 运行时代码：`session-header.js` 纯逻辑（范围/取值/适配器钩子），`index.js` Cordis Host 半边
- `test/` `node:test` 测试：核心单测 + 对本机真实 `PiAiAdapter` 的集成测试
- `scripts/` 验证脚本；`scripts/fixtures/opg-autoreview-probe/` 为一次性实机探针，不属于交付插件
- `docs/` 调研对比、设计与实现、验证记录，以及 PROGRESS / KNOWN-ISSUES / DECISIONS

## 工作约定
- 改注入逻辑前先读 docs/02-设计与实现.md 的失败模式表，改完必须重跑测试并用 install_bundle 重新安装（link 安装直接读本目录）。
- 新增配置键必须同时更新 README、docs/02 与 cordis.patch.yml 注释；未知键当前会拒绝加载。
- 不要把 `scripts/fixtures/` 的探针加进 `cordis.patch.yml` 或交付 bundle。

## 边界与红线
- 禁止把密钥/令牌/密码/账号写入任何记忆文件；只写「去哪找」（如 .env、密码管理器条目名）
- 禁止把未验证的推断写成结论；不确定时标注「待验证」
- 复述进度后，未经用户确认不得自动开始执行「下一步」
- 修改记忆文件必须用 read/write/edit 工具；并发会话先 read 再写（读-改-写）
- 推送公开仓库前先确认提交历史与文件中没有个人邮箱、密钥、本机绝对路径

## 进度衔接（必须保留本节原文）
- 每次会话开工第一步：读取 docs/PROGRESS.md，并用一句话向用户复述当前状态
- 会话结束或完成任一阶段性工作后：必须更新 docs/PROGRESS.md；
  任务未完成也必须如实修改"当前状态"，然后本次工作才算结束

## 自维护触发器（必须保留本节原文）
- 新增/移除依赖、换框架 → 更新「技术栈」
- 新增/变更脚本命令 → 更新「常用命令」
- 核心目录重组 → 更新「项目结构」
- 约定变更 → 更新「工作约定」
- 以上更新统一在会话收尾批量提交

## 记忆文件
- 进度 → docs/PROGRESS.md（开工必读；每次收尾必写）
- 已知坑 → docs/KNOWN-ISSUES.md（排障/踩坑时读；踩坑即记，含现象/原因/规避）
- 决策 → docs/DECISIONS.md（做方案取舍时读；定案即记，含背景/决策/备选/原因）
- 调研对比 → docs/01-插件调研与对比.md（换插件/评估方案时读）
- 设计与实现 → docs/02-设计与实现.md（改注入逻辑/排查失败模式时读）
- 验证记录 → docs/03-验证记录.md（复跑验证/升级 dsh 后自检时读）
- 本机私有 → AGENTS.local.md / docs/local/（不提交；只写本机差异，不写密钥）
