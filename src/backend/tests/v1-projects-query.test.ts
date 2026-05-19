import { describe, expect, it } from 'vitest';
import { hashApiKey } from '../src/lib/api-key';
import { app, type Env } from '../src/index';
import type { ProjectDetail, ProjectListResponse } from '../src/types/project';
import { createMemoryD1, insertApiKey, insertProject } from './helpers/memory-d1';

const TEST_KEY = 'test-open-api-key-secret';

function envWith(db: D1Database): Env {
  return { DB: db, OPEN_API_KEY: undefined };
}

async function request(
  db: D1Database,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization') && !headers.has('X-API-Key')) {
    headers.set('Authorization', `Bearer ${TEST_KEY}`);
  }
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers }),
    envWith(db),
  );
}

describe('GET /api/v1/projects', () => {
  it('returns 200 with empty list when no projects', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await request(db, '/api/v1/projects');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ProjectListResponse;
    expect(body).toEqual({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    });
  });

  it('returns project summaries with pagination', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'p1',
      name_zh: '项目甲',
      name_en: 'Project Alpha',
      client_targets: ['admin', 'backend'],
      status: 'active',
    });
    await insertProject(db, {
      id: 'p2',
      name_zh: '项目乙',
      name_en: 'Project Beta',
      client_targets: ['backend'],
      status: 'blocked',
    });

    const res = await request(db, '/api/v1/projects?page=1&page_size=1');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ProjectListResponse;
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: expect.any(String),
      name_zh: expect.any(String),
      name_en: expect.any(String),
      status: expect.any(String),
      client_targets: expect.any(Array),
      updated_at: expect.any(String),
    });
  });

  it('filters by status and q', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'match-zh',
      name_zh: '唯一中文名',
      name_en: 'Other',
      client_targets: ['admin'],
      status: 'active',
    });
    await insertProject(db, {
      id: 'match-en',
      name_zh: '其他',
      name_en: 'UniqueEnglish',
      client_targets: ['backend'],
      status: 'completed',
    });

    const byStatus = await request(db, '/api/v1/projects?status=completed');
    const statusBody = (await byStatus.json()) as ProjectListResponse;
    expect(statusBody.total).toBe(1);
    expect(statusBody.items[0].id).toBe('match-en');

    const byQ = await request(db, '/api/v1/projects?q=唯一');
    const qBody = (await byQ.json()) as ProjectListResponse;
    expect(qBody.total).toBe(1);
    expect(qBody.items[0].id).toBe('match-zh');
  });

  it('caps page_size at 100', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await request(db, '/api/v1/projects?page_size=500');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ProjectListResponse;
    expect(body.page_size).toBe(100);
  });

  it('accepts X-API-Key header', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/projects', {
        headers: { 'X-API-Key': TEST_KEY },
      }),
      envWith(db),
    );
    expect(res.status).toBe(200);
  });

  it('returns 401 without API key', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/projects'),
      envWith(db),
    );
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain('key_hash');
  });

  it('returns 401 for invalid Bearer format', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/projects', {
        headers: { Authorization: 'Bearer' },
      }),
      envWith(db),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when key not in api_keys', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/projects', {
        headers: { Authorization: 'Bearer wrong-key' },
      }),
      envWith(db),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(await hashApiKey(TEST_KEY));
  });

  it('returns 401 when api key disabled', async () => {
    const db = createMemoryD1();
    const keyHash = await hashApiKey(TEST_KEY);
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO api_keys (id, key_hash, label, enabled, created_at)
         VALUES ('disabled', ?, 'disabled', 0, ?)`,
      )
      .bind(keyHash, now)
      .run();

    const res = await request(db, '/api/v1/projects');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/projects/:id', () => {
  it('returns 200 with project detail', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'detail-1',
      name_zh: '详情项目',
      name_en: 'Detail Project',
      description: '简介',
      client_targets: ['admin'],
      is_new: 1,
      root_path: '/workspace/proj',
      pipeline_summary: 'stage: codegen',
    });

    const res = await request(db, '/api/v1/projects/detail-1');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ProjectDetail;
    expect(body).toMatchObject({
      id: 'detail-1',
      name_zh: '详情项目',
      name_en: 'Detail Project',
      description: '简介',
      client_targets: ['admin'],
      status: 'active',
      is_new: true,
      root_path: '/workspace/proj',
      pipeline_status: 'stage: codegen',
    });
    expect(body.updated_at).toBeTruthy();
  });

  it('returns 404 for missing project', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await request(db, '/api/v1/projects/missing-id');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('returns 401 without API key on detail', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/projects/any'),
      envWith(db),
    );
    expect(res.status).toBe(401);
  });

  it('annotates invalid client_targets in detail', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await db
      .prepare(
        `INSERT INTO projects (
          id, name_zh, name_en, description, client_targets, status, is_new,
          source, root_path, pipeline_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'bad-targets',
        '坏目标',
        'Bad Targets',
        null,
        JSON.stringify(['admin', 'mobile', 'backend']),
        'active',
        0,
        'admin',
        null,
        null,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();

    const res = await request(db, '/api/v1/projects/bad-targets');
    const body = (await res.json()) as ProjectDetail;
    expect(body.client_targets).toEqual(['admin', 'backend']);
    expect(body.client_targets_note).toContain('admin|backend');
  });

  it('finds project created via open_api pipeline source', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'pipeline-created',
      name_zh: '流水线项目',
      name_en: 'Pipeline Project',
      description: 'from POST /api/v1/projects',
      client_targets: ['backend'],
      source: 'open_api',
    });

    const listBody = (await (await request(db, '/api/v1/projects')).json()) as ProjectListResponse;
    expect(listBody.items.some((i) => i.id === 'pipeline-created')).toBe(true);

    const detail = (await (await request(db, '/api/v1/projects/pipeline-created')).json()) as ProjectDetail;
    expect(detail.name_zh).toBe('流水线项目');
    expect(detail.description).toBe('from POST /api/v1/projects');
  });

  it('finds project created via admin source channel', async () => {
    const db = createMemoryD1();
    await insertApiKey(db, TEST_KEY);
    await insertProject(db, {
      id: 'admin-created',
      name_zh: '管理端项目',
      name_en: 'Admin Project',
      description: 'from admin',
      client_targets: ['admin', 'backend'],
      source: 'admin',
    });

    const listRes = await request(db, '/api/v1/projects');
    const listBody = (await listRes.json()) as ProjectListResponse;
    expect(listBody.items.some((i) => i.id === 'admin-created')).toBe(true);

    const detailRes = await request(db, '/api/v1/projects/admin-created');
    const detail = (await detailRes.json()) as ProjectDetail;
    expect(detail.name_zh).toBe('管理端项目');
    expect(detail.name_en).toBe('Admin Project');
  });
});

describe('GET /health', () => {
  it('is public', async () => {
    const db = createMemoryD1();
    const res = await app.fetch(new Request('http://localhost/health'), envWith(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
