import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { hashApiKey } from '../../src/lib/api-key';

const __dirname = dirname(fileURLToPath(import.meta.url));

type D1MetaRecord = D1Meta & Record<string, unknown>;

function d1Meta(overrides: Partial<D1Meta> = {}): D1MetaRecord {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    changed_db: false,
    last_row_id: 0,
    changes: 0,
    ...overrides,
  };
}

function createPrepared(db: Database.Database, sql: string) {
  const stmt = db.prepare(sql);

  return {
    bind(...values: unknown[]) {
      return {
        async all<T>(): Promise<D1Result<T>> {
          const rows = stmt.all(...values) as T[];
          return { results: rows, success: true, meta: d1Meta() };
        },
        async first<T>(): Promise<T | null> {
          const row = stmt.get(...values) as T | undefined;
          return row ?? null;
        },
        async run(): Promise<D1Result> {
          const info = stmt.run(...values);
          return {
            success: true,
            meta: d1Meta({
              changes: info.changes,
              last_row_id: Number(info.lastInsertRowid),
              changed_db: info.changes > 0,
            }),
          } as D1Result;
        },
      };
    },
  };
}

export function createMemoryD1(): D1Database {
  const sqlite = new Database(':memory:');
  const schemaPath = join(__dirname, '../../src/db/schema.sql');
  sqlite.exec(readFileSync(schemaPath, 'utf8'));

  const db = {
    prepare(sql: string) {
      return createPrepared(sqlite, sql);
    },
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      const runs = statements.map((s) =>
        (s as { run(): Promise<D1Result> }).run(),
      );
      return Promise.all(runs);
    },
    async exec(query: string): Promise<D1ExecResult> {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
  };

  return db as unknown as D1Database;
}

export async function insertApiKey(db: D1Database, plainKey: string, id = 'test-key'): Promise<void> {
  const keyHash = await hashApiKey(plainKey);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO api_keys (id, key_hash, label, enabled, created_at)
       VALUES (?, ?, 'test', 1, ?)`,
    )
    .bind(id, keyHash, now)
    .run();
}

export async function insertProject(
  db: D1Database,
  row: {
    id: string;
    name_zh: string;
    name_en: string;
    description?: string | null;
    client_targets: string[];
    status?: string;
    is_new?: number;
    root_path?: string | null;
    pipeline_summary?: string | null;
    source?: string;
    updated_at?: string;
  },
): Promise<void> {
  const now = row.updated_at ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO projects (
        id, name_zh, name_en, description, client_targets, status, is_new,
        source, root_path, pipeline_summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.name_zh,
      row.name_en,
      row.description ?? null,
      JSON.stringify(row.client_targets),
      row.status ?? 'active',
      row.is_new ?? 0,
      row.source ?? 'open_api',
      row.root_path ?? null,
      row.pipeline_summary ?? null,
      now,
      now,
    )
    .run();
}
