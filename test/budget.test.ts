import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCaptureBudget, releaseCaptureBudget, reserveCaptureBudget } from '../src/metrics.ts';

describe('采集预算', () => {
  it('预留与释放对称，超限时拒绝', () => {
    const budget = createCaptureBudget(100);
    assert.equal(reserveCaptureBudget(budget, 60), true);
    assert.equal(reserveCaptureBudget(budget, 60), false);
    assert.equal(budget.used, 60);
    releaseCaptureBudget(budget, 60);
    assert.equal(budget.used, 0);
    assert.equal(reserveCaptureBudget(budget, 100), true);
  });

  it('释放不会把已用量减成负数', () => {
    const budget = createCaptureBudget(10);
    reserveCaptureBudget(budget, 5);
    releaseCaptureBudget(budget, 50);
    assert.equal(budget.used, 0);
  });
});
