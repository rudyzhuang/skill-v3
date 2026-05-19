import { pipelineUpsertPath, type PipelineUpsertBody } from '../../dash/contracts/pipeline-upsert.js';

export type DashPipelineClientOptions = {
  /** 不含末尾斜杠；必须来自配置或环境变量。 */
  apiBaseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
};

export class DashPipelineHttpError extends Error {
  readonly status: number;
  readonly bodySnippet: string;

  constructor(status: number, message: string, bodySnippet: string) {
    super(message);
    this.name = 'DashPipelineHttpError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 避免日志与异常链中带出密钥或 env 行。 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\bDASH_STD4_API_KEY\s*=\s*\S+/gi, 'DASH_STD4_API_KEY=<redacted>')
    .replace(/\bCURSOR_API_KEY\s*=\s*\S+/gi, 'CURSOR_API_KEY=<redacted>')
    .replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: Bearer <redacted>');
}

export async function putProjectPipeline(
  projectId: string,
  body: PipelineUpsertBody,
  opts: DashPipelineClientOptions,
): Promise<{ ok: true } | { ok: false; error: DashPipelineHttpError }> {
  const fetchImpl = opts.fetchFn ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is not available; pass fetchFn in DashPipelineClientOptions');
  }

  const url = `${normalizeBase(opts.apiBaseUrl)}${pipelineUpsertPath(projectId)}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    // 鉴权与 prd-spec 一致：Bearer + API Key（值不落日志）
    authorization: `Bearer ${opts.apiKey}`,
  };

  const res = await fetchImpl(url, { method: 'PUT', headers, body: JSON.stringify(body) });
  const text = await res.text();
  const snippet = scrubSecrets(text.length > 2_048 ? `${text.slice(0, 2_048)}…` : text);

  if (res.status === 401) {
    return { ok: false, error: new DashPipelineHttpError(401, 'Dash pipeline upsert unauthorized (401)', snippet) };
  }
  if (res.status === 404) {
    return { ok: false, error: new DashPipelineHttpError(404, 'Dash project not found for pipeline upsert (404)', snippet) };
  }
  if (res.status === 400) {
    return { ok: false, error: new DashPipelineHttpError(400, 'Dash pipeline upsert validation failed (400)', snippet) };
  }
  if (res.status === 413) {
    return { ok: false, error: new DashPipelineHttpError(413, 'Dash pipeline payload too large (413)', snippet) };
  }
  if (res.status === 429) {
    return { ok: false, error: new DashPipelineHttpError(429, 'Dash pipeline upsert rate limited (429)', snippet) };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: new DashPipelineHttpError(res.status, `Dash pipeline upsert failed (${res.status})`, snippet),
    };
  }

  return { ok: true };
}
