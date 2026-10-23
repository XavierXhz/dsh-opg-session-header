/**
 * dsh-opg-session-header — core.
 *
 * 本部署（web profile）用 pi-ai 的 `opencode-go` 路由访问 OpenCode Go 网关。
 * pi-ai 1.3.0 会从 `GenerateOptions.sessionId` 生成 `x-opencode-session`，
 * 但 dsh 的官方自动审查（`@deepseek-ai/dsh-experimental-auto-review`）自己拼
 * `ctx.llm.stream(options)` 时**不传 sessionId**，所以评审请求仍然会被网关以
 * `400 MissingSessionID` 拒绝。
 *
 * 本模块把注入点放在 pi-ai 适配器的唯一分发口：
 *
 *   PiAiAdapter#streamWithSnapshot(options, snapshot)
 *     └─ snapshot.models.streamSimple(model, context, options)
 *          └─ pi-ai 把 options.headers 合并进 HTTP 请求头（最后一步）
 *
 * 因为判定按 **每次模型调用** 做，而不是按调用方，所以：
 *   - 主 agent 调用（自带 sessionId）→ 原样用会话 id；
 *   - 自动审查等辅助调用（不带 sessionId）→ 用 `currentInitiator()` 借发起会话 id；
 *   - 其它路由（deepseek / opencode-zen / my-opencode-go…）→ 一个字节都不动。
 *
 * 本文件不导入任何包：宿主插件由 profile 以链接方式装载，裸依赖会在加载期失败。
 *
 * 实现参考了 MIT 许可的 mathangler/dsh-opencode-session-header 的分发点注入与
 * 会话回退思路；本文件是针对本部署重写、裁剪并补充本地诊断的版本。
 *
 * @module dsh-opg-session-header/session-header
 */

/** 网关要求的头名。 */
export const HEADER_NAME = 'x-opencode-session';

/** 固定路由范围：只有这个前缀开头的 route 会被注入。 */
export const SCOPED_ROUTE_PREFIX = 'opencode-go';

/** 状态报告里显示的范围形式。 */
export const SCOPED_ROUTE_PATTERN = `${SCOPED_ROUTE_PREFIX}*`;

/** 这些 wire protocol 自己就发 `session_id: session-<uuid>`，用原始 id 可避免分桶。 */
const NATIVE_SESSION_APIS = new Set(['openai-responses']);

/** 合法取值模式。 */
const VALUE_MODES = new Set(['auto', 'uuid', 'id']);

/** 合法配置键；未知键直接报错，避免拼写错误看起来像「插件没生效」。 */
const CONFIG_KEYS = new Set(['enabled', 'value', 'sessionlessFallback']);

/** DSH session id 自带 `session-` 前缀；它不是网关值的一部分。 */
const SESSION_PREFIX_RE = /^session-/;

/** 状态报告保留多少条最近诊断。 */
const DIAGNOSTIC_LIMIT = 20;

/** 带稳定错误码的配置/注入错误。 */
export class SessionHeaderError extends Error {
  /**
   * @param {string} code 稳定机器码。
   * @param {string} message 人类可读描述。
   */
  constructor(code, message) {
    super(message);
    this.name = 'SessionHeaderError';
    this.code = code;
  }
}

/** 随包默认配置。 */
export function defaultConfig() {
  return {
    enabled: true,
    value: 'auto',
    sessionlessFallback: true,
  };
}

