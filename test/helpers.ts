import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { configFromEnv, type Config } from '../src/config.ts';
import { createApp, type App } from '../src/server.ts';

export interface FakeUpstream {
  server: http.Server;
  url: string;
  requests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>;
  logs: Record<string, unknown>[];
  releasePaused(requestId: string): boolean;
  close(): Promise<void>;
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const logs: Record<string, unknown>[] = [];
  const pausedResponses = new Map<string, () => void>();
  let counter = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });

      if ((req.url ?? '').startsWith('/api/log/')) {
        const requestUrl = new URL(req.url ?? '/', 'http://fake');
        if (req.headers.authorization !== 'Bearer test-admin-token') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        const page = Number(requestUrl.searchParams.get('p') ?? '1');
        const pageSize = Number(requestUrl.searchParams.get('page_size') ?? '100');
        const type = Number(requestUrl.searchParams.get('type') ?? '2');
        const start = Number(requestUrl.searchParams.get('start_timestamp') ?? '0');
        const end = Number(requestUrl.searchParams.get('end_timestamp') ?? String(Date.now() / 1000 + 60));
        const filtered = logs.filter((log) => {
          if (Number(log.type) !== type) return false;
          const created = Number(log.created_at);
          return created >= start && created <= end;
        });
        const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '', data: slice }));
        return;
      }

      if (req.url === '/v1/chat/completions' || req.url === '/v1/responses' || req.url === '/v1/messages') {
        if (body.includes('unauthorized-model')) {
          res.writeHead(401, {
            'content-type': 'application/json',
            'x-oneapi-request-id': `gw-err-${++counter}`,
          });
          res.end(JSON.stringify({ error: { message: 'invalid token' } }));
          return;
        }
        counter += 1;
        const requestId = `gw-${counter}`;
        const omitHeader = body.includes('no-header-model');
        const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
        if (!omitHeader) responseHeaders['x-oneapi-request-id'] = requestId;
        if (body.includes('slow-model')) {
          res.writeHead(200, { ...responseHeaders, 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"slow"}}]}\n\n');
          const timer = setTimeout(() => {
            res.write('data: [DONE]\n\n');
            res.end();
          }, 5000);
          res.on('close', () => clearTimeout(timer));
          return;
        }
        if (body.includes('paused-model')) {
          // A12：先发第一段，挂起等待测试方放行，再发剩余内容。
          res.writeHead(200, { ...responseHeaders, 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"FIRST_CHUNK"}}]}\n\n');
          const release = (): void => {
            res.write('data: {"choices":[{"delta":{"content":"SECOND_CHUNK"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          };
          pausedResponses.set(requestId, release);
          res.on('close', () => pausedResponses.delete(requestId));
          return;
        }
        const wantsStream = body.includes('"stream":true') || body.includes('"stream": true');
        if (wantsStream) {
          res.writeHead(200, {
            ...responseHeaders,
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          });
          res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
          setTimeout(() => {
            res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 30);
          return;
        }
        res.writeHead(200, {
          ...responseHeaders,
        });
        res.end(JSON.stringify({ id: requestId, choices: [{ message: { content: 'ok' } }] }));
        return;
      }

      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected path' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    logs,
    releasePaused(requestId: string) {
      const release = pausedResponses.get(requestId);
      if (!release) return false;
      pausedResponses.delete(requestId);
      release();
      return true;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface TestContext {
  app: App;
  upstream: FakeUpstream;
  config: Config;
  dataDir: string;
  close(): Promise<void>;
}

export interface TestOptions {
  captureEnabled?: boolean;
  newapiSync?: boolean;
  env?: Record<string, string>;
}

export async function startTestApp(options: TestOptions = {}): Promise<TestContext> {
  const upstream = await startFakeUpstream();
  const dataDir = mkdtempSync(join(tmpdir(), 'zhlx-test-'));
  const env: NodeJS.ProcessEnv = {
    PORT: '0',
    HOST: '127.0.0.1',
    DEPLOYMENT_ID: 'test-deploy',
    LOG_LEVEL: 'error',
    UPSTREAM_URL: upstream.url,
    DATABASE_URL: `file:${join(dataDir, 'test.db')}`,
    ADMIN_API_TOKEN: 'test-admin-token',
    SESSION_SECRET: 'test-session-secret',
    CAPTURE_ENABLED: options.captureEnabled ? 'true' : 'false',
    CAPTURE_MAX_BYTES: '65536',
    CAPTURE_MAX_CHARS: '2000',
    QUEUE_FLUSH_MS: '20',
    QUEUE_BATCH_SIZE: '50',
    PROMPT_RETENTION_DAYS: '30',
    NEWAPI_LOG_SYNC_ENABLED: options.newapiSync ? 'true' : 'false',
    NEWAPI_BASE_URL: upstream.url,
    NEWAPI_ADMIN_TOKEN: 'test-admin-token',
    NEWAPI_LOG_PAGE_SIZE: '50',
    NEWAPI_LOG_SAFETY_LAG_MS: '0',
    NEWAPI_LOG_INITIAL_BACKFILL_HOURS: '24',
    NEWAPI_LOG_OVERLAP_MS: '600000',
    ASSOCIATION_PENDING_WINDOW_MS: '60000',
    ...options.env,
  };

  const config = configFromEnv(env);
  let app: App;
  try {
    app = await createApp(config);
  } catch (error) {
    await upstream.close();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    app,
    upstream,
    config,
    dataDir,
    async close() {
      await app.close();
      await upstream.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function baseUrl(ctx: TestContext): string {
  const address = ctx.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

export function adminBase(ctx: TestContext): string {
  return `${baseUrl(ctx) ?? ''}${ctx.config.adminPath}`;
}

export function healthUrl(ctx: TestContext): string {
  return `${baseUrl(ctx)}${ctx.config.healthPath}`;
}

export async function login(ctx: TestContext, token = 'test-admin-token'): Promise<string> {
  const response = await fetch(`${baseUrl(ctx)}${ctx.config.adminPath}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('missing set-cookie');
  return cookie.split(';')[0] ?? '';
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result as T;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timeout${lastError ? `: ${(lastError as Error).message}` : ''}`);
}
