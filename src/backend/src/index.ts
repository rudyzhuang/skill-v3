import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bootstrapAdmin, type BootstrapEnv } from './services/bootstrap-admin';
import { authRoutes } from './routes/auth';
import { projectsRoutes } from './routes/projects';
import type { AppEnv } from './services/auth';

export type Env = AppEnv &
  BootstrapEnv & {
    ADMIN_ORIGIN?: string;
    PIPELINE_FS_FALLBACK?: string;
  };

const DEFAULT_ADMIN_ORIGINS = [
  'https://admin.dash.ai-ww.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function allowedOrigins(env: Env): string[] {
  const extra = env.ADMIN_ORIGIN?.split(',').map((o) => o.trim()).filter(Boolean) ?? [];
  return [...DEFAULT_ADMIN_ORIGINS, ...extra];
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    await bootstrapAdmin(c.env);
    await next();
  });

  app.use(
    '/api/*',
    cors({
      origin: (origin, c) => {
        if (!origin) {
          return '';
        }
        return allowedOrigins(c.env).includes(origin) ? origin : '';
      },
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      credentials: true,
    }),
  );

  app.get('/health', (c) => c.json({ ok: true }));

  app.route('/api/auth', authRoutes);
  app.route('/api/projects', projectsRoutes);

  return app;
}

const app = createApp();
export default app;
