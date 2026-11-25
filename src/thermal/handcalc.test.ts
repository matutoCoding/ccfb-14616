import { describe, expect, it } from 'vitest';
import { buildHandCalcGraph } from './graph';
import { runHandCalcCheck, solveThermalGraph } from './solver';

describe('three-cell serial hand calculation', () => {
  it('matches the closed-form first-to-second runaway time within 5%', async () => {
    const check = await runHandCalcCheck();
    expect(check.computedS).toBeGreaterThan(0);
    expect(check.errorFraction).toBeLessThanOrEqual(0.05);
    expect(check.passed).toBe(true);
    // Explicitly lock the documented hand-calc root.
    expect(Math.abs(check.computedS - 280.7) / 280.7).toBeLessThan(0.05);
  });

  it('uses a stable substep when requested dt exceeds the RC stability limit', async () => {
    const graph = buildHandCalcGraph();
    const result = await solveThermalGraph(graph, undefined, { durationS: 10, recordIntervalS: 1 });
    expect(result.maxStableDtS).toBeGreaterThan(0);
    expect(result.substepCount).toBeGreaterThanOrEqual(10);
    expect(Number.isFinite(result.temperaturesDeciC[result.temperaturesDeciC.length - 1])).toBe(true);
  });
});
