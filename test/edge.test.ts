import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BoundedQueue, ProxyWriter } from '../src/store/writer.ts';
import { createLogger, silentLogger } from '../src/logger.ts';
import { createMetrics } from '../src/metrics.ts';
import { configFromEnv } from '../src/config.ts';
import { openDatabase } from '../src/store/open.ts';
import { Store } from '../src/store/store.ts';
import type { ProxyRequestInsert } from '../src/store/types.ts';
import { baseUrl, login, startTestApp, waitFor, type TestContext } from './helpers.ts';

function sampleRow(overrides: Partial<ProxyRequestInsert> = {}): ProxyRequestInsert {
  return {
    proxy_request_id: 'pr-1',
    deployment_id: 'dep',
    newapi_request_id: 'gw-1',
    received_at: new Date().toISOString(),
    method: 'POST',
    path: '/v1/chat/completions',
    http_status: 200,
    transport_outcome: 'completed',
    capture_status: 'captured',
    skip_reason: null,
    prompt_text: 'hello',
    prompt_scope: 'last_user_message',
    prompt_chars: 5,
    prompt_truncated: 0,
    extraction_version: 'extract-v1',
    redaction_version: 'redact-v1',
    model: 'gpt-4o-mini',
    is_stream: 0,
    duration_ms: 10,
    ...overrides,
  };
}

describe('有界队列', () => {
  it('超过容量时拒绝并计数，FIFO 出队', () => {
    const queue = new BoundedQueue<number>(2);
    assert.equal(queue.push(1), true);
    assert.equal(queue.push(2), true);
    assert.equal(queue.push(3), false);
    assert.equal(queue.droppedCount, 1);
    assert.deepEqual(queue.drain(10), [1, 2]);
    assert.equal(queue.size, 0);
  });

  it('正文队列满时降级为 dropped 元数据行', async () => {
    const db = await openDatabase(':memory:');
    const store = new Store(db, 'dep');
    const config = configFromEnv({
      CAPTURE_ENABLED: 'true',
      QUEUE_MAX_CONTENT: '1',
      QUEUE_MAX_METADATA: '10',
      DATABASE_URL: ':memory:',
    });
    const metrics = createMetrics();
    const writer = new ProxyWriter(store, config, metrics, silentLogger);
    try {
      writer.enqueue(sampleRow({ proxy_request_id: 'pr-a' }), true);
      writer.enqueue(sampleRow({ proxy_request_id: 'pr-b' }), true);
      assert.equal(metrics.droppedContent, 1);
      await writer.stop();
      const rows = await store.raw<{ proxy_request_id: string; capture_status: string; prompt_text: string | null }>(
        'SELECT proxy_request_id, capture_status, prompt_text FROM proxy_request ORDER BY proxy_request_id',
      );
      assert.equal(rows.length, 2);
      const dropped = rows.find((row) => row.proxy_request_id === 'pr-b');
      assert.equal(dropped?.capture_status, 'dropped');
      assert.equal(dropped?.prompt_text, null);
    } finally {
      await db.close();
    }
  });

  it('写库失败只计数，不抛出到调用方', async () => {
    const db = await openDatabase(':memory:');
    const store = new Store(db, 'dep');
    await db.execute('DROP TABLE proxy_request');
    const config = configFromEnv({ DATABASE_URL: ':memory:' });
    const metrics = createMetrics();
    const writer = new ProxyWriter(store, config, metrics, createLogger('error'));
    try {
      writer.enqueue(sampleRow(), false);
      await writer.flush();
      assert.equal(metrics.writeErrors, 1);
      assert.ok(metrics.lastWriteError);
    } finally {
      await db.close();
    }
  });
});

describe('采集开关与失败路径', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp({ captureEnabled: false });
  });

  after(async () => {
    await ctx.close();
  });

  async function detailFor(proxyRequestId: string): Promise<Record<string, unknown>> {
    const cookie = await login(ctx);
    return waitFor(async () => {
      const res = await fetch(`${baseUrl(ctx)}/admin/api/requests/${proxyRequestId}`, { headers: { cookie } });
      if (!res.ok) return null;
      const body = (await res.json()) as { request: Record<string, unknown> };
      return body.request;
    });
  }

  it('关闭采集时全链路不保存正文', async () => {
    const res = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'secret prompt text' }] }),
    });
    const proxyRequestId = res.headers.get('x-proxy-request-id');
    assert.ok(proxyRequestId);
    const detail = await detailFor(proxyRequestId);
    assert.equal(detail.capture_status, 'disabled');
    assert.equal(detail.prompt_text, null);

    const cookie = await login(ctx);
    const quality = await fetch(`${baseUrl(ctx)}/admin/api/capture-quality`, { headers: { cookie } });
    const body = (await quality.json()) as { capture: { disabled: number } };
    assert.ok(body.capture.disabled >= 1);
  });

  it('上游 401 不采正文且保留用户可见错误', async () => {
    const res = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unauthorized-model', messages: [{ role: 'user', content: 'should not persist' }] }),
    });
    assert.equal(res.status, 401);
    const proxyRequestId = res.headers.get('x-proxy-request-id');
    const detail = await detailFor(proxyRequestId ?? '');
    assert.equal(detail.capture_status, 'disabled');
    assert.equal(detail.prompt_text, null);
  });

  it('保留期到期后正文不可读取', async () => {
    const db = await openDatabase(':memory:');
    const store = new Store(db, 'dep');
    try {
      const past = new Date(Date.now() - 90 * 86_400_000).toISOString();
      await store.insertProxyRequests([sampleRow({ deployment_id: 'dep', received_at: past })]);
      const expired = await store.expirePrompts(new Date(Date.now() - 30 * 86_400_000).toISOString());
      assert.equal(expired, 1);
      const row = await store.raw<{ prompt_text: string | null; capture_status: string }>(
        'SELECT prompt_text, capture_status FROM proxy_request',
      );
      assert.equal(row[0]?.prompt_text, null);
      assert.equal(row[0]?.capture_status, 'expired');
    } finally {
      await db.close();
    }
  });
});
