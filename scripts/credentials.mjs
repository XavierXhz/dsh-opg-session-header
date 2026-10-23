/**
 * 从 dsh 的凭据文件里读取一个值，避免给验证脚本引入 YAML 依赖。
 *
 * 只匹配 dsh 自己写出的稳定格式；找不到时返回 undefined，由调用方报错。
 *
 * @module dsh-opg-session-header/scripts/credentials
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** dsh home 下的凭据文件路径。 */
export function credentialsPath() {
  return process.env.DSH_CREDENTIALS ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml');
}

/**
 * 读 `refs.<NAME>`。
 *
 * @param {string} name 凭据引用名，如 OPENCODE_GO_API_KEY。
 * @returns {string|undefined}
 */
export function readRef(name) {
  const text = readFileSync(credentialsPath(), 'utf8');
  const match = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm').exec(text);
  return match?.[1];
}

/**
 * 读 client-connection browser-session 的签名密钥（base64url）。
 *
 * @returns {string|undefined}
 */
export function readBrowserSessionSecret() {
  const text = readFileSync(credentialsPath(), 'utf8');
  const blockStart = text.indexOf('client-connection/browser-session:');
  if (blockStart === -1) return undefined;
  const block = text.slice(blockStart);
  return /secret:\s*(\S+)/.exec(block)?.[1];
}
