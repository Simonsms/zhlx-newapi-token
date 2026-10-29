import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { adminBase, baseUrl, healthUrl, login, startTestApp, waitFor, type TestContext } from './helpers.ts';

describe('管理员认证与权限边界', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp({ captureEnabled: true });
  });

  after(async () => {
    await ctx.close();
  });

  it('未认证访问管理 API 返回 401', async () => {
    const res = await fetch(`${adminBase(ctx)}/api/overview`);
    assert.equal(res.status, 401);
  });

  it('错误令牌无法登录，正确令牌建立会话', async () => {
    const bad = await fetch(`${adminBase(ctx)}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    assert.equal(bad.status, 401);

    const cookie = await login(ctx);
    const session = await fetch(`${adminBase(ctx)}/session`, { headers: { cookie } });
    const body = (await session.json()) as { authenticated: boolean; configured: boolean };
    assert.equal(body.authenticated, true);
    assert.equal(body.configured, true);
  });

  it('篡改会话 Cookie 被拒绝', async () => {
    const cookie = await login(ctx);
    const tampered = `${cookie}x`;
    const res = await fetch(`${adminBase(ctx)}/api/overview`, { headers: { cookie: tampered } });
    assert.equal(res.status, 401);
  });

  it('退出登录后会话失效', async () => {
    const cookie = await login(ctx);
    await fetch(`${adminBase(ctx)}/logout`, { method: 'POST', headers: { cookie } });
    const res = await fetch(`${adminBase(ctx)}/api/overview`);
    assert.equal(res.status, 401);
  });

  it('非管理员无法读取 Prompt 详情且不产生审计记录', async () => {
    const proxyRes = await fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: '权限测试' }] }),
    });
    const proxyRequestId = proxyRes.headers.get('x-proxy-request-id');
    assert.ok(proxyRequestId);

    await waitFor(async () => {
      const res = await fetch(`${adminBase(ctx)}/api/requests/${proxyRequestId}`);
      return res.status === 401;
    });

    const auditBefore = await ctx.app.store.countAudit();
    const res = await fetch(`${adminBase(ctx)}/api/requests/${proxyRequestId}`);
    assert.equal(res.status, 401);
    assert.equal(await ctx.app.store.countAudit(), auditBefore);

    const cookie = await login(ctx);
    const authed = await waitFor(async () => {
      const res = await fetch(`${adminBase(ctx)}/api/requests/${proxyRequestId}`, { headers: { cookie } });
      return res.status === 200 ? res : null;
    });
    assert.equal(authed.status, 200);
    assert.ok((await ctx.app.store.countAudit()) > auditBefore, '授权读取详情应写入审计');
  });

  it('健康检查不暴露管理数据', async () => {
    const res = await fetch(`${healthUrl(ctx)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.queue instanceof Object, true);
    assert.equal('admin_token' in body, false);
  });

  it('管理页面返回带 CSP 的 HTML', async () => {
    const res = await fetch(`${adminBase(ctx)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /nonce=/);
    assert.doesNotMatch(html, /test-admin-token/);
  });
});
