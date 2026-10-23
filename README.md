# dsh-opg-session-header

> 本地 DeepSeek Harness（dsh）插件：给每条走 `opencode-go*` 路由的推理请求补上**按会话稳定**的
> `x-opencode-session` 头，让 OpenCode Go 网关不再返回 `400 MissingSessionID`，并让**官方 Auto review
> （自动审查）**的评审请求也能正常工作。

- 目标环境：dsh `0.2.1-rc.2` + `@earendil-works/pi-ai` 1.3.0 + web profile + `opencode-go` provider
- 形态：纯 Host bundle，无依赖、无构建、无 client 半边；安装后**不需要重启**即可热生效，重启后照常加载
- 状态：已安装进本机 `web` profile，并通过单测、真实适配器集成测试、网关实测与实机自动审查路径验证

## 为什么需要它

dsh 0.2.1 的 pi-ai 适配器已经会根据 `GenerateOptions.sessionId` 给主 agent 请求加
`x-opencode-session`。但官方自动审查插件
`@deepseek-ai/dsh-experimental-auto-review` 在 `tools/pre-execute` 里**自己拼**
`ctx.llm.stream({ provider, model, system, messages, temperature, signal })`，**不带 `sessionId`**
（该包全仓 grep `sessionId` 零命中）。评审请求到了网关仍是裸请求，于是：

```text
Auto review of tool "bash" failed; its body was not executed: ... 400 MissingSessionID
```

本插件换了一个注入点：不再依赖调用方传 `sessionId`，而是在 pi-ai 适配器唯一的请求分发口
`PiAiAdapter#streamWithSnapshot → snapshot.models.streamSimple(model, ctx, options)` 的 `options.headers`
上补头。没有 `sessionId` 的辅助调用（自动审查、session title、compaction）用
`agents.currentInitiator()?.session?.id` 借发起这次调用的会话 id；**不伪造、不共用一个固定值**。

## 安装

用 dsh 插件管理器安装本目录（`plugin_manager` 的 `install_bundle`，target 传本仓库的绝对路径）：

```text
plugin_manager install_bundle target=<此仓库的绝对路径>
```

安装后效果：

- 当前进程热生效（实测 `application: applied`，适配器已挂上；若未热生效则重启 dsh）；
- 下次启动 dsh 时从 `dsh.profile.bundles` 末尾加载，持久生效；
- 卸载：`plugin_manager remove_bundle`（或 profile 里移除 `dsh-opg-session-header`），适配器钩子会被 disposer 还原。

## 配置

`cordis.patch.yml` 默认插入一行，可在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: opg-session-header
  config:
    enabled: true             # false = 挂载但不注入
    value: auto               # auto | uuid | id
    sessionlessFallback: true # 无 sessionId 时借发起会话 id（自动审查依赖它）
```

- **路由范围是代码常量** `opencode-go*`（大小写不敏感）：`opencode-go`、`opencode-go-custom` 进；
  `opencode-zen`、`my-opencode-go`、`deepseek` 一个字节都不动。故意不提供 `routes:` 配置，避免写错范围把
  网关专用头发给别的 provider。
- `value`：
  - `auto`（默认）：`openai-responses` 发原始 `session-<uuid>`（与 pi-ai 自带 `session_id` 对齐，避免一个
    会话裂成两个缓存桶）；其它协议发裸 UUID；
  - `uuid`：裸 UUID；`id`：原始 `session-<uuid>`。

## 诊断

只读端点（同源、需登录，复用 dsh 的 `connection.requestRejection`）：

```text
GET https://<dsh-web>/opg-session-header/status
```

或本机脚本（用 dsh 自己的 browser-session 密钥临时签 cookie，不打印密钥）：

```bash
node scripts/status.mjs
```

返回关键字段：

```json
{
  "hooked": { "adapters": 1, "prototypes": 1, "routesInScope": ["opencode-go"] },
  "counters": { "calls": 30, "scoped": 30, "attached": 30, "inherited": 1, "sessionless": 0 },
  "diagnostics": []
}
```

- `hooked.adapters >= 1`：适配器已挂上；`routesInScope` 应包含 `opencode-go`；
- 主 agent 调用：`attached` 增长；
- 自动审查等无 sessionId 调用：`inherited` 增长、`sessionless` 保持 0（说明回退拿到了会话 id）；
- `sessionless` 增长说明有调用没拿到会话 id（回退未命中，需要排查）。

## 验证

```bash
node --test test/*.test.mjs        # 19 项：核心单测 + 真实 PiAiAdapter 集成测试
node scripts/verify-gateway.mjs    # 直连网关：缺头 400 MissingSessionID / 带头 200
node scripts/status.mjs            # 已安装插件的实时计数
```

完整记录（含实机自动审查路径探针）见 [docs/03-验证记录.md](docs/03-验证记录.md)。

## 目录

```text
package.json          bundle 清单（dsh.bundle.patch 指向 cordis.patch.yml）
cordis.patch.yml      插入 opg-session-header 一行
lib/index.js          Host 半边：注入、适配器扫描、诊断端点
lib/session-header.js 核心：范围/取值/合并/适配器钩子/状态
test/                 core.test.mjs（单测）、adapter.test.mjs（真实适配器）
scripts/              verify-gateway.mjs、status.mjs、credentials.mjs
locale/ icon.svg      插件管理器的展示元数据
docs/                 调研对比、设计与实现、验证记录、项目记忆
```

## 与两个参考插件的关系

- **`mathangler/dsh-opencode-session-header`**：本插件的主要参考。相同的 adapter 分发点 + initiator 回退
  机制；本实现按本机场景重写、裁剪，并补了本地诊断端点与前端契约断言，MIT 归属见 [LICENSE](LICENSE)。
- **`DMIAOCHEN/dsh-auto-review-plus`**：另一条路线——fork 官方自动审查、把 `sessionId` 直接写进评审请求，
  并加审查模型选择器。它更接近根因，但需要停用官方行、带 client 半边，且 peer 钉在 `0.2.0-rc.2`，装进
  `0.2.1-rc.2` 前必须改 peer 与 cwd 逻辑后重新构建。两者对比与选择理由见
  [docs/01-插件调研与对比.md](docs/01-插件调研与对比.md)。

## 已知边界

- 依赖两个 TypeScript `private` 内部面：`ctx.llm.adapters` 与 `PiAiAdapter#streamWithSnapshot`。dsh 升级若
  重命名它们，插件会挂不上并在 `diagnostics`/`routesInScope` 里报出来（不是启动崩溃），按提示更新即可。
- 只作用于 route key 以 `opencode-go` 开头的调用；如果以后把 provider 改名，需要同步改
  `lib/session-header.js` 的 `SCOPED_ROUTE_PREFIX`。
- 头值来自会话 id，不含任何凭据；诊断端点需要登录且只读。
- `400 MissingSessionID` 是 OpenCode Go 网关的行为；额度耗尽、`model_coming_soon`、429 等错误不在本插件
  职责范围内。
