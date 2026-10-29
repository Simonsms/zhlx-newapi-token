import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NewApiLogClient } from '../src/newapi-client.ts';
import { LogSync } from '../src/sync.ts';
import { baseUrl, login, startTestApp, waitFor, type TestContext } from './helpers.ts';

function logEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    created_at: Math.floor(Date.now() / 1000),
    type: 2,
    request_id: 'gw-sync-1',
    model_name: 'gpt-4o-mini',
    prompt_tokens: 100,
    completion_tokens: 50,
    quota: 42,
    user_id: 7,
    username: 'alice',
    token_id: 11,
    token_name: 'alice-key',
    channel: 1,
    ...overrides,
  };
}

describe('原生日志同步与用量统计', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp({ newapiSync: true, captureEnabled: true });
    await waitFor(async () => (await ctx.app.store.getSyncState())?.last_run_at, 5000);
  });

  after(async () => {
    await ctx.close();
  });

  it('全量同步消费事件，重复拉取不重复计数', async () => {
    ctx.upstream.logs.push(
      logEntry({ id: 101 }),
      logEntry({ id: 102, type: 5, prompt_tokens: null, completion_tokens: null, quota: 0 }),
    );

    const first = await ctx.app.sync.syncOnce();
    assert.equal(first.error, null);
    assert.equal(first.inserted, 2);

    const second = await ctx.app.sync.syncOnce();
    assert.equal(second.inserted, 0, '重叠回补不应重复写入');

    const state = await ctx.app.store.getSyncState();
    assert.equal(state?.events_total, 2);
    assert.ok(state?.watermark);

    const cookie = await login(ctx);
    const res = await fetch(`${baseUrl(ctx)}/admin/api/usage?group_by=user`, { headers: { cookie } });
    const body = (await res.json()) as {
      totals: { consume_events: number; error_events: number; prompt_tokens: number; completion_tokens: number; quota: number; active_users: number };
    };
    assert.equal(body.totals.consume_events, 1);
    assert.equal(body.totals.error_events, 1);
    assert.equal(body.totals.prompt_tokens, 100);
    assert.equal(body.totals.completion_tokens, 50);
    assert.equal(body.totals.quota, 42);
    assert.equal(body.totals.active_users, 1);
  });

  it('区分估算与缺失用量，缺失不记为零', async () => {
    ctx.upstream.logs.push(
      logEntry({
        id: 201,
        created_at: Math.floor(Date.now() / 1000) - 10,
        request_id: 'gw-sync-est',
        other: JSON.stringify({ admin_info: { local_count_tokens: true } }),
      }),
      logEntry({
        id: 202,
        created_at: Math.floor(Date.now() / 1000) - 5,
        request_id: 'gw-sync-missing',
        prompt_tokens: null,
        completion_tokens: null,
      }),
    );
    await ctx.app.sync.syncOnce();

    const cookie = await login(ctx);
    const res = await fetch(`${baseUrl(ctx)}/admin/api/overview`, { headers: { cookie } });
    const body = (await res.json()) as {
      totals: { estimated_events: number; missing_events: number };
      usage_sources: Array<{ source: string; count: number }>;
    };
    const sources = Object.fromEntries(body.usage_sources.map((item) => [item.source, item.count]));
    assert.equal(body.totals.missing_events, 1);
    assert.equal(body.totals.estimated_events, 1);
    assert.equal(sources.estimated, 1);
    assert.equal(sources.missing, 1);
  });

  it('按网关请求 ID 关联 Prompt 与用量并下钻', async () => {
    const proxyRes = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-alice' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: '关联测试请求' }] }),
    });
    const proxyRequestId = proxyRes.headers.get('x-proxy-request-id');
    const gatewayId = proxyRes.headers.get('x-oneapi-request-id');
    assert.ok(gatewayId);

    ctx.upstream.logs.push(
      logEntry({ id: 301, request_id: gatewayId, prompt_tokens: 1234, completion_tokens: 88, quota: 99 }),
      logEntry({ id: 302, request_id: gatewayId, type: 5, prompt_tokens: null, completion_tokens: null, quota: 0 }),
    );
    await ctx.app.sync.syncOnce();

    const cookie = await login(ctx);
    const detail = await waitFor(async () => {
      const res = await fetch(`${baseUrl(ctx)}/admin/api/requests/${proxyRequestId}`, { headers: { cookie } });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        request: Record<string, unknown>;
        usage_events: Array<Record<string, unknown>>;
      };
      return body.request.association_status === 'matched' ? body : null;
    });

    assert.equal(detail.request.prompt_text, '关联测试请求');
    assert.equal(detail.request.usage_event_count, 2);
    assert.equal(detail.request.prompt_tokens, 1234);
    assert.equal(detail.request.completion_tokens, 88);
    assert.equal(detail.usage_events.length, 2);

    const overview = await fetch(`${baseUrl(ctx)}/admin/api/overview`, { headers: { cookie } });
    const overviewBody = (await overview.json()) as { association: { matched: number } };
    assert.ok(overviewBody.association.matched >= 1);

    const list = await fetch(`${baseUrl(ctx)}/admin/api/requests?status=matched`, { headers: { cookie } });
    const listBody = (await list.json()) as { items: Array<{ proxy_request_id: string }> };
    assert.ok(listBody.items.some((item) => item.proxy_request_id === proxyRequestId));
  });

  it('同一次请求的多条消费事件不重复累计 Prompt', async () => {
    const proxyRes = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: '多事件' }] }),
    });
    const gatewayId = proxyRes.headers.get('x-oneapi-request-id');
    ctx.upstream.logs.push(
      logEntry({ id: 401, request_id: gatewayId, prompt_tokens: 10, completion_tokens: 1, quota: 1 }),
      logEntry({ id: 402, request_id: gatewayId, prompt_tokens: 20, completion_tokens: 2, quota: 2, token_id: 12 }),
    );
    await ctx.app.sync.syncOnce();

    const cookie = await login(ctx);
    const usage = await fetch(`${baseUrl(ctx)}/admin/api/usage?group_by=day`, { headers: { cookie } });
    const body = (await usage.json()) as { totals: { prompt_tokens: number } };
    assert.equal(body.totals.prompt_tokens, 100 + 100 + 1234 + 10 + 20);
  });

  it('分页拉取超过单页容量的日志', async () => {
    const base = Math.floor(Date.now() / 1000) - 600;
    for (let index = 0; index < 60; index += 1) {
      ctx.upstream.logs.push(
        logEntry({
          id: 500 + index,
          created_at: base + index,
          request_id: `gw-page-${index}`,
          prompt_tokens: 1,
          completion_tokens: 1,
          quota: 1,
          user_id: 8,
          username: 'bob',
        }),
      );
    }
    const report = await ctx.app.sync.syncOnce();
    assert.ok(report.fetched >= 60);
    assert.equal(report.inserted, 60);
    const cookie = await login(ctx);
    const res = await fetch(`${baseUrl(ctx)}/admin/api/usage?group_by=user`, { headers: { cookie } });
    const body = (await res.json()) as { breakdown: Array<{ bucket_label: string; consume_events: number }> };
    const bob = body.breakdown.find((row) => row.bucket_label === 'bob');
    assert.equal(bob?.consume_events, 60);
  });

  it('同步失败时保留水位并记录错误，恢复后继续', async () => {
    const before = await ctx.app.store.getSyncState();
    const brokenClient = new NewApiLogClient({
      baseUrl: ctx.config.newapi.baseUrl as URL,
      adminToken: 'wrong-token',
      adminUserId: null,
      timeoutMs: 5000,
      pageSize: 50,
    });
    const brokenSync = new LogSync(ctx.app.store, brokenClient, ctx.config, ctx.app.metrics, ctx.app.logger);
    await assert.rejects(() => brokenSync.syncOnce(), /HTTP 401|日志接口/);
    const failed = await ctx.app.store.getSyncState();
    assert.equal(failed?.watermark, before?.watermark, '失败不应推进水位');
    assert.ok(failed?.last_error);

    const recovered = await ctx.app.sync.syncOnce();
    assert.equal(recovered.error, null);
    const state = await ctx.app.store.getSyncState();
    assert.equal(state?.last_error, null);
  });
});
