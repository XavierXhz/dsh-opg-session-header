/**
 * 集成测试：对着**本机真实安装**的 `@deepseek-ai/dsh-llm-pi-ai` 适配器与 pi-ai 的
 * `fauxProvider` 测试缝，验证头真的落进 pi-ai 收到的 `SimpleStreamOptions.headers`
 * ——也就是 pi-ai 协议实现最后合并进 HTTP client 的同一张 map。
 *
 * 同一适配器、同一路由、同一会话先跑一次「未挂插件」的对照，再跑挂载后的调用，
 * 保证断言不是环境自带行为。
 *
 * 运行：node --test test/   （DSH_ROOT 可指向另一份 dsh 安装）
 *
 * @module dsh-opg-session-header/test/adapter
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createSessionHeader, HEADER_NAME } from '../lib/session-header.js';
import { dshPackageFile, resolveDshRoot } from './dsh-root.mjs';

const SESSION = 'session-05681fd4-1667-4f46-874f-11fd7f10abbe';
const UUID = '05681fd4-1667-4f46-874f-11fd7f10abbe';
const OTHER = 'session-11111111-2222-3333-4444-555555555555';

const DSH_ROOT = resolveDshRoot();
const pi = await import(pathToFileURL(dshPackageFile(DSH_ROOT, '@earendil-works', 'pi-ai', 'dist', 'index.js')).href);
const { PiAiAdapter } = await import(pathToFileURL(dshPackageFile(DSH_ROOT, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')).href);

/**
 * 一个记录请求 options 的 faux provider。
 *
 * @param {string} id route key。
 * @param {string} api wire protocol。
 * @returns {{provider: any, take: () => any, calls: () => number, model: any}}
 */
function probe(id, api) {
  const faux = pi.fauxProvider({ provider: id, api, models: [{ id: 'probe-model' }] });
  let captured;
  let calls = 0;
  const recorder = (_context, options) => {
    calls += 1;
    captured = options?.headers;
    return pi.fauxAssistantMessage('ok');
  };
  faux.setResponses(Array.from({ length: 16 }, () => recorder));
  const model = faux.getModel('probe-model');
  model.provider = id;
  model.api = api;
  return { provider: faux.provider, model, take: () => captured, calls: () => calls };
}

/** 适配器读取的 profile 形状。 */
function profile(routeId, provider) {
  return {
    provider: routeId,
    displayName: routeId,
    streamIdleTimeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1 },
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider: provider,
  };
}

/** 形如 llm 运行时 route map 的注册表。 */
function registryOf(adapter, routes) {
  return new Map(routes.map((id) => [id, { adapter, provider: { id, name: id }, retryPolicy: {} }]));
}

/**
 * 用真实适配器搭一台测试台，按插件的方式扫描后返回驱动。
 *
 * @param {Array<[string, string]>} routes [routeId, api] 对，全部由同一适配器实例承载。
 * @param {unknown} raw 插件配置。
 * @param {{fallback?: () => string|undefined}} [internals]
 */
function harness(routes, raw, internals = {}) {
  const probes = new Map(routes.map(([id, api]) => [id, probe(id, api)]));
  const profiles = new Map(routes.map(([id]) => [id, profile(id, probes.get(id).provider)]));
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('probe-key'),
  });
  const core = createSessionHeader(raw, internals);
  const hooked = core.hookRegistry(registryOf(adapter, routes.map(([id]) => id)));
  return {
    adapter,
    core,
    hooked,
    /** 像 llm 运行时那样排空一次模型调用。 */
    async turn(routeId, sessionId) {
      for await (const _chunk of adapter.stream({
        provider: routeId,
        model: 'probe-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(10_000),
        ...(sessionId === undefined ? {} : { sessionId }),
      })) {
        // 排空即触发请求。
      }
    },
    headersFor(routeId) {
      return probes.get(routeId).take();
    },
    callsFor(routeId) {
      return probes.get(routeId).calls();
    },
  };
}

test('本机真实适配器与 pi-ai 测试缝可用', () => {
  assert.equal(typeof PiAiAdapter, 'function', 'PiAiAdapter 必须是已安装 bundle 里的构造函数');
  assert.equal(typeof pi.fauxProvider, 'function', 'pi-ai 必须暴露 fauxProvider');
});

test('对照 → 挂载：只有插件改变请求头', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], undefined);
  t.after(() => app.core.dispose());
  assert.equal(app.hooked, 1, '已安装适配器是 pi-ai 形状且可挂');

  app.core.dispose();
  await app.turn('opencode-go', SESSION);
  assert.equal(app.callsFor('opencode-go'), 1, 'faux provider 真的服务了这次调用');
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined, '对照：环境自身不加这个头');
  assert.equal(String(app.headersFor('opencode-go')['user-agent']).startsWith('deepseek-harness/'), true, 'Harness 归因头仍在');

  app.core.hookRegistry(registryOf(app.adapter, ['opencode-go']));
  await app.turn('opencode-go', SESSION);
  assert.equal(app.callsFor('opencode-go'), 2, '第二次调用也真的发生了');
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID, '真实调用现在带上了会话头');
  assert.equal(app.core.status().counters.attached, 1);
});

