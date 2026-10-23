/**
 * dsh-opg-session-header — host 半边。
 *
 * 一行 Cordis 插件（`name: 'dsh-opg-session-header'`）：给每条走 `opencode-go*`
 * 路由的推理请求补上**按会话稳定**的 `x-opencode-session` 头，让 OpenCode Go 网关
 * 不再返回 `400 MissingSessionID`，并让每个会话各占一个缓存桶。
 *
 * 与「补丁 globalThis.fetch + 从 llm/stream 的 options 取 sessionId」类插件的关
 * 键区别：本插件在 pi-ai 适配器的分发点注入，判定与调用方是否传 sessionId 无关；
 * 无 sessionId 的辅助调用（官方自动审查、session title 等）通过
 * `agents.currentInitiator()` 借发起会话的 id。这正是 dsh 官方 Auto review 在
 * 0.2.1-rc.2 上仍然会 400 的缺口。
 *
 * 安装后提供一个只读诊断端点 `GET /opg-session-header/status`（同源、需登录），
 * 返回计数器与已挂适配器，供升级后快速自检。
 *
 * @module dsh-opg-session-header
 */
import { createSessionHeader, HEADER_NAME, SCOPED_ROUTE_PATTERN } from './session-header.js';

/** 交给 loader 诊断的 Cordis 插件名。 */
const name = 'opg-session-header';

/**
 * `llm` 必须有，否则没有适配器注册表可挂；`webServer` / `connection` 是可选注入，
 * 没有 web 的组合仍然获得头，只是没有地方发布状态。
 */
const inject = ['llm'];

/** 本插件诊断端点的绝对路径前缀。 */
const CHANNEL = '/opg-session-header';

/** 唯一支持的端点段。 */
const ENDPOINT_RE = /^[A-Za-z0-9_$.-]+$/;

/** 适配器可能在插件挂载之后才注册；这是有界重扫的节奏（毫秒）。 */
const SWEEP_RETRY_MS = [250, 1000, 3000];

/** 成功信封。 */
const ok = (value) => ({ ok: true, value });

/** 失败信封。 */
const fail = (code, message) => ({ ok: false, error: { code, message } });

/** 写 JSON 响应；`no-store`，因为这是进程的即时事实。 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 从 service context 解析 llm 运行时的 route map。
 *
 * 该 map 不在 LLM service 的公开面上（方法只把 provider 枚举成元数据），所以从
 * Cordis 可能给的每个访问器防御性读取，并且只接受真正的 `Map`。
 *
 * @param {any} ctx 注入了 `llm` 的上下文。
 * @returns {Map<any, any>|undefined}
 */
export function resolveAdapterRegistry(ctx) {
  const candidates = [];
  const push = (getter) => {
    try {
      candidates.push(getter());
    } catch {
      // 会抛错的访问器（shadow context、已释放 service）不贡献候选。
    }
  };
  push(() => ctx.llm);
  if (typeof ctx.get === 'function') push(() => ctx.get('llm'));
  if (ctx.reflect !== undefined && typeof ctx.reflect.get === 'function') push(() => ctx.reflect.get('llm'));
  for (const service of candidates) {
    if (service !== null && typeof service === 'object' && service.adapters instanceof Map) return service.adapters;
  }
  return undefined;
}

/**
 * 宿主插件主体：解析策略、挂适配器、发布状态端点。
 *
 * @param {any} ctx 注入了 `llm` 的 Cordis 上下文。
 * @param {unknown} config loader 传入的配置，undefined 表示全默认。
 */
function apply(ctx, config) {
  /**
   * 正在进行的调用属于哪个会话。只在请求自己没有会话 id 时使用：辅助调用
   * （session title / compaction / 自动审查）仍然属于某个会话。懒注册，这样没有
   * agent 注册表的组合也能照常启动。
   */
  let initiator;
  ctx.inject(['agents'], (agentCtx) => {
    initiator = () => {
      try {
        const id = agentCtx.agents.currentInitiator()?.session?.id;
        return typeof id === 'string' ? id : undefined;
      } catch {
        return undefined;
      }
    };
  });

  const core = createSessionHeader(config, {
    fallback: () => (initiator === undefined ? undefined : initiator()),
    log: (level, message) => {
      const logger = ctx.logger;
      if (logger === undefined || logger === null) return;
      const line = `opg-session-header: ${message}`;
      if (level === 'error' && typeof logger.error === 'function') logger.error(line);
      else if (typeof logger.warn === 'function') logger.warn(line);
      else if (typeof logger.info === 'function') logger.info(line);
    },
  });

  const policy = core.config;

  /** 扫描一次并报告结果。 */
  function sweep() {
    const hooked = core.hookRegistry(resolveAdapterRegistry(ctx));
    if (hooked > 0 && ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
      ctx.logger.info(
        `opg-session-header: hooked ${hooked} pi-ai adapter${hooked === 1 ? '' : 's'}; `
        + `${HEADER_NAME} is added per conversation on ${SCOPED_ROUTE_PATTERN} models only`,
      );
    }
    return hooked;
  }

  const hooked = sweep();
  // route 由 llm 插件自己的 settings 解析注册，通常在本插件挂载之后才完成；
  // 事件是主信号，有界重扫只是兜底。
  ctx.on('llm/adapters-updated', () => sweep(), { global: true });
  if (hooked === 0) {
    const timers = SWEEP_RETRY_MS.map((delay) => setTimeout(() => sweep(), delay));
    ctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer);
    }, 'dsh-opg-session-header: sweep retries');
  }

  ctx.effect(() => () => core.dispose(), 'dsh-opg-session-header: adapter hooks');

  if (!policy.enabled) {
    core.diagnose('warn', 'disabled by configuration; no session header is added');
  } else if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
    ctx.logger.info(`opg-session-header: active (${HEADER_NAME} on ${SCOPED_ROUTE_PATTERN}, value mode ${policy.value})`);
  }

  // 诊断端点是可选的：没有 web server 的组合保留头，只是没地方发布状态。
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: async (req, res) => {
          // 平台自己的门禁先走：未认证或跨源调用者到不了 handler。
          const rejection = await webCtx.connection.requestRejection(req);
          if (rejection !== undefined && rejection !== null && rejection !== false && rejection !== 0) {
            res.statusCode = Number(rejection) || 401;
            res.end();
            return;
          }
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('allow', 'GET');
            res.end();
            return;
          }
          const pathname = new URL(String(req.url), 'http://localhost').pathname;
          const endpoint = pathname.slice(CHANNEL.length).replace(/^\//, '');
          if (!ENDPOINT_RE.test(endpoint) || endpoint !== 'status') {
            sendJson(res, 404, fail('opg-session-header/unknown-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`));
            return;
          }
          try {
            sendJson(res, 200, ok(core.status()));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 200, fail('opg-session-header/internal', message));
          }
        },
      }),
      `dsh-opg-session-header: ${CHANNEL} route`,
    );
  });
}

export { apply, inject, name, CHANNEL, SWEEP_RETRY_MS };
