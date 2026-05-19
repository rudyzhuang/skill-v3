import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

const __dirname = dirname(fileURLToPath(import.meta.url));

class SqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    private db: Database.Database,
    private sql: string,
    private bound: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqlitePreparedStatement(this.db, this.sql, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.bound) as T | undefined;
    return row ?? null;
  }

  async run(): Promise<D1Result> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.bound);
    return {
      success: true,
      meta: {
        duration: 0,
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        rows_read: 0,
        rows_written: info.changes,
      },
    };
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.bound) as T[];
    return { results };
  }
}

export class TestD1 implements D1Database {
  constructor(private db: Database.Database) {}

  prepare(query: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this.db, query);
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    return Promise.all(
      statements.map((s) => (s as SqlitePreparedStatement).run() as Promise<D1Result<T>>),
    );
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.db.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession(): D1Database {
    return this;
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

export function createTestDb(): TestD1 {
  const sqlite = new Database(':memory:');
  const migrationsDir = join(__dirname, '../migrations');
  for (const file of ['0001_users_sessions.sql', '0002_projects.sql']) {
    const migration = readFileSync(join(migrationsDir, file), 'utf8');
    sqlite.exec(migration);
  }
  return new TestD1(sqlite);
}
