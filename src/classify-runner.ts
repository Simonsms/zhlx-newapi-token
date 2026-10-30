import type { Classifier } from './classifier.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import type { Store } from './store/store.ts';

export interface ClassifyReport {
  picked: number;
  classified: number;
  failed: number;
  error: string | null;
}

/**
 * 离线批量分类：从库中取待分类记录，调用分类器后写回。
 * 独立于代理转发——失败只重试、只计数，绝不影响推理链路。
 */
export class ClassificationRunner {
  private readonly store: Store;
  private readonly classifier: Classifier | null;
  private readonly config: Config;
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    store: Store,
    classifier: Classifier | null,
    config: Config,
    metrics: Metrics,
    logger: Logger,
  ) {
    this.store = store;
    this.classifier = classifier;
    this.config = config;
    this.metrics = metrics;
    this.logger = logger;
  }

  start(): void {
    if (!this.classifier || this.timer) return;
    const run = (): void => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error('classification_unhandled', { error: (error as Error).message });
      });
    };
    run();
    this.timer = setInterval(run, this.config.classifier.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(now: Date = new Date()): Promise<ClassifyReport> {
    const report: ClassifyReport = { picked: 0, classified: 0, failed: 0, error: null };
    if (!this.classifier) return report;
    if (this.running) {
      throw new Error('分类任务正在运行');
    }
    this.running = true;
    try {
      const retryBefore = new Date(now.getTime() - this.config.classifier.retryMs).toISOString();
      const batch = await this.store.fetchClassifyBatch(
        this.config.classifier.batchSize,
        retryBefore,
        this.config.classifier.maxAttempts,
      );
      report.picked = batch.length;
      for (const item of batch) {
        const classifiedAt = new Date().toISOString();
        try {
          const result = await this.classifier.classify(item.prompt_text);
          await this.store.updateClassification(item.proxy_request_id, {
            status: 'classified',
            label: result.label,
            version: result.version,
            confidence: result.confidence,
            review: result.review,
            attempts: 0,
            classifiedAt,
          });
          report.classified += 1;
        } catch (error) {
          // 重置次数从库中当前值取更可靠；此处用小事务读改写。
          const rows = await this.store.raw<{ classification_attempts: number }>(
            'SELECT classification_attempts FROM proxy_request WHERE deployment_id = $1 AND proxy_request_id = $2',
            [this.store.deploymentId, item.proxy_request_id],
          );
          const attempts = Number(rows[0]?.classification_attempts ?? 0) + 1;
          await this.store.updateClassification(item.proxy_request_id, {
            status: 'failed',
            label: null,
            version: null,
            confidence: null,
            review: false,
            attempts,
            classifiedAt,
          });
          report.failed += 1;
          if (attempts >= this.config.classifier.maxAttempts) {
            this.logger.warn('classification_gave_up', {
              proxy_request_id: item.proxy_request_id,
              attempts,
              error: (error as Error).message,
            });
          }
        }
      }
      if (report.picked > 0) {
        this.logger.info('classification_batch_done', { ...report });
      }
      return report;
    } finally {
      this.running = false;
    }
  }
}
