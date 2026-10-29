import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import { mapRawLog, NewApiError, type NewApiLogClient } from './newapi-client.ts';
import type { Store } from './store/store.ts';
import type { SyncState } from './store/types.ts';

export interface SyncReport {
  windowStart: string;
  windowEnd: string;
  fetched: number;
  inserted: number;
  skipped: number;
  error: string | null;
}

export class LogSync {
  private readonly store: Store;
  private readonly client: NewApiLogClient | null;
  private readonly config: Config;
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    store: Store,
    client: NewApiLogClient | null,
    config: Config,
    metrics: Metrics,
    logger: Logger,
  ) {
    this.store = store;
    this.client = client;
    this.config = config;
    this.metrics = metrics;
    this.logger = logger;
  }

  start(): void {
    if (!this.config.newapi.enabled || !this.client || this.timer) return;
    const run = (): void => {
      void this.syncOnce().catch((error: unknown) => {
        this.logger.error('log_sync_unhandled', { error: (error as Error).message });
      });
    };
    run();
    this.timer = setInterval(run, this.config.newapi.syncIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncOnce(now: Date = new Date()): Promise<SyncReport> {
    if (!this.client) {
      throw new Error('日志同步未配置');
    }
    if (this.running) {
      throw new Error('日志同步正在运行');
    }
    this.running = true;
    this.metrics.syncRuns += 1;

    const safetyEnd = new Date(now.getTime() - this.config.newapi.safetyLagMs);
    const state = await this.store.getSyncState();
    let startIso: string;
    if (state?.watermark) {
      startIso = new Date(new Date(state.watermark).getTime() - this.config.newapi.overlapMs).toISOString();
    } else {
      startIso = new Date(safetyEnd.getTime() - this.config.newapi.initialBackfillHours * 3_600_000).toISOString();
    }
    const endIso = safetyEnd.toISOString();

    const report: SyncReport = {
      windowStart: startIso,
      windowEnd: endIso,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      error: null,
    };

    try {
      if (new Date(startIso).getTime() >= safetyEnd.getTime()) {
        await this.persistSuccess(state, startIso, endIso, 0);
        return report;
      }
      for (const logType of [2, 5, 6]) {
        const result = await this.syncType(logType, startIso, endIso);
        report.fetched += result.fetched;
        report.inserted += result.inserted;
        report.skipped += result.skipped;
      }
      const previousTotal = state?.events_total ?? (await this.store.countUsageEvents());
      const total = Math.max(previousTotal, await this.store.countUsageEvents());
      await this.persistSuccess(state, endIso, endIso, total);
      this.logger.info('log_sync_completed', {
        start: startIso,
        end: endIso,
        fetched: report.fetched,
        inserted: report.inserted,
      });
      return report;
    } catch (error) {
      this.metrics.syncFailures += 1;
      const message = error instanceof NewApiError
        ? `${error.message}（HTTP ${error.status}）`
        : (error as Error).message;
      report.error = message;
      await this.store.saveSyncState({
        deployment_id: this.config.deploymentId,
        watermark: state?.watermark ?? null,
        last_run_at: new Date().toISOString(),
        last_success_at: state?.last_success_at ?? null,
        last_error: message,
        events_total: state?.events_total ?? 0,
      });
      this.logger.error('log_sync_failed', { error: message });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async persistSuccess(
    state: SyncState | null,
    watermark: string,
    _endIso: string,
    eventsTotal: number,
  ): Promise<void> {
    await this.store.saveSyncState({
      deployment_id: this.config.deploymentId,
      watermark,
      last_run_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      last_error: null,
      events_total: eventsTotal,
    });
  }

  private async syncType(
    logType: number,
    startIso: string,
    endIso: string,
  ): Promise<{ fetched: number; inserted: number; skipped: number }> {
    if (!this.client) return { fetched: 0, inserted: 0, skipped: 0 };
    const pageSize = this.config.newapi.pageSize;
    const startSeconds = Math.floor(new Date(startIso).getTime() / 1000);
    const endSeconds = Math.ceil(new Date(endIso).getTime() / 1000);
    const maxPages = 10_000;
    let page = 1;
    let fetched = 0;
    let inserted = 0;
    let skipped = 0;
    let previousPageKey: string | null = null;

    for (; page <= maxPages; page += 1) {
      const items = await this.client.fetchPage(logType, startSeconds, endSeconds, page, pageSize);
      if (items.length === 0) break;
      fetched += items.length;

      const pageKey = JSON.stringify(items[0]);
      if (pageKey === previousPageKey) {
        throw new Error(`日志接口分页未前进（type=${logType}, page=${page}）`);
      }
      previousPageKey = pageKey;

      const mapped = items
        .map((item) => mapRawLog(item, this.config.deploymentId, this.config.newapi.sourceKeyMode))
        .filter((item) => item !== null);
      skipped += items.length - mapped.length;
      if (mapped.length > 0) {
        inserted += await this.store.insertUsageEvents(mapped);
      }

      if (items.length < pageSize) break;
    }
    if (page > maxPages) {
      throw new Error(`日志查询页数超过上限（type=${logType}）`);
    }
    return { fetched, inserted, skipped };
  }
}
