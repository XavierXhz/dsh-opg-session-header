/**
 * 核心逻辑单测：配置校验、范围判定、取值、合并、挂载幂等与还原。
 *
 * 运行：node --test test/
 *
 * @module dsh-opg-session-header/test/core
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADER_NAME,
  SCOPED_ROUTE_PATTERN,
  applySessionHeader,
  createSessionHeader,
  createStats,
  headerNameFor,
  isScopedRoute,
  resolveConfig,
  sessionHeaderValue,
} from '../lib/session-header.js';

const SESSION = 'session-05681fd4-1667-4f46-874f-11fd7f10abbe';
const UUID = '05681fd4-1667-4f46-874f-11fd7f10abbe';
const OTHER = 'session-11111111-2222-3333-4444-555555555555';

/** 一个 pi-ai 形状的最小适配器：把 streamWithSnapshot 落到 models.streamSimple。 */
function fakeAdapter(models) {
  return {
    streamWithSnapshot(options, snapshot) {
      const target = snapshot?.models ?? models;
      target.streamSimple({ provider: options.provider ?? 'opencode-go', api: 'openai-completions' }, {}, options);
    },
  };
}

test('默认配置与常量', () => {
  assert.deepEqual(resolveConfig(undefined), { enabled: true, value: 'auto', sessionlessFallback: true });
  assert.equal(SCOPED_ROUTE_PATTERN, 'opencode-go*');
  assert.equal(HEADER_NAME, 'x-opencode-session');
});

test('未知配置键报错，避免拼写错误被当成“没生效”', () => {
  assert.throws(() => resolveConfig({ routes: ['opencode*'] }), /unknown config key "routes"/);
  assert.throws(() => resolveConfig({ value: 'random' }), /config.value must be one of/);
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /config.enabled must be a boolean/);
  assert.throws(() => resolveConfig([]), /config must be an object/);
});

test('范围：opencode-go 前缀进，兄弟路由一个字节都不动', () => {
  for (const route of ['opencode-go', 'opencode-go-custom', 'opencode-go-eu', 'OpenCode-Go-Custom']) {
    assert.equal(isScopedRoute(route), true, route);
  }
  for (const route of ['opencode-zen', 'opencode', 'my-opencode-go', 'deepseek', '', undefined, 42]) {
    assert.equal(isScopedRoute(route), false, String(route));
  }
});

test('取值模式：auto 跟随协议，uuid/id 显式', () => {
  assert.equal(sessionHeaderValue(SESSION, 'openai-completions', 'auto'), UUID);
  assert.equal(sessionHeaderValue(SESSION, 'anthropic-messages', 'auto'), UUID);
  assert.equal(sessionHeaderValue(SESSION, 'openai-responses', 'auto'), SESSION);
  assert.equal(sessionHeaderValue(SESSION, 'openai-responses', 'uuid'), UUID);
  assert.equal(sessionHeaderValue(SESSION, 'openai-completions', 'id'), SESSION);
  assert.equal(sessionHeaderValue('bare-uuid', 'openai-completions', 'uuid'), 'bare-uuid');
});

test('带 sessionId 的调用：合并头、不改原 options', () => {
  const stats = createStats();
  const config = resolveConfig(undefined);
  const options = { sessionId: SESSION, headers: { 'user-agent': 'pi', 'X-Opencode-Session': 'stale' } };
  const next = applySessionHeader({ provider: 'opencode-go', api: 'openai-completions' }, options, config, stats);
  assert.equal(next.headers[HEADER_NAME], UUID, '同名旧头（大小写不同）被替换而不是并存');
  assert.equal(next.headers['user-agent'], 'pi');
  assert.notEqual(next, options);
  assert.equal(options.headers['X-Opencode-Session'], 'stale', '原对象保持不动');
  assert.equal(stats.attached, 1);
  assert.equal(stats.last.source, 'request');
});

test('无 sessionId：fallback 借用发起会话；关闭后不伪造', () => {
  const model = { provider: 'opencode-go', api: 'openai-completions' };
  const on = createStats();
  const withFallback = applySessionHeader(model, {}, resolveConfig(undefined), on, () => SESSION);
  assert.equal(withFallback.headers[HEADER_NAME], UUID);
  assert.equal(on.inherited, 1);

  const off = createStats();
  const noFallback = applySessionHeader(model, {}, resolveConfig({ sessionlessFallback: false }), off, () => SESSION);
  assert.equal(noFallback.headers?.[HEADER_NAME], undefined);
  assert.equal(off.inherited, 0);
  assert.equal(off.sessionless, 1);

  const none = createStats();
  const nothing = applySessionHeader(model, {}, resolveConfig(undefined), none, () => undefined);
  assert.equal(nothing.headers?.[HEADER_NAME], undefined);
  assert.equal(none.sessionless, 1);
});

test('范围外调用只计数，不修改 options', () => {
  const stats = createStats();
  const options = { sessionId: SESSION };
  const same = applySessionHeader({ provider: 'deepseek', api: 'openai-completions' }, options, resolveConfig(undefined), stats);
  assert.equal(same, options);
  assert.equal(stats.outOfScope, 1);
  assert.equal(headerNameFor({ provider: 'opencode-zen' }, resolveConfig(undefined)), undefined);
});

test('hookRegistry 跳过非 pi-ai 形状与非 Map 注册表', () => {
  const core = createSessionHeader(undefined);
  assert.equal(core.hookRegistry(new Map([['opencode-go', { adapter: { nope: true } }]])), 0);
  assert.equal(core.hookRegistry(undefined), 0);
  assert.equal(core.status().diagnostics.some((d) => d.level === 'error'), true, '不可达注册表要报错');
  core.dispose();
});

test('挂载幂等、覆盖 opencode-go 子路由、还原后不再注入', () => {
  const calls = [];
  const models = {
    streamSimple(model, context, options) {
      calls.push({ model, options });
      return options;
    },
  };
  const adapter = fakeAdapter(models);
  const core = createSessionHeader(undefined);
  assert.equal(core.hookRegistry(new Map([['opencode-go', { adapter }]])), 1);

  adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  core.hookRegistry(new Map([['opencode-go', { adapter }]]));
  adapter.streamWithSnapshot({ provider: 'opencode-go-custom', sessionId: OTHER }, { models });
  assert.equal(calls.length, 2, '两次调用只触发两次底层 streamSimple（没有叠 wrapper）');
  assert.equal(calls[0].options.headers[HEADER_NAME], UUID);
  assert.equal(calls[1].options.headers[HEADER_NAME], '11111111-2222-3333-4444-555555555555');
  assert.equal(core.status().counters.attached, 2);

  core.dispose();
  adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  assert.equal(calls[2].options.headers?.[HEADER_NAME], undefined, '卸载后不再注入');
});

test('状态报告形状', () => {
  const core = createSessionHeader(undefined);
  const status = core.status();
  assert.equal(status.name, 'dsh-opg-session-header');
  assert.deepEqual(status.scope, ['opencode-go*']);
  assert.equal(status.header, HEADER_NAME);
  assert.equal(status.hooked.adapters, 0);
  assert.equal(status.preview.some((row) => row.route === 'opencode-go' && row.header === HEADER_NAME), true);
  assert.equal(status.preview.some((row) => row.route === 'opencode-zen' && row.header === null), true);
  core.dispose();
});
