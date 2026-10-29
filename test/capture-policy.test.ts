import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { adminBase, baseUrl, login, startTestApp, waitFor, type TestContext } from './helpers.ts';

async function detailFor(ctx: TestContext, proxyRequestId: string): Promise<Record<string, unknown>> {
  const cookie = await login(ctx);
  return waitFor(async () => {
    const res = await fetch(`${adminBase(ctx)}/api/requests/${proxyRequestId}`, { headers: { cookie } });
    if (!res.ok) return null;
    const body = (await res.json()) as { request: Record<string, unknown> };
    return body.request;
  });
}

function post(ctx: TestContext, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl(ctx)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-capture-test', ...headers },
    body: JSON.stringify(body),
  });
}

describe('T3 大输入与降级', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp({
      captureEnabled: true,
      env: { CAPTURE_MAX_CHARS: '300', CAPTURE_MAX_BYTES: '65536' },
    });
  });

  after(async () => {
    await ctx.close();
  });

  it('A09 记录实际观察字节数并标记读取完整', async () => {
    const payload = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: '计量测试'.repeat(200) }],
    };
    const res = await post(ctx, '/v1/chat/completions', payload);
    assert.equal(res.status, 200);
    const id = res.headers.get('x-proxy-request-id');
    const detail = await detailFor(ctx, id ?? '');
    const expectedBytes = Buffer.byteLength(JSON.stringify(payload));
    assert.equal(detail.request_bytes, expectedBytes, '应与实际发送的 JSON 字节数一致');
    assert.equal(detail.request_bytes_complete, 1);
  });

  it('A09 超过采集上限时仍继续计量并标记不完整或超限', async () => {
    const big = 'x'.repeat(90_000);
    const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: big }] };
    const res = await post(ctx, '/v1/chat/completions', payload);
    assert.equal(res.status, 200);
    const id = res.headers.get('x-proxy-request-id');
    const detail = await detailFor(ctx, id ?? '');
    assert.equal(detail.capture_status, 'skipped');
    assert.equal(detail.skip_reason, 'over_limit');
    assert.equal(detail.prompt_text, null);
    assert.equal(detail.request_bytes, Buffer.byteLength(JSON.stringify(payload)), '超限后仍需计量全部字节');
    assert.equal(detail.request_bytes_complete, 1);
  });

  it('A04 长文本在代理层被头尾节选并标记截断', async () => {
    const head = '开头任务：请阅读下面的材料。';
    const tail = '结尾问题：请给出结论。';
    const payload = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `${head}${'材料。'.repeat(2000)}${tail}` }],
    };
    const res = await post(ctx, '/v1/chat/completions', payload);
    const id = res.headers.get('x-proxy-request-id');
    const detail = await detailFor(ctx, id ?? '');
    assert.equal(detail.capture_status, 'captured');
    assert.equal(detail.prompt_truncated, 1);
    assert.match(String(detail.prompt_scope), /\+excerpt$/);
    assert.ok(Number(detail.prompt_chars) <= 300);
    const prompt = String(detail.prompt_text);
    assert.match(prompt, /中间省略 \d+ 字/);
    assert.match(prompt, /结尾问题/);
  });

  it('A09 并发预算耗尽后只记元数据，推理不受影响且预算可回收', async () => {
    const tight = await startTestApp({
      captureEnabled: true,
      // 单请求上限足够容纳测试体；总预算只允许一个请求同时预留。
      env: { CAPTURE_MAX_BYTES: '8192', CAPTURE_MAX_TOTAL_BYTES: '8192' },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          fetch(`${baseUrl(tight)}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [{ role: 'user', content: `并发请求 ${index} `.repeat(400) }],
            }),
          }),
        ),
      );
      for (const response of results) assert.equal(response.status, 200);

      const cookie = await login(tight);
      const stats = await waitFor(async () => {
        const res = await fetch(`${adminBase(tight)}/api/capture-quality`, { headers: { cookie } });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          capture: { total: number };
          outcomes: { limit: number; metadata: number; text: number; excerpt: number };
        };
        return body.capture.total >= 8 ? body : null;
      });
      assert.ok(stats.capture.total >= 8);
      const collected = stats.outcomes.text + stats.outcomes.excerpt;
      assert.ok(
        collected + stats.outcomes.limit >= 8,
        '并发请求应全部归入已采集或资源受限，不能凭空消失',
      );
      assert.ok(stats.outcomes.limit > 0, '并发超出总预算时应记录资源受限');

      // 释放后再发一次小请求，应能重新采集。
      const retry = await post(tight, '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: '预算回收后的新请求' }],
      });
      const retryId = retry.headers.get('x-proxy-request-id');
      const retryDetail = await detailFor(tight, retryId ?? '');
      assert.equal(retryDetail.capture_status, 'captured');
    } finally {
      await tight.close();
    }
  });

  it('A03 工具材料后的独立任务文字被提取，材料本身不入库', async () => {
    const res = await post(ctx, '/v1/messages', {
      model: 'claude',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '{"huge":"'.concat('x'.repeat(5000)).concat('"}') },
            { type: 'text', text: '请概括工具结果，并给出三点建议。' },
          ],
        },
      ],
    });
    const id = res.headers.get('x-proxy-request-id');
    const detail = await detailFor(ctx, id ?? '');
    assert.equal(detail.capture_status, 'captured');
    assert.equal(detail.prompt_text, '请概括工具结果，并给出三点建议。');
    assert.doesNotMatch(String(detail.prompt_text), /huge/);
  });

  it('A05 只有附件时无正文并记录附件类型', async () => {
    const res = await post(ctx, '/v1/responses', {
      model: 'gpt-4o-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_file', file_id: 'file_abc', size: 2048 }],
        },
      ],
    });
    const id = res.headers.get('x-proxy-request-id');
    const detail = await detailFor(ctx, id ?? '');
    assert.equal(detail.capture_status, 'skipped');
    assert.equal(detail.skip_reason, 'attachment_only');
    assert.equal(detail.prompt_text, null);
    const summary = detail.content_summary as { attachment_count: number; attachment_types: string[]; declared_bytes: number };
    assert.equal(summary.attachment_count, 1);
    assert.deepEqual(summary.attachment_types, ['input_file']);
    assert.equal(summary.declared_bytes, 2048);
    assert.doesNotMatch(JSON.stringify(detail), /file_abc/);
  });
});

describe('T3 关闭采集时不做正文复制与解析', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp({ captureEnabled: false });
  });

  after(async () => {
    await ctx.close();
  });

  it('A11 关闭时无正文、无解析，但仍记录字节数', async () => {
    const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '关闭采集测试' }] };
    const res = await post(ctx, '/v1/chat/completions', payload);
    assert.equal(res.status, 200);
    const id = res.headers.get('x-proxy-request-id');
    const detail = await detailFor(ctx, id ?? '');
    assert.equal(detail.capture_status, 'disabled');
    assert.equal(detail.prompt_text, null);
    assert.equal(detail.model, null, '关闭时不应解析 JSON 取 model');
    assert.equal(detail.request_bytes, Buffer.byteLength(JSON.stringify(payload)));
    assert.equal(detail.request_bytes_complete, 1);
  });

  it('A11 开启采集后上游 401 仍不保存正文', async () => {
    const enabled = await startTestApp({ captureEnabled: true });
    try {
      const res = await fetch(`${baseUrl(enabled)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'unauthorized-model', messages: [{ role: 'user', content: '不应保存' }] }),
      });
      assert.equal(res.status, 401);
      const id = res.headers.get('x-proxy-request-id');
      const detail = await detailFor(enabled, id ?? '');
      assert.equal(detail.capture_status, 'skipped');
      assert.equal(detail.skip_reason, 'upstream_status');
      assert.equal(detail.prompt_text, null);
    } finally {
      await enabled.close();
    }
  });
});

