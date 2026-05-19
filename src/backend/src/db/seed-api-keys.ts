import { hashApiKey } from '../lib/api-key';

/**
 * Bootstrap the first api_keys row from OPEN_API_KEY (Workers env / wrangler .dev.vars).
 * Never persists or logs the plaintext key.
 */
export async function seedApiKeys(
  db: D1Database,
  openApiKey: string | undefined,
): Promise<void> {
  const trimmed = openApiKey?.trim();
  if (!trimmed) {
    return;
  }

  const keyHash = await hashApiKey(trimmed);
  const now = new Date().toISOString();
  const id = 'bootstrap-open-api';

  await db
    .prepare(
      `INSERT INTO api_keys (id, key_hash, label, enabled, created_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         label = excluded.label,
         enabled = 1`,
    )
    .bind(id, keyHash, 'OPEN_API_KEY bootstrap', now)
    .run();
}
