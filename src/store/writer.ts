import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { Store } from './store.ts';
import type { ProxyRequestInsert } from './types.ts';

export class BoundedQueue<T> {
  readonly max: number;
  private readonly items: T[] = [];
  private dropped = 0;

  constructor(max: number) {
    this.max = max;
  }

  push(item: T): boolean {
    if (this.items.length >= this.max) {
      this.dropped += 1;
      return false;
    }
    this.items.push(item);
    return true;
  }

  drain(max: number): T[] {
    return this.items.splice(0, max);
  }

  get size(): number {
    return this.items.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }
}

export class ProxyWriter {
  private readonly store: Store;
  private readonly config: Config;
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly metadataQueue: BoundedQueue<ProxyRequestInsert>;
  private readonly contentQueue: BoundedQueue<ProxyRequestInsert>;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(store: Store, config: Config, metrics: Metrics, logger: Logger) {
    this.store = store;
    this.config = config;
    this.metrics = metrics;
    this.logger = logger;
    this.metadataQueue = new BoundedQueue(config.queueMaxMetadata);
    this.contentQueue = new BoundedQueue(config.queueMaxContent);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.queueFlushMs);
    this.timer.unref();
  }

  enqueue(row: ProxyRequestInsert, hasPrompt: boolean): void {
    if (hasPrompt) {
      if (this.contentQueue.push(row)) return;
      this.metrics.droppedContent += 1;
      this.logger.warn('prompt_content_queue_full', { proxy_request_id: row.proxy_request_id });
      row.capture_status = 'dropped';
      row.skip_reason = 'queue_full';
      row.prompt_text = null;
      row.prompt_chars = null;
      row.prompt_truncated = 0;
    }
    if (!this.metadataQueue.push(row)) {
      this.metrics.droppedMetadata += 1;
      this.logger.warn('metadata_queue_full', { proxy_request_id: row.proxy_request_id });
    }
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const metadata = this.metadataQueue.drain(this.config.queueBatchSize * 4);
    const content = this.contentQueue.drain(this.config.queueBatchSize * 4);
    if (metadata.length === 0 && content.length === 0) return;
    const batches: Array<{ label: string; rows: ProxyRequestInsert[] }> = [
      { label: 'metadata', rows: metadata },
      { label: 'content', rows: content },
    ];
    for (const batch of batches) {
      if (batch.rows.length === 0) continue;
      try {
        await this.store.insertProxyRequests(batch.rows);
      } catch (error) {
        this.metrics.writeErrors += 1;
        this.metrics.lastWriteError = (error as Error).message;
        this.logger.error('proxy_event_write_failed', {
          batch: batch.label,
          rows: batch.rows.length,
          error: (error as Error).message,
        });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.flush();
      if (this.metadataQueue.size === 0 && this.contentQueue.size === 0) return;
    }
  }

  get queueSizes(): { metadata: number; content: number; metadataDropped: number; contentDropped: number } {
    return {
      metadata: this.metadataQueue.size,
      content: this.contentQueue.size,
      metadataDropped: this.metadataQueue.droppedCount,
      contentDropped: this.contentQueue.droppedCount,
    };
  }
}
