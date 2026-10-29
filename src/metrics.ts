export interface CaptureBudget {
  used: number;
  readonly limit: number;
}

export function createCaptureBudget(limit: number): CaptureBudget {
  return { used: 0, limit };
}

export function reserveCaptureBudget(budget: CaptureBudget, bytes: number): boolean {
  if (budget.used + bytes > budget.limit) return false;
  budget.used += bytes;
  return true;
}

export function releaseCaptureBudget(budget: CaptureBudget, bytes: number): void {
  budget.used = Math.max(0, budget.used - bytes);
}

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
