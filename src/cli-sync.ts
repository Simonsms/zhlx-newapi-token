import { configFromEnv } from './config.ts';
import { createLogger } from './logger.ts';
import { createMetrics } from './metrics.ts';
import { NewApiLogClient } from './newapi-client.ts';
import { openDatabase } from './store/open.ts';
import { Store } from './store/store.ts';
import { LogSync } from './sync.ts';

const config = configFromEnv();
if (!config.newapi.enabled || !config.newapi.baseUrl || !config.newapi.adminToken) {
  process.stderr.write('NEWAPI_LOG_SYNC_ENABLED=true 且配置 NEWAPI_BASE_URL / NEWAPI_ADMIN_TOKEN 后可使用\n');
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const metrics = createMetrics();
const db = await openDatabase(config.databaseUrl);
const store = new Store(db, config.deploymentId);
const client = new NewApiLogClient({
  baseUrl: config.newapi.baseUrl,
  adminToken: config.newapi.adminToken,
  adminUserId: config.newapi.adminUserId,
  timeoutMs: config.newapi.timeoutMs,
  pageSize: config.newapi.pageSize,
});
const sync = new LogSync(store, client, config, metrics, logger);

try {
  const report = await sync.syncOnce();
  logger.info('sync_once_done', { ...report });
  process.exitCode = report.error ? 1 : 0;
} catch (error) {
  logger.error('sync_once_failed', { error: (error as Error).message });
  process.exitCode = 1;
} finally {
  await db.close();
}
