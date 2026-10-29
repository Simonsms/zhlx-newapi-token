import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createAdminHandler } from './admin.ts';
import { configFromEnv, type Config } from './config.ts';
import { createProxyHandler } from './proxy.ts';
import { AdminAuth, sendJson } from './http-helpers.ts';
import { createLogger, type Logger } from './logger.ts';
import { createMetrics, type Metrics } from './metrics.ts';
import { NewApiLogClient, SqliteLogSource, type LogSource } from './newapi-client.ts';
import { openDatabase } from './store/open.ts';
import type { Db } from './store/db.ts';
import { Store } from './store/store.ts';
import { ProxyWriter } from './store/writer.ts';
import { LogSync } from './sync.ts';

export interface App {
  server: http.Server;
  config: Config;
  store: Store;
  db: Db;
  metrics: Metrics;
  writer: ProxyWriter;
  sync: LogSync;
  logger: Logger;
  close(): Promise<void>;
}

const CLEANUP_LOCK: { current: Promise<void> | null } = { current: null };

export async function createApp(config: Config = configFromEnv()): Promise<App> {
  const logger = createLogger(config.logLevel);
  const metrics = createMetrics();
  const db = await openDatabase(config.databaseUrl);
  const store = new Store(db, config.deploymentId);
  const writer = new ProxyWriter(store, config, metrics, logger);
  const auth = new AdminAuth(config);

  let client: LogSource | null = null;
  if (config.newapi.enabled) {
    if (config.newapi.sqlitePath) {
      client = new SqliteLogSource({ path: config.newapi.sqlitePath });
    } else if (config.newapi.baseUrl && config.newapi.adminToken) {
      client = new NewApiLogClient({
        baseUrl: config.newapi.baseUrl,
        adminToken: config.newapi.adminToken,
        adminUserId: config.newapi.adminUserId,
        timeoutMs: config.newapi.timeoutMs,
        pageSize: config.newapi.pageSize,
      });
    }
  }
  const sync = new LogSync(store, client, config, metrics, logger);

  const proxyHandler = createProxyHandler({ config, writer, logger });
  const adminHandler = createAdminHandler({
    config,
    store,
    auth,
    metrics,
    logger,
  });

  let cleanupTimer: NodeJS.Timeout | null = null;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname;
    if (pathname === config.healthPath) {
      sendJson(res, 200, {
        ok: true,
        deployment_id: config.deploymentId,
        capture_enabled: config.captureEnabled,
        queue: writer.queueSizes,
        uptime_s: Math.floor((Date.now() - new Date(metrics.startedAt).getTime()) / 1000),
      });
      return;
    }
    if (pathname === config.adminPath || pathname.startsWith(`${config.adminPath}/`)) {
      adminHandler(req, res);
      return;
    }
    proxyHandler(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });

  writer.start();
  sync.start();

  const cleanup = async (): Promise<void> => {
    if (CLEANUP_LOCK.current) return CLEANUP_LOCK.current;
    const task = (async () => {
      const cutoff = new Date(Date.now() - config.promptRetentionDays * 86_400_000).toISOString();
      const expired = await store.expirePrompts(cutoff);
      if (expired > 0) logger.info('prompt_retention_applied', { expired, cutoff });
    })()
      .catch((error: unknown) => {
        logger.error('prompt_retention_failed', { error: (error as Error).message });
      })
      .finally(() => {
        CLEANUP_LOCK.current = null;
      });
    CLEANUP_LOCK.current = task;
    return task;
  };

  void cleanup();
  cleanupTimer = setInterval(() => {
    void cleanup();
  }, config.cleanupIntervalMs);
  cleanupTimer.unref();

  return {
    server,
    config,
    store,
    db,
    metrics,
    writer,
    sync,
    logger,
    async close() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      sync.stop();
      const forceClose = setTimeout(() => {
        server.closeAllConnections();
      }, 10_000);
      forceClose.unref();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      clearTimeout(forceClose);
      await writer.stop();
      await db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = configFromEnv();
    const app = await createApp(config);
    const address = app.server.address();
    const host = typeof address === 'object' && address ? address.address : config.host;
    const port = typeof address === 'object' && address ? address.port : config.port;
    app.logger.info('server_started', {
      host,
      port,
      admin_configured: config.adminToken !== null,
      capture_enabled: config.captureEnabled,
      upstream: config.upstreamUrl.origin,
    });
    const shutdown = (signal: string): void => {
      app.logger.info('server_stopping', { signal });
      void app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.logger.error('server_shutdown_failed', { error: (error as Error).message });
          process.exit(1);
        },
      );
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
