import { ALLOWED_CLIENT_TARGETS } from '../types/project';

const ALLOWED_SET = new Set<string>(ALLOWED_CLIENT_TARGETS);

export interface OpenApiProjectCreateInput {
  name_zh: string;
  name_en: string;
  description: string;
  client_targets: (typeof ALLOWED_CLIENT_TARGETS)[number][];
  is_new: boolean;
}

export function validateOpenApiProjectCreate(
  body: unknown,
): { ok: true; data: OpenApiProjectCreateInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['请求体须为 JSON 对象'] };
  }

  const record = body as Record<string, unknown>;

  const nameZh = readRequiredString(record, 'name_zh', '项目名称（中文）', errors);
  const nameEn = readRequiredString(record, 'name_en', '项目名称（英文）', errors);
  const description = readRequiredString(record, 'description', '项目简介', errors);

  const clientTargets = readClientTargets(record.client_targets, errors);
  const isNew = readRequiredBoolean(record, 'is_new', '是否新增', errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      name_zh: nameZh!,
      name_en: nameEn!,
      description: description!,
      client_targets: clientTargets!,
      is_new: isNew!,
    },
  };
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string | undefined {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${label}（${key}）为必填字符串`);
    return undefined;
  }
  return value.trim();
}

function readRequiredBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): boolean | undefined {
  const value = record[key];
  if (typeof value !== 'boolean') {
    errors.push(`${label}（${key}）须为布尔值`);
    return undefined;
  }
  return value;
}

function readClientTargets(
  value: unknown,
  errors: string[],
): OpenApiProjectCreateInput['client_targets'] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('client_targets 须为非空数组');
    return undefined;
  }

  const targets: OpenApiProjectCreateInput['client_targets'] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !ALLOWED_SET.has(item)) {
      errors.push('client_targets 仅允许 admin、backend');
      return undefined;
    }
    const t = item as OpenApiProjectCreateInput['client_targets'][number];
    if (!targets.includes(t)) {
      targets.push(t);
    }
  }

  return targets;
}
