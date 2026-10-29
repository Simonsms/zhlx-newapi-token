import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db, Queryable } from './db.ts';

function normalizeLocation(databaseUrl: string): string {
  if (databaseUrl === ':memory:' || databaseUrl === 'file::memory:') return ':memory:';
  let path = databaseUrl;
  if (path.startsWith('file:')) path = path.slice('file:'.length);
  if (path === '') throw new Error('SQLite 路径为空');
  if (path === ':memory:') return path;
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

type BindValue = string | number | bigint | null | Uint8Array;

function toBindValues(params: readonly unknown[]): BindValue[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
    if (value instanceof Uint8Array) return value;
    return JSON.stringify(value);
  });
}

function toSqlite(sql: string, params: readonly unknown[]): { sql: string; params: BindValue[] } {
  const outParams: BindValue[] = [];
  const text = sql.replace(/\$(\d+)/g, (_match, digits: string) => {
    const index = Number(digits) - 1;
    if (index < 0 || index >= params.length) {
      throw new Error(`SQL 参数 $${digits} 超出范围`);
    }
    outParams.push(toBindValues([params[index]])[0] ?? null);
    return '?';
  });
  return { sql: text, params: outParams };
}

class SqliteQueryable implements Queryable {
  protected readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const translated = toSqlite(sql, params);
    return this.db.prepare(translated.sql).all(...translated.params) as T[];
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    const translated = toSqlite(sql, params);
    const result = this.db.prepare(translated.sql).run(...translated.params);
    return Number(result.changes);
  }
}

export class SqliteDb extends SqliteQueryable implements Db {
  readonly dialect = 'sqlite' as const;
  private lock: Promise<void> = Promise.resolve();

  constructor(databaseUrl: string) {
    const location = normalizeLocation(databaseUrl);
    super(new DatabaseSync(location));
    if (location !== ':memory:') {
      this.db.exec('PRAGMA journal_mode=WAL');
    }
    this.db.exec('PRAGMA busy_timeout=5000');
  }

  private withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  override query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.withLock(() => super.query<T>(sql, params));
  }

  override execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    return this.withLock(() => super.execute(sql, params));
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(new SqliteQueryable(this.db));
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.withLock(() => {
      this.db.close();
    });
  }
}
