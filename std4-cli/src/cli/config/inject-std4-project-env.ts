import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertBundledStd4ConfigReadable, resolveBundledStd4ConfigPath } from './resolve-bundled-std4-config.js';

/**
 * 默认策略：每次注入均以 bundled 副本**完整覆盖**业务项目中的目标文件（幂等：重复执行内容与源一致）。
 * 若未来实现「仅缺失时写入」，须在此常量与 help 文案中可对齐核对。
 */
export const STD4_PROJECT_ENV_INJECT_MODE = 'always_overwrite_from_bundled' as const;

export type InjectLogger = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

export type InjectStd4ProjectEnvOptions = {
  /** CLI 安装根（含 `bundled/std4-config.env` 的目录） */
  cliInstallRoot: string;
  /** 业务项目根 */
  projectRoot: string;
  /**
   * 是否同步写入 `inputs/config.env`（与部分 ai-std4 辅助脚本的 inputs 优先策略对齐）。
   * 默认 `true`。
   */
  syncInputsConfigEnv?: boolean;
  logger?: InjectLogger;
};

function tmpName(prefix: string): string {
  return `${prefix}.tmp.${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * 将 `data` 原子写入 `finalPath`：同目录临时文件 fsync + rename。
 * 失败时尽力删除临时文件；错误信息不含密钥或 env 全文。
 */
function writeBufferWithFsync(filePath: string, data: Buffer): void {
  const fd = fs.openSync(filePath, 'w', 0o600);
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWriteFile(
  finalPath: string,
  data: Buffer,
  label: string
): void {
  const dir = path.dirname(finalPath);
  let tmpPath: string | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(
      `${label}: cannot create directory (path=${dir}, errno=${e.code ?? 'ERR'})`
    );
  }

  try {
    tmpPath = path.join(dir, tmpName(path.basename(finalPath)));
    writeBufferWithFsync(tmpPath, data);
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      throw new Error(
        `${label}: rename to destination failed (path=${finalPath}, errno=${e.code ?? 'ERR'})`
      );
    }
    tmpPath = null;
  } catch (err) {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
    if (err instanceof Error && err.message.startsWith(`${label}:`)) {
      throw err;
    }
    const e = err as NodeJS.ErrnoException;
    throw new Error(
      `${label}: write failed (path=${finalPath}, errno=${e.code ?? 'ERR'})`
    );
  }
}

/**
 * 从 CLI 安装根读取内置 `bundled/std4-config.env`，并同步注入业务项目的 `docs/config.env`
 *（可选 `inputs/config.env`）。日志/异常仅包含路径与 errno，不包含变量值。
 */
export function injectStd4ProjectEnv(options: InjectStd4ProjectEnvOptions): void {
  const { cliInstallRoot, projectRoot, syncInputsConfigEnv = true, logger } = options;

  const bundledPath = assertBundledStd4ConfigReadable(cliInstallRoot);
  let payload: Buffer;
  try {
    payload = fs.readFileSync(bundledPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(
      `read bundled std4 config failed (path=${resolveBundledStd4ConfigPath(
        cliInstallRoot
      )}, errno=${e.code ?? 'ERR'})`
    );
  }

  const docsEnv = path.join(projectRoot, 'docs', 'config.env');
  atomicWriteFile(docsEnv, payload, 'inject docs/config.env');
  logger?.info?.('std4 project env injected', {
    target: docsEnv,
    mode: STD4_PROJECT_ENV_INJECT_MODE,
  });

  if (syncInputsConfigEnv) {
    const inputsEnv = path.join(projectRoot, 'inputs', 'config.env');
    atomicWriteFile(inputsEnv, payload, 'inject inputs/config.env');
    logger?.info?.('std4 inputs config.env synced', {
      target: inputsEnv,
      mode: STD4_PROJECT_ENV_INJECT_MODE,
    });
  }
}

/** @internal 测试或 introspection：返回当前注入模式常量。 */
export function getStd4ProjectEnvInjectMode(): typeof STD4_PROJECT_ENV_INJECT_MODE {
  return STD4_PROJECT_ENV_INJECT_MODE;
}
