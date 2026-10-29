import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import {
  AdminAuth,
  clientIp,
  parseInteger,
  parseIsoRange,
  parseOptionalId,
  readJsonBody,
  sendJson,
  sendText,
} from './http-helpers.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import type { Store } from './store/store.ts';
import type { AssociationStatus } from './store/types.ts';
import { renderAdminPage } from './ui.ts';

export interface AdminDeps {
  config: Config;
  store: Store;
  auth: AdminAuth;
  metrics: Metrics;
  logger: Logger;
}

const ALLOWED_STATUSES = new Set<AssociationStatus>(['matched', 'pending', 'unmatched', 'no_gateway_id']);

export function createAdminHandler(deps: AdminDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, store, auth, metrics, logger } = deps;

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    void (async () => {
      try {
        await route(req, res, url);
      } catch (error) {
        logger.error('admin_request_failed', {
          path: url.pathname,
          error: (error as Error).message,
        });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.destroy();
      }
    })();
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/admin' || path === '/admin/') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
        return;
      }
      sendText(res, 200, renderAdminPage(), 'text/html; charset=utf-8', {
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
      return;
    }

    if (path === '/admin/login') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return;
      }
      if (!auth.configured) {
        sendJson(res, 503, { error: 'admin_not_configured' });
        return;
      }
      const ip = clientIp(req, config.trustProxyHeaders);
      if (auth.isRateLimited(ip)) {
        metrics.authFailures += 1;
        sendJson(res, 429, { error: 'too_many_attempts' });
        return;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { error: parsed.reason });
        return;
      }
      const value = parsed.value;
      const token = typeof value === 'object' && value !== null && typeof (value as { token?: unknown }).token === 'string'
        ? (value as { token: string }).token
        : '';
      if (!token || !auth.checkToken(token)) {
        auth.registerFailure(ip);
        metrics.authFailures += 1;
        logger.warn('admin_login_failed', { ip });
        sendJson(res, 401, { error: 'invalid_credentials' });
        return;
      }
      sendJson(res, 200, { ok: true }, { 'set-cookie': auth.createSessionCookie() });
      return;
    }

    if (path === '/admin/logout') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return;
      }
      sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearSessionCookie() });
      return;
    }

    if (path === '/admin/session') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
        return;
      }
      sendJson(res, 200, {
        authenticated: auth.isAuthenticated(req),
        configured: auth.configured,
        captured_enabled: config.captureEnabled,
        deployment_id: config.deploymentId,
      });
      return;
    }

    if (!path.startsWith('/admin/api/')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (!auth.configured) {
      sendJson(res, 503, { error: 'admin_not_configured' });
      return;
    }
    if (!auth.isAuthenticated(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return;
    }

    if (path === '/admin/api/overview') {
      const range = parseIsoRange(url);
      if (!range.ok) {
        sendJson(res, 400, { error: range.reason });
        return;
      }
      const filter = { from: range.from.toISOString(), to: range.to.toISOString() };
      const [totals, capturedTotals, capture, association, usageSources, sync, identity] = await Promise.all([
        store.usageTotals(filter),
        store.usageTotals(filter, true),
        store.captureStats(filter),
        store.associationCounts(filter, config.associationPendingWindowMs),
        store.usageSourceCounts(filter),
        store.getSyncState(),
        store.identityStats(filter, config.identityMode),
      ]);
      sendJson(res, 200, {
        from: filter.from,
        to: filter.to,
        deployment_id: config.deploymentId,
        capture_enabled: config.captureEnabled,
        identity_mode: identity.mode,
        identity_configured: config.identityMode,
        identity_stats: { distinct_users: identity.distinct_users, distinct_tokens: identity.distinct_tokens },
        totals,
        captured_totals: capturedTotals,
        capture,
        association,
        usage_sources: usageSources,
        sync,
        metrics: {
          metadata_dropped: metrics.droppedMetadata,
          content_dropped: metrics.droppedContent,
          write_errors: metrics.writeErrors,
          last_write_error: metrics.lastWriteError,
          started_at: metrics.startedAt,
        },
      });
      return;
    }

    if (path === '/admin/api/usage') {
      const range = parseIsoRange(url);
      if (!range.ok) {
        sendJson(res, 400, { error: range.reason });
        return;
      }
      const userIdRaw = url.searchParams.get('user_id');
      const tokenIdRaw = url.searchParams.get('token_id');
      const model = url.searchParams.get('model');
      const filter = {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        userId: parseOptionalId(userIdRaw),
        tokenId: parseOptionalId(tokenIdRaw),
        model: model && model.length > 0 ? model : null,
      };
      const groupByRaw = url.searchParams.get('group_by') ?? 'identity';
      const identity = await store.identityStats(
        { from: filter.from, to: filter.to },
        config.identityMode,
      );
      const effectiveGroup =
        groupByRaw === 'identity' ? identity.mode : groupByRaw;
      if (effectiveGroup !== 'day' && effectiveGroup !== 'user' && effectiveGroup !== 'token' && effectiveGroup !== 'model') {
        sendJson(res, 400, { error: 'invalid_group_by' });
        return;
      }
      const [totals, breakdown] = await Promise.all([
        store.usageTotals(filter),
        store.usageBreakdown(filter, effectiveGroup),
      ]);
      sendJson(res, 200, {
        from: filter.from,
        to: filter.to,
        group_by: effectiveGroup,
        identity_mode: identity.mode,
        identity_configured: config.identityMode,
        totals,
        breakdown,
      });
      return;
    }

    if (path === '/admin/api/requests') {
      const range = parseIsoRange(url);
      if (!range.ok) {
        sendJson(res, 400, { error: range.reason });
        return;
      }
      const statusRaw = url.searchParams.get('status');
      let status: AssociationStatus | null = null;
      if (statusRaw) {
        if (!ALLOWED_STATUSES.has(statusRaw as AssociationStatus)) {
          sendJson(res, 400, { error: 'invalid_status' });
          return;
        }
        status = statusRaw as AssociationStatus;
      }
      const userIdRaw = url.searchParams.get('user_id');
      const tokenIdRaw = url.searchParams.get('token_id');
      const model = url.searchParams.get('model');
      const query = url.searchParams.get('q');
      const page = parseInteger(url.searchParams.get('page'), 1, 1, 100_000);
      const pageSize = parseInteger(url.searchParams.get('page_size'), 25, 1, 100);
      const filter = {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        userId: parseOptionalId(userIdRaw),
        tokenId: parseOptionalId(tokenIdRaw),
        model: model && model.length > 0 ? model : null,
        status,
        query: query && query.length > 0 ? query.slice(0, 200) : null,
        page,
        pageSize,
      };
      const result = await store.listProxyRequests(filter, config.associationPendingWindowMs);
      sendJson(res, 200, {
        from: filter.from,
        to: filter.to,
        page,
        page_size: pageSize,
        total: result.total,
        items: result.items,
      });
      return;
    }

    const detailMatch = /^\/admin\/api\/requests\/([^/]+)$/.exec(path);
    if (detailMatch) {
      const proxyRequestId = decodeURIComponent(detailMatch[1] ?? '');
      const result = await store.getProxyRequest(proxyRequestId, config.associationPendingWindowMs);
      if (!result) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      await store.audit('admin', 'read_request_detail', JSON.stringify({ proxy_request_id: proxyRequestId }));
      sendJson(res, 200, {
        request: result.request,
        usage_events: result.usage_events,
      });
      return;
    }

    if (path === '/admin/api/capture-quality') {
      const range = parseIsoRange(url);
      if (!range.ok) {
        sendJson(res, 400, { error: range.reason });
        return;
      }
      const filter = { from: range.from.toISOString(), to: range.to.toISOString() };
      const [capture, skipReasons, association] = await Promise.all([
        store.captureStats(filter),
        store.captureSkipReasons(filter),
        store.associationCounts(filter, config.associationPendingWindowMs),
      ]);
      sendJson(res, 200, { from: filter.from, to: filter.to, capture, skip_reasons: skipReasons, association });
      return;
    }

    if (path === '/admin/api/sync') {
      sendJson(res, 200, { sync: await store.getSyncState() });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }
}
