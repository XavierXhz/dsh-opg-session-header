# 一次性验证探针（不属于交付插件）

这个 fixture 用于在本机实机验证「官方自动审查的评审请求路径」是否已被插件补上头。它**不**放进
`cordis.patch.yml`，只在对 `web` profile 做一次临时安装时使用：

1. `plugin_manager install_bundle`，target 指向本目录绝对路径；
2. 在任意会话里触发一次工具调用（`tools/pre-execute` 会触发探针）；
3. 读 `/tmp/opg-autoreview-probe.json`：应看到 `"ok": true` 与 `"initiator": "<当前会话 id>"`；
4. 同时 `node scripts/status.mjs` 应看到 `counters.inherited` 增长、`counters.sessionless` 保持 0；
5. 验证完 `plugin_manager remove_bundle` 卸载本 fixture。

它会在 `tools/pre-execute`（与 `dsh-experimental-auto-review` 相同位置）发一条**无 sessionId** 的
`ctx.llm.stream`，正是自动审查评审请求的形态；因此 `ok: true` 等价于「评审请求到网关不再 400」。
