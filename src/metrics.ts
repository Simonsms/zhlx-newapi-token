export interface Metrics {
  readonly startedAt: string;
  droppedMetadata: number;
  droppedContent: number;
  writeErrors: number;
  lastWriteError: string | null;
  authFailures: number;
  syncRuns: number;
  syncFailures: number;
}

export function createMetrics(): Metrics {
  return {
    startedAt: new Date().toISOString(),
    droppedMetadata: 0,
    droppedContent: 0,
    writeErrors: 0,
    lastWriteError: null,
    authFailures: 0,
    syncRuns: 0,
    syncFailures: 0,
  };
}
