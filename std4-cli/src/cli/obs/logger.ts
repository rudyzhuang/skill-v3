/**
 * 统一日志门面：分级、可选 JSON；双 sink（stderr + 可选滚动文件）；敏感信息脱敏。
 */
import type { RotatingFileSink } from './log-file-rotation.js';
import { createRotatingFileSink } from './log-file-rotation.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const SENSITIVE_ENV_KEYS = new Set([
  'DASH_STD4_API_KEY',
  'CURSOR_API_KEY',
  'FEISHU_APP_SECRET',
  'LARK_APP_SECRET',
]);

export type LogRecord = {
  ts: string;
  level: LogLevel;
  msg: string;
  feature?: string;
  correlationId?: string;
  [key: string]: unknown;
};

export type LoggerConfig = {
  level: LogLevel;
  format: 'text' | 'json';
  feature: string;
  filePath?: string;
};

export type Logger = {
  start: () => Promise<void>;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  info: (msg: string, extra?: Record<string, unknown>) => void;
  debug: (msg: string, extra?: Record<string, unknown>) => void;
  flushFile: () => Promise<void>;
  fileSinkDowngraded: () => boolean;
};

const REDACT = '[REDACTED]';

export function sanitizeMessage(msg: string): string {
  let out = msg;
  out = out.replace(/Authorization:\s*\S+/gi, `Authorization: ${REDACT}`);
  out = out.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACT}`);
  for (const key of SENSITIVE_ENV_KEYS) {
    const val = process.env[key];
    if (val && val.length > 0) {
      const pattern = new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      out = out.replace(pattern, REDACT);
    }
  }
  return out;
}

export function sanitizeExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const json = JSON.stringify(extra);
  const sanitized = sanitizeMessage(json);
  try {
    return JSON.parse(sanitized) as Record<string, unknown>;
  } catch {
    return { _sanitized: sanitized };
  }
}

export function createLogger(cfg: LoggerConfig): Logger {
  const minLevel = LEVEL_ORDER[cfg.level];
  let fileSink: RotatingFileSink | null = null;
  let fileReady = false;
  let fileFailed = false;

  if (cfg.filePath) {
    fileSink = createRotatingFileSink(cfg.filePath);
  }

  const emit = (level: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] > minLevel) return;
    const safeMsg = sanitizeMessage(msg);
    const safeExtra = sanitizeExtra(extra);
    const ts = new Date().toISOString();
    const rec: LogRecord = {
      ts,
      level,
      msg: safeMsg,
      feature: cfg.feature,
      ...(safeExtra ?? {}),
    };

    let line: string;
    if (cfg.format === 'json') {
      line = JSON.stringify(rec);
    } else {
      const tail = safeExtra ? ` ${JSON.stringify(safeExtra)}` : '';
      line = `${ts} [${level.toUpperCase()}] [${cfg.feature}] ${safeMsg}${tail}`;
    }

    // eslint-disable-next-line no-console
    console.error(line);
    if (fileSink && fileReady && !fileFailed) {
      try {
        fileSink.writeLine(line);
      } catch {
        fileFailed = true;
        // eslint-disable-next-line no-console
        console.error(
          `[std4-cli] log file write failed (${fileSink.path}); logging to stderr only`,
        );
      }
    }
  };

  return {
    start: async () => {
      if (!fileSink) return;
      const err = await fileSink.ensureOpen();
      if (err) {
        fileFailed = true;
        // eslint-disable-next-line no-console
        console.error(
          `[std4-cli] log file unavailable (${cfg.filePath}): ${err.message}; logging to stderr only`,
        );
        return;
      }
      fileReady = true;
    },
    error: (msg, extra) => emit('error', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    debug: (msg, extra) => emit('debug', msg, extra),
    flushFile: async () => {
      if (fileSink) await fileSink.close();
    },
    fileSinkDowngraded: () => fileFailed,
  };
}

export { SENSITIVE_ENV_KEYS };
