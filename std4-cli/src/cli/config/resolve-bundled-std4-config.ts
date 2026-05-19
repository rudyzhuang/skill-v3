import fs from 'node:fs';
import path from 'node:path';

/**
 * 与 PRD / 构建约定一致：内置副本位于 CLI 安装根目录 `bundled/std4-config.env`。
 */
export const BUNDLED_STD4_REL_PATH = path.join('bundled', 'std4-config.env');

/**
 * 解析内置 `bundled/std4-config.env` 的绝对路径（不检查存在性）。
 */
export function resolveBundledStd4ConfigPath(cliInstallRoot: string): string {
  return path.resolve(cliInstallRoot, BUNDLED_STD4_REL_PATH);
}

/**
 * 若安装根缺少内置文件则抛出；错误消息仅含路径，不含文件内容或密钥。
 */
export function assertBundledStd4ConfigReadable(cliInstallRoot: string): string {
  const abs = resolveBundledStd4ConfigPath(cliInstallRoot);
  try {
    fs.accessSync(abs, fs.constants.R_OK);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const code = e.code ?? 'ERR';
    throw new Error(
      `bundled std4 config missing or unreadable (path=${abs}, errno=${code})`
    );
  }
  return abs;
}
