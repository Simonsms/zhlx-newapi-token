import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { configFromEnv } from '../src/config.ts';
import { createApp, type App } from '../src/server.ts';
import { openDatabase } from '../src/store/open.ts';
import { Store } from '../src/store/store.ts';

const connectionString = process.env.TEST_POSTGRES_URL;

describe('PostgreSQL 方言', { skip: connectionString ? false : '未设置 TEST_POSTGRES_URL' }, () => {
  let app: App;
  let base: string;

  before(async () => {
    const config = configFromEnv({
      PORT: '0',
      HOST: '127.0.0.1',
      DEPLOYMENT_ID: 'pg-test',
      LOG_LEVEL: 'error',
      DATABASE_URL: connectionString,
      ADMIN_API_TOKEN: 'pg-admin-token',
      SESSION_SECRET: 'pg-session-secret',
      UPSTREAM_URL: 'http://127.0.0.1:1',
      CAPTURE_ENABLED: 'true',
    });
    app = await createApp(config);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${address.port}`;
    await app.store.raw('TRUNCATE proxy_request, usage_event, sync_state, admin_audit');
  });

  after(async () => {
    if (app) await app.close();
  });

  it('迁移、去重写入、分组查询与关联详情可用', async () => {
    const db = await openDatabase(connectionString ?? '');
    const store = new Store(db, 'pg-test');
    try {
      await store.raw('TRUNCATE proxy_request, usage_event, sync_state, admin_audit');
      const now = new Date();
      const inserted = await store.insertUsageEvents([
        {
          source_key: 'pg-1',
          deployment_id: 'pg-test',
          source_id: '1',
          newapi_request_id: 'gw-pg-1',
          log_type: 2,
          created_at: now.toISOString(),
          user_id: 5,
          username: 'pguser',
          token_id: 9,
          token_name: 'pgkey',
          model: 'gpt-4o-mini',
          channel: 1,
          prompt_tokens: 11,
          completion_tokens: 22,
          quota: 33,
          usage_source: 'reported',
          raw: '{}',
          synced_at: now.toISOString(),
        },
      ]);
      assert.equal(inserted, 1);
      const duplicate = await store.insertUsageEvents([
        {
          source_key: 'pg-1',
          deployment_id: 'pg-test',
          source_id: '1',
          newapi_request_id: 'gw-pg-1',
          log_type: 2,
          created_at: now.toISOString(),
          user_id: 5,
          username: 'pguser',
          token_id: 9,
          token_name: 'pgkey',
          model: 'gpt-4o-mini',
          channel: 1,
          prompt_tokens: 11,
          completion_tokens: 22,
          quota: 33,
          usage_source: 'reported',
          raw: '{}',
          synced_at: now.toISOString(),
        },
      ]);
      assert.equal(duplicate, 0);

      await store.insertProxyRequests([
        {
          proxy_request_id: 'pg-pr-1',
          deployment_id: 'pg-test',
          newapi_request_id: 'gw-pg-1',
          received_at: now.toISOString(),
          method: 'POST',
          path: '/v1/chat/completions',
          http_status: 200,
          transport_outcome: 'completed',
          capture_status: 'captured',
          skip_reason: null,
          prompt_text: 'pg prompt',
          prompt_scope: 'last_user_message',
          prompt_chars: 9,
          prompt_truncated: 0,
          extraction_version: 'extract-v1',
          redaction_version: 'redact-v1',
          model: 'gpt-4o-mini',
          is_stream: 0,
          duration_ms: 5,
        },
      ]);

      const totals = await store.usageTotals({
        from: new Date(now.getTime() - 3_600_000).toISOString(),
        to: new Date(now.getTime() + 3_600_000).toISOString(),
      });
      assert.equal(totals.consume_events, 1);
      assert.equal(totals.prompt_tokens, 11);
      assert.equal(totals.completion_tokens, 22);
      assert.equal(totals.quota, 33);
      assert.equal(totals.active_users, 1);

      const byUser = await store.usageBreakdown(
        { from: new Date(now.getTime() - 3_600_000).toISOString(), to: new Date(now.getTime() + 3_600_000).toISOString() },
        'user',
      );
      assert.equal(byUser.length, 1);
      assert.equal(byUser[0]?.bucket_label, 'pguser');

      const list = await store.listProxyRequests(
        {
          from: new Date(now.getTime() - 3_600_000).toISOString(),
          to: new Date(now.getTime() + 3_600_000).toISOString(),
          page: 1,
          pageSize: 10,
        },
        60_000,
      );
      assert.equal(list.total, 1);
      assert.equal(list.items[0]?.association_status, 'matched');
      assert.equal(list.items[0]?.prompt_tokens, 11);

      const detail = await store.getProxyRequest('pg-pr-1', 60_000);
      assert.ok(detail);
      assert.equal(detail.request.usage_event_count, 1);
      assert.equal(detail.usage_events[0]?.username, 'pguser');
    } finally {
      await db.close();
    }
  });

  it('管理 API 在 PostgreSQL 上可读写', async () => {
    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'pg-admin-token' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const overview = await fetch(`${base}/admin/api/overview`, { headers: { cookie } });
    assert.equal(overview.status, 200);
    const body = (await overview.json()) as { totals: { prompt_tokens: number } };
    assert.equal(body.totals.prompt_tokens, 11);
  });
});
