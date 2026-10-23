/**
 * 读取已安装插件的诊断端点（需要登录 cookie）。
 *
 * 用 dsh 自己的 browser-session 签名密钥临时签一个只读 cookie，然后 GET
 * `/opg-session-header/status`。只用于本机自检；不打印密钥与 cookie。
 *
 * 运行：
 *   node scripts/status.mjs
 *   node scripts/status.mjs --url https://127.0.0.1:3081 --path /opg-session-header/status
 *
 * @module dsh-opg-session-header/scripts/status
 */
import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:https';
import { readBrowserSessionSecret } from './credentials.mjs';

/** 解析 `--key value` / `--key=value`。 */
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const [key, inline] = item.slice(2).split('=', 2);
    out[key] = inline ?? argv[i + 1];
    if (inline === undefined) i += 1;
  }
  return out;
}

const options = args(process.argv.slice(2));
const url = new URL(options.url ?? process.env.DSH_WEB_URL ?? 'https://127.0.0.1:3081');
const path = options.path ?? '/opg-session-header/status';
const secretB64 = process.env.DSH_BROWSER_SECRET ?? readBrowserSessionSecret();

if (secretB64 === undefined || secretB64 === '') {
  console.error('找不到 browser-session 签名密钥：确认 dsh 凭据文件，或设置 DSH_BROWSER_SECRET');
  process.exit(2);
}

/** base64url 编码。 */
const b64 = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** 按 dsh-client-connection 的格式签一个 browser cookie。 */
function mintCookie(authority) {
  const secret = Buffer.from(secretB64.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const name = `dsh-auth-${b64(createHash('sha256').update(authority).digest())}`;
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 10 * 60_000 };
  const body = b64(JSON.stringify(payload));
  const signature = b64(createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${signature}`;
}

/** authority：https 用 origin，http 用 host（与 dsh 的 requestAudience 一致）。 */
const authority = url.protocol === 'https:' ? url.origin : url.host;
const cookie = mintCookie(authority);

const body = await new Promise((resolve, reject) => {
  const req = request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path,
      method: 'GET',
      headers: { cookie, accept: 'application/json' },
      rejectUnauthorized: false,
    },
    (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    },
  );
  req.on('error', reject);
  req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
  req.end();
});

console.log(`GET ${url.origin}${path} → ${body.status}`);
try {
  console.log(JSON.stringify(JSON.parse(body.text), null, 2));
} catch {
  console.log(body.text.slice(0, 2000));
}
process.exit(body.status === 200 ? 0 : 1);
