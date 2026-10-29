import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { configFromEnv } from '../src/config.ts';
import { createApp, type App } from '../src/server.ts';
import { openDatabase } from '../src/store/open.ts';
import { Store } from '../src/store/store.ts';
import { baseUrl, login, startTestApp, waitFor, type TestContext } from './helpers.ts';

describe('关联状态与跨部署隔离', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp({ captureEnabled: true });
  });

  after(async () => {
    await ctx.close();
  });

  it('尚无日志时显示 pending，超窗后显示 unmatched', async () => {
    const db = await openDatabase(':memory:');
    const store = new Store(db, 'dep');
    try {
      const fresh = new Date().toISOString();
      const old = new Date(Date.now() - 3_600_000).toISOString();
      await store.insertProxyRequests([
        {
          proxy_request_id: 'pending-1',
          deployment_id: 'dep',
          newapi_request_id: 'gw-pending',
          received_at: fresh,
          method: 'POST',
          path: '/v1/chat/completions',
          http_status: 200,
          transport_outcome: 'completed',
          capture_status: 'captured',
          skip_reason: null,
          prompt_text: 'x',
          prompt_scope: 'last_user_message',
          prompt_chars: 1,
          prompt_truncated: 0,
          extraction_version: 'extract-v1',
          redaction_version: 'redact-v1',
          model: 'm',
          is_stream: 0,
          duration_ms: 1,
        },
        {
          proxy_request_id: 'unmatched-1',
          deployment_id: 'dep',
          newapi_request_id: 'gw-missing',
          received_at: old,
          method: 'POST',
          path: '/v1/chat/completions',
          http_status: 200,
          transport_outcome: 'completed',
          capture_status: 'captured',
          skip_reason: null,
          prompt_text: 'y',
          prompt_scope: 'last_user_message',
          prompt_chars: 1,
          prompt_truncated: 0,
          extraction_version: 'extract-v1',
          redaction_version: 'redact-v1',
          model: 'm',
          is_stream: 0,
          duration_ms: 1,
        },
      ]);
      const filter = { from: old.slice(0, 10) + 'T00:00:00.000Z', to: new Date(Date.now() + 60_000).toISOString() };
      const counts = await store.associationCounts(
        { from: new Date(Date.now() - 86_400_000).toISOString(), to: filter.to },
        300_000,
      );
      assert.equal(counts.pending, 1);
      assert.equal(counts.unmatched, 1);

      const pendingDetail = await store.getProxyRequest('pending-1', 300_000);
      assert.equal(pendingDetail?.request.association_status, 'pending');
      const staleDetail = await store.getProxyRequest('unmatched-1', 300_000);
      assert.equal(staleDetail?.request.association_status, 'unmatched');
    } finally {
      await db.close();
    }
  });

  it('不同部署的相同网关请求 ID 不会互相匹配', async () => {
    const db = await openDatabase(':memory:');
    const storeA = new Store(db, 'dep-a');
    const storeB = new Store(db, 'dep-b');
    try {
      const now = new Date().toISOString();
      await storeA.insertProxyRequests([
        {
          proxy_request_id: 'a-1',
          deployment_id: 'dep-a',
          newapi_request_id: 'same-gw',
          received_at: now,
          method: 'POST',
          path: '/v1/chat/completions',
          http_status: 200,
          transport_outcome: 'completed',
          capture_status: 'captured',
          skip_reason: null,
          prompt_text: 'a',
          prompt_scope: 'last_user_message',
          prompt_chars: 1,
          prompt_truncated: 0,
          extraction_version: 'extract-v1',
          redaction_version: 'redact-v1',
          model: 'm',
          is_stream: 0,
          duration_ms: 1,
        },
      ]);
      await storeB.insertUsageEvents([
        {
          source_key: 'b-usage',
          deployment_id: 'dep-b',
          source_id: '1',
          newapi_request_id: 'same-gw',
          log_type: 2,
          created_at: now,
          user_id: 1,
          username: 'bob',
          token_id: 1,
          token_name: 'k',
          model: 'm',
          channel: 1,
          prompt_tokens: 1,
          completion_tokens: 1,
          quota: 1,
          usage_source: 'reported',
          raw: '{}',
          synced_at: now,
        },
      ]);
      const detailA = await storeA.getProxyRequest('a-1', 60_000);
      assert.equal(detailA?.request.usage_event_count, 0);
      assert.equal(detailA?.request.association_status, 'pending');
    } finally {
      await db.close();
    }
  });

  it('客户端取消会传播到上游并记录终态', async () => {
    const slow = await startTestApp({
      captureEnabled: true,
      env: { CAPTURE_MAX_BYTES: '65536' },
    });
    try {
      const upstreamClosed = new Promise<void>((resolve) => {
        slow.upstream.server.once('request', () => resolve());
      });
      const controller = new AbortController();
      const request = fetch(`${baseUrl(slow)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'slow-model', stream: true, messages: [{ role: 'user', content: 'cancel me' }] }),
        signal: controller.signal,
      }).catch(() => null);

      await upstreamClosed;
      await new Promise((resolve) => setTimeout(resolve, 120));
      controller.abort();
      await request;

      const cookie = await login(slow);
      const found = await waitFor(async () => {
        const res = await fetch(`${baseUrl(slow)}/admin/api/requests?page_size=100`, { headers: { cookie } });
        if (!res.ok) return null;
        const body = (await res.json()) as { items: Array<{ transport_outcome: string; path: string; model: string | null }> };
        const item = body.items.find((entry) => entry.path === '/v1/chat/completions' && entry.model === 'slow-model');
        return item && item.transport_outcome === 'client_cancel' ? item : null;
      }, 8000);
      assert.equal(found.transport_outcome, 'client_cancel');
    } finally {
      await slow.close();
    }
  });
});
