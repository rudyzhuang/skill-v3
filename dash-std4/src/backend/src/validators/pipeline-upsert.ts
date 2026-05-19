/** Max UTF-8 bytes for log_tail field. */
export const LOG_TAIL_MAX_BYTES = 32 * 1024;

/** Max UTF-8 bytes for entire request body JSON. */
export const PAYLOAD_MAX_BYTES = 512 * 1024;

export interface PipelineUpsertInput {
  current_stage?: string;
  last_completed_stage?: string;
  stages?: unknown;
  features?: unknown;
  blocking_issues?: unknown;
  log_tail?: string;
  [key: string]: unknown;
}

export function byteLengthUtf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function validatePipelineUpsert(
  body: unknown,
  rawBodyBytes: number,
): { ok: true; data: PipelineUpsertInput } | { ok: false; errors: string[]; status: 400 | 413 } {
  if (rawBodyBytes > PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      errors: [`请求体超过 ${PAYLOAD_MAX_BYTES} 字节上限`],
      status: 413,
    };
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['请求体须为 JSON 对象'], status: 400 };
  }

  const record = body as Record<string, unknown>;
  const errors: string[] = [];

  if (record.current_stage !== undefined && typeof record.current_stage !== 'string') {
    errors.push('current_stage 须为字符串');
  }
  if (record.last_completed_stage !== undefined && typeof record.last_completed_stage !== 'string') {
    errors.push('last_completed_stage 须为字符串');
  }
  if (record.stages !== undefined && record.stages !== null && typeof record.stages !== 'object') {
    errors.push('stages 须为对象或数组');
  }
  if (record.features !== undefined && record.features !== null && typeof record.features !== 'object') {
    errors.push('features 须为对象或数组');
  }
  if (record.blocking_issues !== undefined && !Array.isArray(record.blocking_issues)) {
    errors.push('blocking_issues 须为数组');
  }

  let logTail = '';
  if (record.log_tail !== undefined) {
    if (typeof record.log_tail !== 'string') {
      errors.push('log_tail 须为字符串');
    } else {
      logTail = record.log_tail;
      if (byteLengthUtf8(logTail) > LOG_TAIL_MAX_BYTES) {
        return {
          ok: false,
          errors: [`log_tail 超过 ${LOG_TAIL_MAX_BYTES} 字节上限`],
          status: 413,
        };
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, status: 400 };
  }

  return {
    ok: true,
    data: {
      ...record,
      log_tail: logTail,
    } as PipelineUpsertInput,
  };
}
