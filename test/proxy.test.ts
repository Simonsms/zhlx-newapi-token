import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { baseUrl, login, startTestApp, waitFor, type TestContext } from './helpers.ts';

describe('代理转发与 Prompt 采集', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp({ captureEnabled: true });
  });

  after(async () => {
    await ctx.close();
  });

  it('透传原 Key 并记录网关请求 ID，采集脱敏 Prompt', async () => {
    const response = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-user-secret-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'system prompt must not be captured' },
          { role: 'user', content: '帮我排查问题，联系邮箱 user@example.com，Key 是 sk-abcdefghijklmnop' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const proxyRequestId = response.headers.get('x-proxy-request-id');
    assert.ok(proxyRequestId);
    assert.equal(response.headers.get('x-oneapi-request-id'), 'gw-1');

    const forwarded = ctx.upstream.requests.at(-1);
    assert.equal(forwarded?.headers.authorization, 'Bearer sk-user-secret-key');
    assert.equal(forwarded?.headers['x-proxy-request-id'], undefined);

    const detail = await waitFor(async () => {
      const cookie = await login(ctx);
      const res = await fetch(`${baseUrl(ctx)}/admin/api/requests/${proxyRequestId}`, {
        headers: { cookie },
      });
      if (!res.ok) return null;
      return (await res.json()) as {
        request: Record<string, unknown>;
      };
    });

    assert.equal(detail.request.capture_status, 'captured');
    assert.equal(detail.request.prompt_scope, 'last_user_message');
    assert.equal(detail.request.model, 'gpt-4o-mini');
    const prompt = String(detail.request.prompt_text);
    assert.match(prompt, /\[REDACTED:EMAIL\]/);
    assert.match(prompt, /\[REDACTED:API_KEY\]/);
    assert.doesNotMatch(prompt, /user@example\.com/);
    assert.doesNotMatch(prompt, /sk-abcdefghijklmnop/);
    assert.doesNotMatch(prompt, /system prompt must not be captured/);
    assert.equal(detail.request.newapi_request_id, 'gw-1');
  });

  it('SSE 逐块回传且不等待采集写库', async () => {
    const response = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-user-2',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: '流式测试' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /hello|he/);
    assert.match(text, /\[DONE\]/);
  });

  it('响应没有网关请求 ID 时记录 no_gateway_id', async () => {
    const response = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-user-3',
      },
      body: JSON.stringify({
        model: 'no-header-model',
        messages: [{ role: 'user', content: '缺少响应头' }],
      }),
    });
    const proxyRequestId = response.headers.get('x-proxy-request-id');
    const cookie = await login(ctx);
    const detail = await waitFor(async () => {
      const res = await fetch(`${baseUrl(ctx)}/admin/api/requests/${proxyRequestId}`, { headers: { cookie } });
      if (!res.ok) return null;
      return (await res.json()) as { request: Record<string, unknown> };
    });
    assert.equal(detail.request.newapi_request_id, null);
    assert.equal(detail.request.association_status, 'no_gateway_id');
  });

  it('超出采集上限时跳过正文但完整转发请求', async () => {
    const big = 'x'.repeat(70_000);
    const upstreamBefore = ctx.upstream.requests.length;
    const response = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-user-4' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: big }] }),
    });
    assert.equal(response.status, 200);
    const forwarded = ctx.upstream.requests.at(-1);
    assert.equal(ctx.upstream.requests.length, upstreamBefore + 1);
    const expectedLength = Buffer.byteLength(
      JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: big }] }),
    );
    assert.equal(Buffer.byteLength(forwarded?.body ?? ''), expectedLength);

    const proxyRequestId = response.headers.get('x-proxy-request-id');
    const detail = await waitFor(async () => {
      const cookie = await login(ctx);
      const res = await fetch(`${baseUrl(ctx)}/admin/api/requests/${proxyRequestId}`, { headers: { cookie } });
      if (!res.ok) return null;
      return (await res.json()) as { request: Record<string, unknown> };
    });
    assert.equal(detail.request.capture_status, 'skipped');
    assert.equal(detail.request.skip_reason, 'over_limit');
    assert.equal(detail.request.prompt_text, null);
  });

  it('上游不可达时返回 502 并记录终态', async () => {
    const failing = await startTestApp({
      captureEnabled: true,
      env: { UPSTREAM_URL: 'http://127.0.0.1:1' },
    });
    try {
      const response = await fetch(`${baseUrl(failing)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('x-proxy-request-id'), null);
    } finally {
      await failing.close();
    }
  });
});