/** 断言一个配置值是布尔。 */
function requireBoolean(key, value) {
  if (typeof value !== 'boolean') {
    throw new SessionHeaderError(
      'opg-session-header/invalid-config',
      `config.${key} must be a boolean, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * 校验原始配置并合并默认值。未知键报错并说明范围固定。
 *
 * @param {unknown} raw loader 传入的配置（可能为 undefined）。
 * @returns {{enabled: boolean, value: 'auto'|'uuid'|'id', sessionlessFallback: boolean}}
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new SessionHeaderError(
      'opg-session-header/invalid-config',
      `config must be an object, got ${JSON.stringify(raw)}`,
    );
  }
  const config = defaultConfig();
  if (raw === undefined || raw === null) return config;
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new SessionHeaderError(
        'opg-session-header/invalid-config',
        `unknown config key ${JSON.stringify(key)}; configurable keys: ${[...CONFIG_KEYS].join(', ')}. `
        + `The route scope is fixed: every route beginning with ${SCOPED_ROUTE_PREFIX} (${SCOPED_ROUTE_PATTERN}) receives ${HEADER_NAME}.`,
      );
    }
  }
  if (raw.enabled !== undefined) config.enabled = requireBoolean('enabled', raw.enabled);
  if (raw.sessionlessFallback !== undefined) {
    config.sessionlessFallback = requireBoolean('sessionlessFallback', raw.sessionlessFallback);
  }
  if (raw.value !== undefined) {
    if (typeof raw.value !== 'string' || !VALUE_MODES.has(raw.value)) {
      throw new SessionHeaderError(
        'opg-session-header/invalid-config',
        `config.value must be one of ${[...VALUE_MODES].join(', ')}, got ${JSON.stringify(raw.value)}`,
      );
    }
    config.value = raw.value;
  }
  return config;
}

/**
 * 该 route 是否在固定范围内。大小写不敏感的前缀判定。
 *
 * @param {unknown} provider 模型描述符上的 route key。
 * @returns {boolean}
 */
export function isScopedRoute(provider) {
  return typeof provider === 'string' && provider.toLowerCase().startsWith(SCOPED_ROUTE_PREFIX);
}

/**
 * 一次调用应携带的头名；不在范围内返回 undefined。
 *
 * @param {{provider?: string}|null|undefined} model pi-ai 模型描述符。
 * @param {ReturnType<typeof defaultConfig>} config 已解析配置。
 * @returns {string|undefined}
 */
export function headerNameFor(model, config) {
  if (!config.enabled) return undefined;
  return isScopedRoute(model?.provider) ? HEADER_NAME : undefined;
}

/**
 * 会话 id → 头值。
 *
 * - `uuid`：裸 UUID（网关文档写法）；
 * - `id`：原始 `session-<uuid>`；
 * - `auto`：协议自己会发 session 头（openai-responses）时用原始 id，避免一个会话
 *   被拆成两个路由桶；其它协议用裸 UUID。
 *
 * @param {string} sessionId
 * @param {unknown} api
 * @param {'auto'|'uuid'|'id'} mode
 * @returns {string}
 */
export function sessionHeaderValue(sessionId, api, mode) {
  const raw = String(sessionId);
  if (mode === 'id') return raw;
  const bare = raw.replace(SESSION_PREFIX_RE, '');
  if (mode === 'uuid') return bare;
  return NATIVE_SESSION_APIS.has(typeof api === 'string' ? api : '') ? raw : bare;
}

/** 把值截短，状态报告是给人看的。 */
function mask(value) {
  const text = String(value);
  return text.length <= 14 ? text : `${text.slice(0, 14)}…`;
}

/** 大小写不敏感地删除一个头字段，不修改原对象。 */
function withoutField(headers, name) {
  const target = name.toLowerCase();
  const kept = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * 把会话头合并进一次调用的 options。
 *
 * 返回值永远是浅拷贝：适配器自己的请求对象不会被修改。同名静态头会被替换而
 * 不是并存（大小写不敏感），与 dsh 自己合并头的方式一致。
 *
 * @param {any} model pi-ai 模型描述符。
 * @param {any} options 适配器构建的 SimpleStreamOptions。
 * @param {ReturnType<typeof defaultConfig>} config
 * @param {ReturnType<typeof createStats>} stats
 * @param {(() => string|undefined)|undefined} fallback 无 sessionId 时借用会话 id 的取值器。
 * @returns {any} 交给 pi-ai 的 options。
 */
export function applySessionHeader(model, options, config, stats, fallback) {
  stats.calls += 1;
  const name = headerNameFor(model, config);
  if (name === undefined) {
    stats.outOfScope += 1;
    return options;
  }
  stats.scoped += 1;

  let sessionId = options?.sessionId;
  let source = 'request';
  if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
    const inherited = config.sessionlessFallback && typeof fallback === 'function' ? fallback() : undefined;
    if (inherited === undefined || inherited === null || String(inherited) === '') {
      // 没有可命名的会话：保留部署的静态头原样，不伪造值。
      stats.sessionless += 1;
      return options;
    }
    sessionId = inherited;
    source = 'initiator';
    stats.inherited += 1;
  }

  const value = sessionHeaderValue(sessionId, model?.api, config.value);
  const base = options !== null && typeof options === 'object' ? options : {};
  const headers = { ...withoutField(base.headers ?? {}, name), [name]: value };
  stats.attached += 1;
  stats.last = {
    at: new Date().toISOString(),
    provider: typeof model?.provider === 'string' ? model.provider : undefined,
    api: typeof model?.api === 'string' ? model.api : undefined,
    header: name,
    value: mask(value),
    source,
  };
  return { ...base, headers };
}

/** 全新计数器；纯 number，状态报告可 JSON 化。 */
export function createStats() {
  return {
    calls: 0,
    scoped: 0,
    attached: 0,
    sessionless: 0,
    inherited: 0,
    outOfScope: 0,
    last: undefined,
  };
}

/** 记录钩子的 Symbol 键：对枚举不可见，第二次挂载是 no-op。 */
const MODELS_HOOK = Symbol.for('dsh-opg-session-header/models');
const ADAPTER_HOOK = Symbol.for('dsh-opg-session-header/adapter');

/**
 * 包住一个 pi-ai model collection 的 `streamSimple`——请求头 map 还是参数的最后
 * 一个位置。用 Symbol.for 记录状态，保证幂等与可还原。
 *
 * @param {any} models 适配器分发用的 model collection。
 * @param {(model: any, options: any) => any} decide 每次调用的变换。
 * @returns {any} 钩子记录；对象形状不对时返回 undefined。
 */
export function instrumentModels(models, decide) {
  if (models === null || typeof models !== 'object' || typeof models.streamSimple !== 'function') return undefined;
  const existing = models[MODELS_HOOK];
  if (existing !== undefined) return existing;
  const hadOwn = Object.prototype.hasOwnProperty.call(models, 'streamSimple');
  const previous = models.streamSimple;
  const record = {
    previous,
    hadOwn,
    decide,
    wrapped(model, context, options) {
      return previous.call(this, model, context, decide(model, options));
    },
    restore() {
      if (models[MODELS_HOOK] !== record) return;
      if (hadOwn) models.streamSimple = previous;
      else delete models.streamSimple;
      delete models[MODELS_HOOK];
    },
  };
  Object.defineProperty(models, MODELS_HOOK, { value: record, configurable: true, writable: true });
  models.streamSimple = record.wrapped;
  return record;
}

/**
 * 包住一个适配器的 `streamWithSnapshot`。llm 运行时所有入口最终都走这里，
 * 所以挂这里就能覆盖每条模型调用，不需要读适配器内部。
 *
 * 「已挂过」检查沿原型链查：类已经被挂过时，实例调用会走到类包装，不再叠加。
 *
 * @param {any} adapter 适配器实例或原型。
 * @param {(model: any, options: any) => any} decide
 * @param {((models: any) => void)|undefined} onCollection 每挂到一个 collection 时通知。
 * @returns {any} 钩子记录；对象形状不对时返回 undefined。
 */
export function instrumentAdapter(adapter, decide, onCollection) {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.streamWithSnapshot !== 'function') return undefined;
  const existing = adapter[ADAPTER_HOOK];
  if (existing !== undefined) return existing;
  const hadOwn = Object.prototype.hasOwnProperty.call(adapter, 'streamWithSnapshot');
  const previous = adapter.streamWithSnapshot;
  const touched = new Set();
  const record = {
    previous,
    hadOwn,
    wrapped(options, snapshot) {
      if (snapshot !== null && typeof snapshot === 'object' && snapshot.models !== undefined) {
        const models = snapshot.models;
        const modelsRecord = instrumentModels(models, decide);
        if (modelsRecord !== undefined && modelsRecord.decide === decide) {
          touched.add(models);
          if (typeof onCollection === 'function') onCollection(models);
        }
      }
      return previous.call(this, options, snapshot);
    },
    restore() {
      if (adapter[ADAPTER_HOOK] !== record) return;
      if (hadOwn) adapter.streamWithSnapshot = previous;
      else delete adapter.streamWithSnapshot;
      delete adapter[ADAPTER_HOOK];
      for (const models of touched) {
        if (models[MODELS_HOOK]?.decide === decide) models[MODELS_HOOK].restore();
      }
      touched.clear();
    },
  };
  Object.defineProperty(adapter, ADAPTER_HOOK, { value: record, configurable: true, writable: true });
  adapter.streamWithSnapshot = record.wrapped;
  return record;
}

/**
 * 构建插件核心：每次调用的变换、适配器扫描、状态报告、一个还原所有对象的 disposer。
 *
 * @param {unknown} raw 原始配置。
 * @param {{fallback?: () => string|undefined, log?: (level: string, message: string) => void}} [internals]
 * @returns {ReturnType<typeof createSessionHeader>}
 */
export function createSessionHeader(raw, internals = {}) {
  const config = resolveConfig(raw);
  const stats = createStats();
  const buffer = [];
  const adapters = new Set();
  const prototypes = new Map();
  const collections = new Set();
  /** 最近一次扫描时注册表里的所有 route key。 */
  const routesSeen = new Set();
  const log = typeof internals.log === 'function' ? internals.log : () => {};

  /** 记录一条诊断到状态报告和日志。 */
  function diagnose(level, message) {
    const entry = { at: new Date().toISOString(), level, message };
    buffer.push(entry);
    while (buffer.length > DIAGNOSTIC_LIMIT) buffer.shift();
    try {
      log(level, message);
    } catch {
      // 日志汇不能破坏模型路径。
    }
  }

  const decide = (model, options) => applySessionHeader(model, options, config, stats, internals.fallback);

  /**
   * 扫描 llm 注册表的 route map 并挂适配器。
   *
   * map 形如 `route → { adapter, provider, retryPolicy }`。所有 pi-ai 形状的适配器
   * 都挂（范围逐调用判定，不按适配器），非 pi-ai 形状原样不动。
   *
   * @param {any} registry llm 运行时的 route map。
   * @returns {number} 本次扫描挂到的不同适配器实例数。
   */
  function hookRegistry(registry) {
    if (registry instanceof Map) {
      for (const route of registry.keys()) routesSeen.add(String(route));
    } else {
      diagnose('error', 'llm 注册表没有暴露 route map，无法挂适配器，x-opencode-session 不会被添加');
      return 0;
    }
    const instances = new Set();
    for (const registration of registry.values()) {
      const adapter = registration?.adapter;
      if (adapter === null || adapter === undefined || typeof adapter !== 'object') continue;
      if (typeof adapter.streamWithSnapshot !== 'function') continue;
      const record = instrumentAdapter(adapter, decide, (models) => collections.add(models));
      if (record === undefined) continue;
      adapters.add(adapter);
      instances.add(adapter);
      const prototype = Object.getPrototypeOf(adapter);
      if (prototype !== null && prototype !== undefined && prototype !== Object.prototype && !prototypes.has(prototype)) {
        // HMR 之后新建的实例也必须覆盖，所以类也挂一层。
        const prototypeRecord = instrumentAdapter(prototype, decide, (models) => collections.add(models));
        if (prototypeRecord !== undefined) prototypes.set(prototype, prototypeRecord);
      }
    }
    const swept = instances.size;
    if (swept > 0 && ![...routesSeen].some((route) => isScopedRoute(route))) {
      diagnose(
        'warn',
        `llm 注册表里没有以 ${SCOPED_ROUTE_PREFIX} 开头的 route；当前 route: ${[...routesSeen].join(', ') || '（空）'}，头会一直保持关闭`,
      );
    }
    return swept;
  }

  return {
    config,
    stats,
    decide,
    hookRegistry,
    diagnose,

    /**
     * 诊断端点背后的 JSON 状态：回答「头到底加没加」与「范围是否覆盖我用到的路由」。
     * @returns {any}
     */
    status() {
      const preview = [];
      for (const route of [SCOPED_ROUTE_PREFIX, `${SCOPED_ROUTE_PREFIX}-custom`, 'opencode-zen', 'deepseek']) {
        for (const api of ['openai-completions', 'anthropic-messages', 'openai-responses']) {
          const header = headerNameFor({ provider: route, api }, config);
          preview.push({
            route,
            api,
            header: header ?? null,
            value: header === undefined ? null : sessionHeaderValue('session-<uuid>', api, config.value),
          });
        }
      }
      return {
        name: 'dsh-opg-session-header',
        scope: [SCOPED_ROUTE_PATTERN],
        header: HEADER_NAME,
        config: { ...config },
        hooked: {
          adapters: adapters.size,
          prototypes: prototypes.size,
          collections: collections.size,
          routes: [...routesSeen].sort(),
          routesInScope: [...routesSeen].filter((route) => isScopedRoute(route)).sort(),
        },
        counters: { ...stats },
        preview,
        diagnostics: [...buffer],
      };
    },

    /** 按挂载的相反顺序还原碰过的每个对象。 */
    dispose() {
      for (const record of prototypes.values()) record.restore();
      prototypes.clear();
      for (const adapter of adapters) {
        const record = adapter[ADAPTER_HOOK];
        if (record !== undefined) record.restore();
      }
      adapters.clear();
    },
  };
}
