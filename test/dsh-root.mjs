/**
 * 定位本机真实安装的 DSH 包根目录，供集成测试读取真实适配器。
 *
 * DSH_ROOT 优先；否则假定全局安装把 @deepseek-ai/dsh 放在 node 可执行文件旁边。
 *
 * @module dsh-opg-session-header/test/dsh-root
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * @returns {string} DSH 包根目录的绝对路径。
 * @throws 找不到时。
 */
export function resolveDshRoot() {
  const candidates = [
    process.env.DSH_ROOT,
    // Linux/nvm 全局安装：<prefix>/bin/node + <prefix>/lib/node_modules
    join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    // Windows/npm 全局安装：<prefix>/node.exe + <prefix>/node_modules
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'),
    join(dirname(process.execPath), '..', 'node_modules', '@deepseek-ai', 'dsh'),
    join('/usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    join('/usr', 'local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const root of candidates) {
    if (existsSync(join(root, 'lib', 'bin.js'))) return root;
  }
  throw new Error(`could not locate the DSH install; tried:\n  ${candidates.join('\n  ')}`);
}

/**
 * 一个已安装 DSH 包的入口文件绝对路径。
 *
 * @param {string} dshRoot DSH 包根目录。
 * @param {...string} segments node_modules 下的路径段。
 * @returns {string}
 */
export function dshPackageFile(dshRoot, ...segments) {
  return join(dshRoot, 'node_modules', ...segments);
}
