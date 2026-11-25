import { describe, expect, it } from 'vitest';
import { createStressScheme } from '../data/defaults';
import { buildThermalGraph } from './graph';
import { solveThermalGraph } from './solver';

describe('12k-cell performance budget', () => {
  it('integrates two physical hours quickly enough for the browser budget', async () => {
    const scheme = createStressScheme(12000);
    const graph = buildThermalGraph(scheme);
    expect(graph.cells.length).toBe(12000);
    const started = performance.now();
    const result = await solveThermalGraph(graph, scheme, {
      durationS: 7200,
      recordIntervalS: 30,
      suppressionStartS: null,
      onProgress: () => {},
    });
    const elapsed = performance.now() - started;
    console.log(JSON.stringify({
      cells: graph.cells.length,
      nodes: graph.nodes.count,
      edges: graph.edges.length,
      elapsedMs: Math.round(elapsed),
      substeps: result.substepCount,
      events: result.events.length,
      frames: result.frameCount,
    }));
    expect(result.temperaturesDeciC.length).toBeGreaterThan(0);
    // Headless CPU reference budget. WebGPU path is substantially faster.
    expect(elapsed).toBeLessThan(180_000);
  }, 240_000);
});
