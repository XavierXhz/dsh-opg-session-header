/**
 * 直接对 OpenCode Go 网关做一次最小请求对照，证明缺头是 400、带头是 200。
 *
 * 这是本插件要修复的「上游事实」的独立证据，不经过 dsh、不经过任何插件。
 *
 * 运行：
 *   node scripts/verify-gateway.mjs
 *   OPENCODE_GO_API_KEY=... node scripts/verify-gateway.mjs
 *
 * 默认从 <DSH_HOME>/.credentials.yaml 的 refs 读取 key，不打印任何凭据。
 * 每次请求 max_tokens=1，成本可忽略。
 *
 * @module dsh-opg-session-header/scripts/verify-gateway
 */
import { randomUUID } from 'node:crypto';
import { readRef } from './credentials.mjs';

const BASE_URL = process.env.OPENCODE_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const MODEL = process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4.1-flash';
const KEY = process.env.OPENCODE_GO_API_KEY ?? readRef('OPENCODE_GO_API_KEY');

if (KEY === undefined || KEY === '') {
  console.error('缺少 OpenCode Go API key：设置 OPENCODE_GO_API_KEY，或确认 dsh 凭据文件里有 refs.OPENCODE_GO_API_KEY');
  process.exit(2);
}

/** 发一次最小 chat completion，返回状态码与 JSON。 */
async function chat(headers) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'reply with the single word ok' }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

const withoutHeader = await chat({});
const withHeader = await chat({ 'x-opencode-session': randomUUID() });

const errorType = (result) => result.json?.error?.type ?? result.json?.error?.message ?? result.text.slice(0, 160);

console.log('gateway:', `${BASE_URL}/chat/completions`, 'model:', MODEL);
console.log('  无 x-opencode-session →', withoutHeader.status, errorType(withoutHeader));
console.log('  有 x-opencode-session →', withHeader.status, withHeader.status === 200 ? 'ok' : errorType(withHeader));

const pass = withoutHeader.status === 400
  && (errorType(withoutHeader) === 'MissingSessionID' || String(errorType(withoutHeader)).includes('MissingSessionID'))
  && withHeader.status === 200;
console.log(pass ? '结论：缺头 400 MissingSessionID，带头 200 —— 网关事实成立' : '结论：与预期不符，需要重新核对网关契约');
process.exit(pass ? 0 : 1);
