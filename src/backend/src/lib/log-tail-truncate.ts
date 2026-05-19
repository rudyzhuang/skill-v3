/** Max UTF-8 bytes for log_tail in dashboard responses. */
export const LOG_TAIL_MAX_BYTES = 32 * 1024;

/** Max lines for log_tail in dashboard responses. */
export const LOG_TAIL_MAX_LINES = 200;

export interface TruncateLogTailResult {
  text: string;
  truncated: boolean;
}

export function byteLengthUtf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Truncate log_tail by 32KB or 200 lines, whichever limit is hit first. */
export function truncateLogTail(logTail: string): TruncateLogTailResult {
  if (!logTail) {
    return { text: '', truncated: false };
  }

  const lines = logTail.split('\n');
  let truncated = false;
  let resultLines = lines;

  if (lines.length > LOG_TAIL_MAX_LINES) {
    resultLines = lines.slice(-LOG_TAIL_MAX_LINES);
    truncated = true;
  }

  let text = resultLines.join('\n');

  if (byteLengthUtf8(text) > LOG_TAIL_MAX_BYTES) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    const slice = bytes.slice(-LOG_TAIL_MAX_BYTES);
    text = new TextDecoder().decode(slice);
    truncated = true;
  }

  return { text, truncated };
}
