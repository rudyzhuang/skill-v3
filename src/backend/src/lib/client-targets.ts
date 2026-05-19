import { ALLOWED_CLIENT_TARGETS, type ClientTarget } from '../types/project-summary';

const ALLOWED_SET = new Set<string>(ALLOWED_CLIENT_TARGETS);

export function parseClientTargetsJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
}

export function normalizeClientTargets(
  raw: string,
): { targets: ClientTarget[]; hadInvalid: boolean } {
  const parsed = parseClientTargetsJson(raw);
  if (!Array.isArray(parsed)) {
    return { targets: [], hadInvalid: true };
  }

  const targets: ClientTarget[] = [];
  let hadInvalid = false;

  for (const item of parsed) {
    if (typeof item !== 'string' || !ALLOWED_SET.has(item)) {
      hadInvalid = true;
      continue;
    }
    const t = item as ClientTarget;
    if (!targets.includes(t)) {
      targets.push(t);
    }
  }

  return { targets, hadInvalid };
}
