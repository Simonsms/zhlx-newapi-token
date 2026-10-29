import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { configFromEnv } from '../src/config.ts';
import { mapRawLog, SqliteLogSource } from '../src/newapi-client.ts';
import { openDatabase } from '../src/store/open.ts';
import { Store } from '../src/store/store.ts';
import { LogSync } from '../src/sync.ts';
import { createMetrics } from '../src/metrics.ts';
import { silentLogger } from '../src/logger.ts';

function createNewApiDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    created_at INTEGER,
    type INTEGER,
    content TEXT,
    username TEXT,
    token_name TEXT,
    model_name TEXT,
    quota INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    use_time INTEGER,
    is_stream numeric,
    channel_id INTEGER,
    channel_name TEXT,
    token_id INTEGER,
    "group" TEXT,
    ip TEXT,
    request_id varchar(64),
    other TEXT
  )`);
  const insert = db.prepare(
    `INSERT INTO logs (id, user_id, created_at, type, content, username, token_name, model_name,
      quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id, channel_name,
      token_id, "group", ip, request_id, other)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'default', '', ?, ?)`,
  );
  const now = Math.floor(Date.now() / 1000);
  insert.run(1, 1, now - 60, 2, 'admin', '陈华鸿', 'gpt-6-astra', 1000, 500, 100, 8, 1, 7, 6, 'req-a', '{"admin_info":{"channel_affinity":{}}}');
  insert.run(2, 1, now - 50, 2, 'admin', '赵祥', 'gpt-6-astra', 2000, 1000, 200, 9, 1, 7, 2, 'req-b', null);
  insert.run(3, 1, now - 40, 2, 'admin', '陈华鸿', 'claude-sonnet', 3000, 1500, 300, 10, 0, 7, 6, 'req-c', null);
  insert.run(4, 1, now - 30, 5, 'admin', '陈华鸿', 'gpt-6-astra', 0, null, null, 1, 0, 7, 6, 'req-d', null);
  db.close();
}

describe('SQLite 日志直读与身份口径', () => {
  let dir: string;
  let logPath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhlx-newapi-src-'));
    logPath = join(dir, 'one-api.db');
    createNewApiDb(logPath);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('读取 New API v0.13 日志表并映射 channel_id', async () => {
    const source = new SqliteLogSource({ path: logPath });
    const now = Math.floor(Date.now() / 1000);
    const rows = await source.fetchPage(2, now - 3600, now, 1, 100);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.channel_id, 7);
    assert.equal(rows[0]?.request_id, 'req-a');
    const mapped = mapRawLog(rows[0] ?? {}, 'dep', 'composite');
    assert.ok(mapped);
    assert.equal(mapped.channel, 7);
    assert.equal(mapped.token_name, '陈华鸿');
    assert.equal(mapped.usage_source, 'reported');
  });

  it('只读打开不会修改源库', async () => {
    const source = new SqliteLogSource({ path: logPath });
    await source.fetchPage(5, 0, Math.floor(Date.now() / 1000), 1, 10);
    const db = new DatabaseSync(logPath, { readOnly: true });
    const count = db.prepare('SELECT COUNT(*) AS c FROM logs').get() as { c: number };
    db.close();
    assert.equal(Number(count.c), 4);
  });

  it('SQLite 源完成同步，共享账号下按凭证统计人员', async () => {
    const db = await openDatabase(':memory:');
    const store = new Store(db, 'dep');
    const config = configFromEnv({
      DATABASE_URL: ':memory:',
      DEPLOYMENT_ID: 'dep',
      NEWAPI_LOG_SYNC_ENABLED: 'true',
      NEWAPI_SQLITE_PATH: logPath,
      NEWAPI_LOG_SAFETY_LAG_MS: '0',
      NEWAPI_LOG_OVERLAP_MS: '0',
    });
    const sync = new LogSync(store, new SqliteLogSource({ path: logPath }), config, createMetrics(), silentLogger);
    try {
      const report = await sync.syncOnce();
      assert.equal(report.error, null);
      assert.equal(report.inserted, 4);

      const from = new Date(Date.now() - 86_400_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();

      const auto = await store.identityStats({ from, to });
      assert.equal(auto.mode, 'token', '只有一个账号但有多个凭证时自动按凭证');
      assert.equal(auto.distinct_users, 1);
      assert.equal(auto.distinct_tokens, 2);

      const forcedUser = await store.identityStats({ from, to }, 'user');
      assert.equal(forcedUser.mode, 'user');

      const byToken = await store.usageBreakdown({ from, to }, 'token');
      assert.equal(byToken.length, 2);
      const chen = byToken.find((row) => row.bucket_label === '陈华鸿');
      assert.equal(chen?.consume_events, 2);
      assert.equal(chen?.prompt_tokens, 2000);

      const byUser = await store.usageBreakdown({ from, to }, 'user');
      assert.equal(byUser.length, 1);
      assert.equal(byUser[0]?.consume_events, 3);

      const totals = await store.usageTotals({ from, to });
      assert.equal(totals.consume_events, 3);
      assert.equal(totals.error_events, 1);
      assert.equal(totals.active_users, 1);
      assert.equal(totals.active_tokens, 2);

      const filtered = await store.usageTotals({ from, to, tokenId: 6 });
      assert.equal(filtered.consume_events, 2);
    } finally {
      await db.close();
    }
  });

  it('按凭证筛选代理请求时使用日志侧 token_id', async () => {
    const db = await openDatabase(':memory:');
    const store = new Store(db, 'dep');
    try {
      const now = new Date();
      await store.insertProxyRequests([
        {
          proxy_request_id: 'pr-token-1',
          deployment_id: 'dep',
          newapi_request_id: 'req-a',
          received_at: now.toISOString(),
          method: 'POST',
          path: '/v1/responses',
          http_status: 200,
          transport_outcome: 'completed',
          capture_status: 'captured',
          skip_reason: null,
          prompt_text: 'hello',
          prompt_scope: 'responses_input',
          prompt_chars: 5,
          prompt_truncated: 0,
          extraction_version: 'extract-v1',
          redaction_version: 'redact-v1',
          model: 'gpt-6-astra',
          is_stream: 1,
          duration_ms: 5,
        },
      ]);
      await store.insertUsageEvents([
        {
          source_key: 'dep-src-a',
          deployment_id: 'dep',
          source_id: '1',
          newapi_request_id: 'req-a',
          log_type: 2,
          created_at: now.toISOString(),
          user_id: 1,
          username: 'admin',
          token_id: 6,
          token_name: '陈华鸿',
          model: 'gpt-6-astra',
          channel: 7,
          prompt_tokens: 500,
          completion_tokens: 100,
          quota: 1000,
          usage_source: 'reported',
          raw: '{}',
          synced_at: now.toISOString(),
        },
      ]);
      const range = {
        from: new Date(now.getTime() - 60_000).toISOString(),
        to: new Date(now.getTime() + 60_000).toISOString(),
      };
      const byToken = await store.listProxyRequests({ ...range, tokenId: 6, page: 1, pageSize: 10 }, 300_000);
      assert.equal(byToken.total, 1);
      assert.equal(byToken.items[0]?.newapi_request_id, 'req-a');
      assert.equal(byToken.items[0]?.prompt_tokens, 500);

      const wrongToken = await store.listProxyRequests({ ...range, tokenId: 99, page: 1, pageSize: 10 }, 300_000);
      assert.equal(wrongToken.total, 0);
    } finally {
      await db.close();
    }
  });
});
