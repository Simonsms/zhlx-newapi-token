import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from './db.ts';
import { PostgresDb } from './postgres.ts';
import { SqliteDb } from './sqlite.ts';
import { migrate } from './migrations.ts';

export async function openDatabase(databaseUrl: string): Promise<Db> {
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    const db = await PostgresDb.open(databaseUrl);
    await migrate(db);
    return db;
  }
  if (databaseUrl.startsWith('file:') || databaseUrl === ':memory:' || !databaseUrl.includes('://')) {
    let location = databaseUrl;
    if (location.startsWith('file:')) location = location.slice(5);
    if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });
    const db = new SqliteDb(databaseUrl);
    await migrate(db);
    return db;
  }
  throw new Error('不支持的 DATABASE_URL；请使用 postgres:// 或 file:./path.db');
}
