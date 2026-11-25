import { describe, expect, it } from 'vitest';
import { createDefaultScheme } from '../data/defaults';
import { buildThermalGraph } from './graph';
import { solveThermalGraph } from './solver';
import { repairScheme, validateScheme } from './validation';

describe('seed cabin data', () => {
  it('detects the deliberately wrong-order conductivity cells', () => {
    const issues = validateScheme(createDefaultScheme());
    const badCells = issues.filter((i) => i.scope === 'cell' && i.severity === 'error');
    expect(badCells.length).toBeGreaterThanOrEqual(3);
    expect(badCells.some((i) => i.targetId === 'cell-7')).toBe(true);
    expect(badCells.some((i) => String(i.value) === '28000')).toBe(true);
  });

  it('can repair bad values and run a finite propagation simulation', async () => {
    const bad = createDefaultScheme();
    const repaired = repairScheme(bad);
    expect(validateScheme(repaired).some((i) => i.severity === 'error')).toBe(false);
    const graph = buildThermalGraph(repaired);
    const result = await solveThermalGraph(graph, repaired, {
      durationS: 3600,
      recordIntervalS: 60,
      suppressionStartS: null,
      onProgress: () => {},
    });
    console.log('seed events', result.events.slice(0, 12).map((e) => [e.order, e.cellId, Math.round(e.timeS), e.via]));
    expect(result.temperaturesDeciC.every(Number.isFinite)).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);
    // Nail trigger should eventually propagate to at least one neighbour.
    expect(result.events.length).toBeGreaterThanOrEqual(2);
  }, 120000);
});
