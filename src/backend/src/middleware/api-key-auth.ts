import type { Context, Next } from 'hono';
import { extractApiKey, hashApiKey } from '../lib/api-key';
import type { Env } from '../index';

export type ApiKeyAuthVariables = {
  apiKeyId: string;
};

export async function apiKeyAuth(c: Context<{ Bindings: Env; Variables: ApiKeyAuthVariables }>, next: Next) {
  const plainKey = extractApiKey(
    c.req.header('Authorization'),
    c.req.header('X-API-Key'),
  );

  if (!plainKey) {
    return c.json({ error: 'Missing or invalid API key' }, 401);
  }

  const keyHash = await hashApiKey(plainKey);
  const row = await c.env.DB.prepare(
    `SELECT id FROM api_keys WHERE key_hash = ? AND enabled = 1 LIMIT 1`,
  )
    .bind(keyHash)
    .first<{ id: string }>();

  if (!row) {
    return c.json({ error: 'Missing or invalid API key' }, 401);
  }

  c.set('apiKeyId', row.id);
  await next();
}
