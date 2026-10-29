import type { Pool, PoolClient } from 'pg';
import type { Db, Queryable } from './db.ts';

class PgQueryable implements Queryable {
  protected readonly client: Pool | PoolClient;

  constructor(client: Pool | PoolClient) {
    this.client = client;
  }

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.client.query(sql, params as unknown[]);
    return result.rows as T[];
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    const result = await this.client.query(sql, params as unknown[]);
    return result.rowCount ?? 0;
  }
}

export class PostgresDb extends PgQueryable implements Db {
  readonly dialect = 'postgres' as const;
  private readonly pool: Pool;

  private constructor(pool: Pool) {
    super(pool);
    this.pool = pool;
  }

  static async open(connectionString: string): Promise<PostgresDb> {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString, max: 10 });
    await pool.query('SELECT 1');
    return new PostgresDb(pool);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgQueryable(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