test('所有 opencode-go… 路由与协议都被覆盖', async () => {
  const cases = [
    ['opencode-go', 'anthropic-messages', UUID],
    ['opencode-go-custom', 'openai-completions', UUID],
    ['opencode-go-eu', 'openai-completions', UUID],
    ['opencode-go-custom', 'openai-responses', SESSION],
    ['opencode-go', 'openai-responses', SESSION],
  ];
  for (const [routeId, api, expected] of cases) {
    const app = harness([[routeId, api]], undefined);
    try {
      await app.turn(routeId, SESSION);
      assert.equal(app.headersFor(routeId)[HEADER_NAME], expected, `${routeId} / ${api}`);
    } finally {
      app.core.dispose();
    }
  }
});

test('前缀边界：兄弟路由进、邻居路由一个字节都不动', async (t) => {
  const routes = [
    ['opencode-go', 'openai-completions'],
    ['opencode-go-eu', 'openai-completions'],
    ['opencode-zen', 'openai-completions'],
    ['my-opencode-go', 'openai-completions'],
    ['deepseek', 'openai-completions'],
  ];
  const app = harness(routes, undefined);
  t.after(() => app.core.dispose());
  assert.equal(app.hooked, 1, '一个适配器承载五条路由');
  for (const [routeId] of routes) await app.turn(routeId, SESSION);
  for (const routeId of ['opencode-go', 'opencode-go-eu']) {
    assert.equal(app.headersFor(routeId)[HEADER_NAME], UUID, `${routeId} 在范围内`);
  }
  for (const routeId of ['opencode-zen', 'my-opencode-go', 'deepseek']) {
    assert.equal(app.headersFor(routeId)[HEADER_NAME], undefined, `${routeId} 不能被加头`);
  }
  const counters = app.core.status().counters;
  assert.equal(counters.attached, 2);
  assert.equal(counters.outOfScope, 3);
});

test('无 sessionId 的辅助调用：只有 fallback 打开时才借发起会话 id', async (t) => {
  const app = harness([['opencode-go', 'anthropic-messages']], undefined);
  t.after(() => app.core.dispose());

  // (a) 核心自身没有 initiator 缝：不伪造任何值。
  await app.turn('opencode-go', undefined);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined);
  assert.equal(app.core.status().counters.sessionless, 1);
  app.core.dispose();

  // (b) 宿主层把 agents.currentInitiator() 接成 fallback；这里用 stub 模拟。
  const withFallback = createSessionHeader(undefined, { fallback: () => SESSION });
  t.after(() => withFallback.dispose());
  withFallback.hookRegistry(registryOf(app.adapter, ['opencode-go']));
  await app.turn('opencode-go', undefined);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID, '借的是真实发起会话 id，不是伪造值');
  assert.equal(withFallback.status().counters.inherited, 1);
  assert.equal(withFallback.status().counters.last.source, 'initiator');
  withFallback.dispose();

  // (c) 关闭 fallback：缝永远不被咨询。
  const refused = createSessionHeader({ sessionlessFallback: false }, { fallback: () => SESSION });
  t.after(() => refused.dispose());
  refused.hookRegistry(registryOf(app.adapter, ['opencode-go']));
  await app.turn('opencode-go', undefined);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined);
  assert.equal(refused.status().counters.inherited, 0);
  assert.equal(refused.status().counters.sessionless, 1);
});

test('agent loop 用的 prepareCall 路径也被覆盖', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], undefined);
  t.after(() => app.core.dispose());
  const prepared = await app.adapter.prepareCall('opencode-go', 'probe-model');
  assert.equal(typeof prepared.stream, 'function');
  for await (const _chunk of prepared.stream({
    provider: 'opencode-go',
    model: 'probe-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: AbortSignal.timeout(10_000),
    sessionId: SESSION,
  })) {
    // 排空。
  }
  assert.equal(app.callsFor('opencode-go'), 1);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID);
});

test('两个会话两个值；重复扫描不叠 wrapper', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], undefined);
  t.after(() => app.core.dispose());
  app.core.hookRegistry(registryOf(app.adapter, ['opencode-go']));
  assert.equal(app.core.status().hooked.adapters, 1);
  await app.turn('opencode-go', SESSION);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID);
  await app.turn('opencode-go', OTHER);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], '11111111-2222-3333-4444-555555555555');
  assert.equal(app.core.status().counters.attached, 2);
});

test('dispose 后真实适配器上不再有头', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], undefined);
  t.after(() => app.core.dispose());
  await app.turn('opencode-go', SESSION);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID);
  app.core.dispose();
  await app.turn('opencode-go', SESSION);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined);
});

test('enabled: false 在真实适配器上也完全惰性', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], { enabled: false });
  t.after(() => app.core.dispose());
  await app.turn('opencode-go', SESSION);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined);
  assert.equal(app.core.status().counters.outOfScope, 1);
});