describe('A12 流式转发与 A13 用量口径', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp({ captureEnabled: true, newapiSync: true });
  });

  after(async () => {
    await ctx.close();
  });

  it('A12 上游未结束前客户端即可读到第一段，后续字节一致', async () => {
    const response = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'paused-model',
        stream: true,
        messages: [{ role: 'user', content: '流式首段验证' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.body, '应返回可读流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let received = '';
    // 上游此时仍处于挂起状态；若代理等待整段结束，这里会超时读不到内容。
    const deadline = Date.now() + 4000;
    while (!received.includes('FIRST_CHUNK')) {
      assert.ok(Date.now() < deadline, '上游结束前未收到第一段，说明代理缓冲了整段响应');
      const next = await reader.read();
      if (next.done) break;
      received += decoder.decode(next.value, { stream: true });
    }
    assert.match(received, /FIRST_CHUNK/);

    const gatewayId = response.headers.get('x-oneapi-request-id') ?? '';
    assert.ok(ctx.upstream.releasePaused(gatewayId), '应能放行被挂起的上游响应');

    let rest = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }
    assert.match(rest, /SECOND_CHUNK/);
    assert.match(rest, /\[DONE\]/);
  });

  it('A13 无正文请求仍计入原生用量总量', async () => {
    const now = Math.floor(Date.now() / 1000);
    ctx.upstream.logs.push(
      {
        id: 9001, created_at: now, type: 2, request_id: 'gw-no-prompt', model_name: 'gpt-4o-mini',
        prompt_tokens: 1000, completion_tokens: 50, quota: 700, user_id: 3, username: 'carol',
        token_id: 41, token_name: 'carol-key', channel: 1,
      },
      {
        id: 9002, created_at: now, type: 2, request_id: 'gw-with-prompt', model_name: 'gpt-4o-mini',
        prompt_tokens: 2000, completion_tokens: 60, quota: 900, user_id: 4, username: 'dave',
        token_id: 42, token_name: 'dave-key', channel: 1,
      },
    );
    await ctx.app.sync.syncOnce();

    const cookie = await login(ctx);
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const res = await fetch(`${adminBase(ctx)}/api/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      totals: { consume_events: number; prompt_tokens: number };
      captured_totals: { consume_events: number; prompt_tokens: number };
    };
    assert.ok(body.totals.consume_events >= 2, '全量应包含无正文请求');
    assert.ok(body.totals.prompt_tokens >= 3000);
    assert.ok(
      body.captured_totals.consume_events <= body.totals.consume_events,
      '有正文子集不能超过全量',
    );
  });
});
