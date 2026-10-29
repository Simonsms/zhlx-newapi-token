import type { Db } from './db.ts';

interface Migration {
  version: number;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS proxy_request (
        proxy_request_id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        newapi_request_id TEXT,
        received_at TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        http_status INTEGER,
        transport_outcome TEXT NOT NULL,
        capture_status TEXT NOT NULL,
        skip_reason TEXT,
        prompt_text TEXT,
        prompt_scope TEXT,
        prompt_chars INTEGER,
        prompt_truncated INTEGER NOT NULL DEFAULT 0,
        extraction_version TEXT,
        redaction_version TEXT,
        model TEXT,
        is_stream INTEGER,
        duration_ms INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_proxy_received ON proxy_request (deployment_id, received_at)`,
      `CREATE INDEX IF NOT EXISTS idx_proxy_gateway ON proxy_request (deployment_id, newapi_request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_proxy_capture ON proxy_request (deployment_id, capture_status, received_at)`,
      `CREATE TABLE IF NOT EXISTS usage_event (
        source_key TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        source_id TEXT,
        newapi_request_id TEXT,
        log_type INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        user_id BIGINT,
        username TEXT,
        token_id BIGINT,
        token_name TEXT,
        model TEXT,
        channel BIGINT,
        prompt_tokens BIGINT,
        completion_tokens BIGINT,
        quota BIGINT,
        usage_source TEXT NOT NULL,
        raw TEXT NOT NULL,
        synced_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_usage_request ON usage_event (deployment_id, newapi_request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_event (deployment_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_event (deployment_id, user_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_event (deployment_id, model, created_at)`,
      `CREATE TABLE IF NOT EXISTS sync_state (
        deployment_id TEXT PRIMARY KEY,
        watermark TEXT,
        last_run_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        events_total BIGINT NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS admin_audit (
        audit_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        principal TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (occurred_at)`,
    ],
  },
];

export async function migrate(db: Db): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );
  const rows = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((row) => Number(row.version)));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await db.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.execute(statement);
      }
      await tx.execute('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        new Date().toISOString(),
      ]);
    });
  }
}
