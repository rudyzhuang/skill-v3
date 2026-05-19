import type { Context } from 'hono';
import type { ApiKeyAuthVariables } from '../../middleware/api-key-auth';
import { upsertPipelineSnapshot } from '../../services/pipeline-snapshot';
import { projectExists } from '../../services/projects-write';
import type { Env } from '../../index';
import {
  byteLengthUtf8,
  PAYLOAD_MAX_BYTES,
  validatePipelineUpsert,
} from '../../validators/pipeline-upsert';

export async function handleUpsertPipeline(
  c: Context<{ Bindings: Env; Variables: ApiKeyAuthVariables }>,
): Promise<Response> {
  const projectId = c.req.param('id');

  const exists = await projectExists(c.env.DB, projectId);
  if (!exists) {
    return c.json({ error: 'Project not found', code: 'not_found' }, 404);
  }

  const rawText = await c.req.text();
  const rawBytes = byteLengthUtf8(rawText);

  if (rawBytes > PAYLOAD_MAX_BYTES) {
    return c.json({ errors: [`请求体超过 ${PAYLOAD_MAX_BYTES} 字节上限`] }, 413);
  }

  let body: unknown;
  if (!rawText.trim()) {
    body = {};
  } else {
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      return c.json({ errors: ['请求体须为合法 JSON'] }, 400);
    }
  }

  const validated = validatePipelineUpsert(body, rawBytes);
  if (!validated.ok) {
    return c.json({ errors: validated.errors }, validated.status);
  }

  try {
    const { summary } = await upsertPipelineSnapshot(c.env.DB, projectId, validated.data);
    return c.json(summary, 200);
  } catch (err) {
    console.error('pipeline upsert failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ error: 'Failed to save pipeline snapshot' }, 500);
  }
}
