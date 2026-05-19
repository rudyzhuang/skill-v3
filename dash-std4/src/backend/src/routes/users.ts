import { Hono } from 'hono';
import { requireAdmin } from '../middleware/require-admin';
import { requireSession, type AuthVariables } from '../middleware/require-session';
import { createUser, listUsersPublic, updateUser } from '../services/users';
import type { AppEnv } from '../services/auth';
import { parseCreateUserBody, parseUpdateUserBody } from '../validators/user';

export const usersRoutes = new Hono<{
  Bindings: AppEnv;
  Variables: AuthVariables;
}>();

usersRoutes.use('*', requireSession);
usersRoutes.use('*', requireAdmin);

usersRoutes.get('/', async (c) => {
  const pageParam = c.req.query('page');
  const pageSizeParam = c.req.query('page_size');
  const page = pageParam ? parseInt(pageParam, 10) : undefined;
  const pageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : undefined;

  const result = await listUsersPublic(c.env.DB, {
    page: page && page > 0 ? page : 1,
    pageSize: pageSize && pageSize > 0 ? pageSize : undefined,
  });

  return c.json(result);
});

usersRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求体无效' }, 400);
  }

  const parsed = parseCreateUserBody(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  const result = await createUser(c.env.DB, parsed.data);
  if (!result.ok) {
    if (result.code === 'conflict') {
      return c.json({ error: '邮箱已存在' }, 409);
    }
    return c.json({ error: '创建失败' }, 400);
  }

  return c.json({ user: result.user }, 201);
});

usersRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求体无效' }, 400);
  }

  const parsed = parseUpdateUserBody(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  const result = await updateUser(c.env.DB, id, parsed.data);
  if (!result.ok) {
    if (result.code === 'not_found') {
      return c.json({ error: '用户不存在' }, 404);
    }
    if (result.code === 'forbidden') {
      return c.json({ error: '无法修改引导管理员' }, 403);
    }
    return c.json({ error: '更新失败' }, 400);
  }

  return c.json({ user: result.user });
});
