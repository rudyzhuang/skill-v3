import { ALLOWED_CLIENT_TARGETS } from '../types/project-summary';

const ALLOWED_SET = new Set<string>(ALLOWED_CLIENT_TARGETS);

export interface CreateProjectInput {
  name_zh: string;
  name_en: string;
  description: string;
  client_targets: string[];
  is_new: boolean;
}

export function validateCreateProjectBody(
  body: unknown,
): { ok: true; data: CreateProjectInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['请求体须为 JSON 对象'] };
  }

  const record = body as Record<string, unknown>;

  const nameZh =
    typeof record.name_zh === 'string' ? record.name_zh.trim() : '';
  if (!nameZh) {
    errors.push('name_zh 为必填项');
  }

  const nameEn =
    typeof record.name_en === 'string' ? record.name_en.trim() : '';
  if (!nameEn) {
    errors.push('name_en 为必填项');
  }

  const description =
    typeof record.description === 'string' ? record.description.trim() : '';
  if (!description) {
    errors.push('description 为必填项');
  }

  let clientTargets: string[] = [];
  if (!Array.isArray(record.client_targets)) {
    errors.push('client_targets 须为非空数组');
  } else {
    const seen = new Set<string>();
    for (const item of record.client_targets) {
      if (typeof item !== 'string' || !ALLOWED_SET.has(item)) {
        errors.push(
          `client_targets 仅允许 ${ALLOWED_CLIENT_TARGETS.join('、')}，且至少一项`,
        );
        break;
      }
      if (!seen.has(item)) {
        seen.add(item);
        clientTargets.push(item);
      }
    }
    if (clientTargets.length === 0 && !errors.some((e) => e.includes('client_targets'))) {
      errors.push('client_targets 须至少选择一项');
    }
  }

  if (typeof record.is_new !== 'boolean') {
    errors.push('is_new 须为布尔值');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      name_zh: nameZh,
      name_en: nameEn,
      description,
      client_targets: clientTargets,
      is_new: record.is_new as boolean,
    },
  };
}
