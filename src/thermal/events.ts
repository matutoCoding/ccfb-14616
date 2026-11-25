import type { PropagationEvent } from '../types';
import type { ThermalGraph } from './graph';

export function buildEventsFromRunaway(
  graph: ThermalGraph,
  runawayTime: ArrayLike<number>,
  temp?: ArrayLike<number>,
): PropagationEvent[] {
  const raw: Array<{ node: number; timeS: number }> = [];
  for (let node = 0; node < graph.nodes.count; node++) {
    const ci = graph.nodes.cellIndex[node];
    if (ci >= 0 && runawayTime[node] >= 0) raw.push({ node, timeS: runawayTime[node] });
  }
  raw.sort((a, b) => a.timeS - b.timeS || a.node - b.node);

  const events: PropagationEvent[] = [];
  const { offsets, neighbors, conductance } = graph.csr;
  raw.forEach((item, idx) => {
    const { node, timeS } = item;
    const ci = graph.nodes.cellIndex[node];
    const cell = ci >= 0 ? graph.cells[ci] : undefined;
    if (!cell) return;

    let fromNode = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let e = offsets[node]; e < offsets[node + 1]; e++) {
      const j = neighbors[e];
      if (runawayTime[j] >= 0 && runawayTime[j] < timeS - 1e-6) {
        const score = temp ? conductance[e] * (temp[j] - temp[node]) : conductance[e];
        if (score > bestScore) {
          bestScore = score;
          fromNode = j;
        }
      }
    }

    let via: PropagationEvent['via'] = idx === 0 ? 'trigger' : 'intra-module';
    let fromCellId: string | undefined;
    if (fromNode >= 0) {
      const fromCi = graph.nodes.cellIndex[fromNode];
      const fromCell = fromCi >= 0 ? graph.cells[fromCi] : undefined;
      if (fromCell) {
        fromCellId = fromCell.id;
        if (fromCell.moduleId !== cell.moduleId) {
          via = fromCell.clusterId === cell.clusterId ? 'cross-module' : 'cross-cluster';
        } else {
          via = 'intra-module';
        }
      } else {
        via = 'cross-module';
      }
    }

    events.push({
      order: idx + 1,
      cellId: cell.id,
      cellIndex: cell.index,
      clusterId: cell.clusterId,
      moduleId: cell.moduleId,
      clusterIndex: cell.clusterIndex,
      moduleIndex: cell.moduleIndex,
      timeS: Math.round(timeS * 1000) / 1000,
      position: { ...cell.position },
      fromCellId,
      via,
    });
  });
  return events;
}
