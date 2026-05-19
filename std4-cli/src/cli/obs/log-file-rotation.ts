/**
 * 滚动日志默认：单文件最大 5MiB，保留 3 个历史文件（*.1、*.2、*.3）。
 * 路径由 `--log-file` 显式指定；无默认值（不写文件则不创建）。
 */
import { closeSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

export type RotationOptions = {
  maxBytes?: number;
  keepFiles?: number;
};

export type RotatingFileSink = {
  writeLine: (line: string) => void;
  ensureOpen: () => Promise<Error | null>;
  close: () => Promise<void>;
  path: string;
};

function rotateIfNeededSync(filePath: string, maxBytes: number, keep: number): void {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return;
  }
  if (st.size < maxBytes) return;
  for (let i = keep; i >= 1; i--) {
    const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const to = `${filePath}.${i}`;
    try {
      renameSync(from, to);
    } catch {
      /* ignore */
    }
  }
}

export function createRotatingFileSink(
  filePath: string,
  opts: RotationOptions = {},
): RotatingFileSink {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepFiles = opts.keepFiles ?? DEFAULT_KEEP;
  let fd: number | null = null;
  let bytesInChunk = 0;

  const writeLine = (line: string): void => {
    if (fd === null) return;
    const buf = Buffer.from(line + '\n', 'utf8');
    try {
      writeSync(fd, buf);
      bytesInChunk += buf.length;
      if (bytesInChunk >= maxBytes) {
        closeSync(fd);
        fd = null;
        bytesInChunk = 0;
        rotateIfNeededSync(filePath, maxBytes, keepFiles);
        fd = openSync(filePath, 'a');
      }
    } catch {
      /* caller may detect via ensureOpen next time */
      try {
        if (fd !== null) closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
    }
  };

  const ensureOpen = async (): Promise<Error | null> => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      rotateIfNeededSync(filePath, maxBytes, keepFiles);
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      fd = openSync(filePath, 'a');
      bytesInChunk = statSync(filePath).size;
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  };

  const close = async (): Promise<void> => {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
    }
  };

  return {
    writeLine,
    ensureOpen,
    close,
    path: filePath,
  };
}
