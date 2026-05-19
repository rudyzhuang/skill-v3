import { Hono } from 'hono';
import { seedApiKeys } from './db/seed-api-keys';
import { projectsV1 } from './routes/v1/projects';

export interface Env {
  DB: D1Database;
  OPEN_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

app.route('/api/v1/projects', projectsV1);

app.onError((err, c) => {
  console.error('unhandled error', err instanceof Error ? err.message : 'unknown');
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

let seeded = false;

async function ensureSeeded(env: Env): Promise<void> {
  if (seeded) {
    return;
  }
  await seedApiKeys(env.DB, env.OPEN_API_KEY);
  seeded = true;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await ensureSeeded(env);
    return app.fetch(request, env, ctx);
  },
};

export { app };
