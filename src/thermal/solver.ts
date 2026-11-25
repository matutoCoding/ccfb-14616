import type {
  PropagationEvent,
  Scheme,
} from '../types';
import type { ThermalGraph } from './graph';

export interface SolveProgress {
  timeS: number;
  durationS: number;
  runawayCount: number;
  substepCount: number;
}

export interface SolveOptions {
  durationS: number;
  recordIntervalS?: number;
  yieldIntervalS?: number;
  onProgress?: (p: SolveProgress) => void;
  shouldStop?: () => boolean;
  suppressionStartS?: number | null;
  coolingRateCPerMin?: number;
  suppressionCellIds?: string[];
}

export interface SolveResult {
  events: PropagationEvent[];
  timesS: number[];
  temperaturesDeciC: Uint16Array;
  states: Uint8Array;
  frameIntervalS: number;
  frameCount: number;
  substepCount: number;
  macroStepCount: number;
  maxStableDtS: number;
  stopped: boolean;
  suppressionStartS: number | null;
}

const STATE_NORMAL = 0;
const STATE_WARNING = 1;
const STATE_VENTING = 2;
const STATE_SPENT = 3;

function selfHeatPower(scheme: Scheme | undefined, cellNode: number, graph: ThermalGraph, tempC: number): number {
  if (!scheme) return 0;
  const ci = graph.nodes.cellIndex[cellNode];
  if (ci < 0) return 0;
  const cell = graph.cells[ci];
  const segments = cell?.spec.selfHeat ?? scheme.cellSpecs[0]?.selfHeat ?? [];
  let power = 0;
  for (const seg of segments) {
    if (tempC >= seg.fromC && seg.heatW > power) power = seg.heatW;
  }
  return power;
}

function triggerPower(scheme: Scheme | undefined, cellNode: number, graph: ThermalGraph, t: number): number {
  if (!scheme) return 0;
  const ci = graph.nodes.cellIndex[cellNode];
  if (ci < 0) return 0;
  const cell = graph.cells[ci];
  if (!cell) return 0;
  const target = scheme.trigger.targets.find((x) => x.cellId === cell.id);
  if (!target || target.kind === 'manual') return 0;
  const duration = target.durationS ?? (target.kind === 'nail' ? 1800 : target.kind === 'overcharge' ? 3600 : 900);
  if (t > duration) return 0;
  if (target.powerW !== undefined) return target.powerW;
  if (target.kind === 'nail') return 12000;
  if (target.kind === 'overcharge') return 6500;
  return 9000;
}

/**
 * Explicit thermal RC integration shared by the Vitest hand calculation and
 * the browser fallback. The WGSL kernel implements the same update equation.
 */
export async function solveThermalGraph(
  graph: ThermalGraph,
  scheme: Scheme | undefined,
  options: SolveOptions,
): Promise<SolveResult> {
  const n = graph.nodes.count;
  const cellCount = graph.cells.length || graph.nodes.cellIndex.filter((x) => x >= 0).length;
  const temp = graph.nodes.temp;
  const cap = graph.nodes.capacity;
  const fixed = graph.nodes.fixed;
  const peak = graph.nodes.peakTemp;
  const heatReceived = graph.nodes.heatReceivedJ;
  const { offsets, neighbors, conductance } = graph.csr;

  const sumG = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let gsum = 0;
    for (let e = offsets[i]; e < offsets[i + 1]; e++) gsum += conductance[e];
    sumG[i] = gsum;
  }

  const SAFETY = 0.38;
  let dtStableGlobal = 1;
  for (let i = 0; i < n; i++) {
    // Coolant nodes use local implicit mixing below, so their advective CFL
    // limit must not force the cell conduction step to microseconds.
    if (!fixed[i] && graph.nodes.kind[i] !== 3 && sumG[i] > 0 && cap[i] > 0) {
      dtStableGlobal = Math.min(dtStableGlobal, SAFETY * cap[i] / sumG[i]);
    }
  }
  // Chemistry release is intentionally integrated no more coarsely than 1 s.
  const maxAccuracyDt = 1;
  const maxStableDtS = Math.min(maxAccuracyDt, dtStableGlobal);

  const runawayTime = new Float64Array(n).fill(-1);
  const state = new Uint8Array(n);
  const events: PropagationEvent[] = [];
  let order = 0;

  const recordEvent = (node: number, timeS: number, viaTrigger = false) => {
    if (runawayTime[node] >= 0) return;
    runawayTime[node] = timeS;
    state[node] = STATE_VENTING;
    const ci = graph.nodes.cellIndex[node];
    if (ci < 0) return;
    const cell = graph.cells[ci];
    if (!cell) {
      order += 1;
      events.push({
        order,
        cellId: `benchmark-${ci + 1}`,
        cellIndex: ci,
        clusterId: 'benchmark',
        moduleId: 'benchmark',
        clusterIndex: 0,
        moduleIndex: 0,
        timeS,
        position: { x: ci * 0.2, y: 0.2, z: 0 },
        via: viaTrigger ? 'trigger' : 'intra-module',
      });
      return;
    }

    let fromNode: number | undefined;
    let bestHeat = 0;
    for (let e = offsets[node]; e < offsets[node + 1]; e++) {
      const j = neighbors[e];
      if (runawayTime[j] >= 0 && runawayTime[j] < timeS) {
        const heat = conductance[e] * (temp[j] - temp[node]);
        if (heat > bestHeat) {
          bestHeat = heat;
          fromNode = j;
        }
      }
    }

    let via: PropagationEvent['via'] = viaTrigger ? 'trigger' : 'intra-module';
    let fromCellId: string | undefined;
    if (fromNode !== undefined) {
      const fci = graph.nodes.cellIndex[fromNode];
      const fromCell = fci >= 0 ? graph.cells[fci] : undefined;
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

    order += 1;
    events.push({
      order,
      cellId: cell.id,
      cellIndex: cell.index,
      clusterId: cell.clusterId,
      moduleId: cell.moduleId,
      clusterIndex: cell.clusterIndex,
      moduleIndex: cell.moduleIndex,
      timeS,
      position: { ...cell.position },
      fromCellId,
      via,
    });
  };

  // Manual triggers are already on fire at t=0.
  if (scheme) {
    for (const target of scheme.trigger.targets) {
      const cell = graph.cells.find((c) => c.id === target.cellId);
      if (!cell) continue;
      if (target.kind === 'manual') {
        temp[cell.index] = Math.max(temp[cell.index], cell.spec.onsetTempC + 20);
        recordEvent(cell.index, 0, true);
      }
    }
  }
  // Benchmark graph has its first cell fixed at runaway temperature.
  if (!scheme && fixed[0] && graph.nodes.cellIndex[0] === 0) {
    recordEvent(0, 0, true);
  }

  const recordInterval = options.recordIntervalS ?? Math.max(2, Math.ceil(options.durationS / 1200));
  const frameCount = Math.floor(options.durationS / recordInterval) + 1;
  const temperatures = new Uint16Array(frameCount * cellCount);
  const frameStates = new Uint8Array(frameCount * cellCount);
  const times: number[] = new Array(frameCount);

  const recordFrame = (frame: number, t: number) => {
    times[frame] = t;
    const base = frame * cellCount;
    for (let i = 0; i < cellCount; i++) {
      const v = Math.max(0, Math.min(6553.5, temp[i]));
      temperatures[base + i] = Math.round(v * 10);
      frameStates[base + i] = state[i];
      if (temp[i] > peak[i]) peak[i] = temp[i];
    }
  };
  recordFrame(0, 0);

  const suppressionStart = options.suppressionStartS === undefined
    ? (scheme?.suppression.active ? scheme.suppression.releaseDelayS : null)
    : options.suppressionStartS;
  const suppressionRateKPerS = (options.coolingRateCPerMin ?? scheme?.suppression.coolingRateCPerMin ?? 0) / 60;
  const suppressionSet = options.suppressionCellIds ? new Set(options.suppressionCellIds) : null;

  let substepCount = 0;
  let stopped = false;
  let lastYield = performance.now();
  const next = new Float64Array(n);
  const macroDt = 1;
  const macroSteps = Math.ceil(options.durationS / macroDt);

  for (let macro = 0; macro < macroSteps; macro++) {
    const tMacro = macro * macroDt;
    const requestedDt = Math.min(macroDt, options.durationS - tMacro);
    if (requestedDt <= 0) break;
    const cuts = Math.max(1, Math.ceil(requestedDt / maxStableDtS - 1e-12));
    const dt = requestedDt / cuts;

    for (let cut = 0; cut < cuts; cut++) {
      const t = tMacro + cut * dt;

      for (let i = 0; i < n; i++) {
        if (fixed[i]) {
          next[i] = temp[i];
          peak[i] = Math.max(peak[i], temp[i]);
          continue;
        }

        let q = 0;
        for (let e = offsets[i]; e < offsets[i + 1]; e++) {
          const j = neighbors[e];
          q += conductance[e] * (temp[j] - temp[i]);
        }

        if (graph.nodes.kind[i] === 3) {
          // Backward-Euler mixing for serial coolant advection. Cell conduction
          // remains explicit and stability-controlled.
          const weightedNeighbour = q + sumG[i] * temp[i];
          next[i] = (cap[i] * temp[i] + dt * weightedNeighbour) / (cap[i] + dt * sumG[i]);
          if (!Number.isFinite(next[i])) {
            throw new Error(`冷却液节点 ${i} 出现非有限温度。`);
          }
          continue;
        }

        if (graph.nodes.kind[i] === 0) {
          q += selfHeatPower(scheme, i, graph, temp[i]);
          q += triggerPower(scheme, i, graph, t);

          const rt = runawayTime[i];
          if (rt >= 0) {
            const ci = graph.nodes.cellIndex[i];
            const cell = ci >= 0 ? graph.cells[ci] : undefined;
            const duration = cell?.spec.eruptionDurationS ?? 60;
            const elapsed = t - rt;
            if (elapsed <= duration) {
              const totalQ = cell?.spec.runawayHeatJ ?? 4_000_000;
              const retained = cell?.spec.retainedFraction ?? 0.45;
              q += totalQ * retained / duration;
              state[i] = STATE_VENTING;
            } else {
              state[i] = STATE_SPENT;
            }
          } else if (temp[i] >= (cellSpecAt(graph, i)?.onsetTempC ?? 150)) {
            recordEvent(i, t + dt);
          } else if (temp[i] >= (cellSpecAt(graph, i)?.selfHeatStartC ?? 60)) {
            state[i] = STATE_WARNING;
          }

          if (suppressionStart !== null && t >= suppressionStart && suppressionRateKPerS > 0 && temp[i] > 45) {
            const cell = graph.cells[graph.nodes.cellIndex[i]];
            if (!suppressionSet || (cell && suppressionSet.has(cell.id))) {
              // Agent imposes a target cooling ramp on heated cells. Normal
              // ambient cells are not driven below cabin temperature.
              q -= cap[i] * suppressionRateKPerS;
            }
          }
        }

        next[i] = temp[i] + q * dt / cap[i];
        if (!Number.isFinite(next[i])) {
          throw new Error(`热求解在节点 ${i} 出现非有限温度；请检查导热系数量级和稳定性步长。`);
        }
      }

      for (const edge of graph.edges) {
        if (edge.kind === 'plate-coolant') {
          heatReceived[edge.b] += edge.conductance * (temp[edge.a] - temp[edge.b]) * dt;
        }
      }

      temp.set(next);
      for (let i = 0; i < n; i++) peak[i] = Math.max(peak[i], temp[i]);
      substepCount++;
    }

    // Record at the nearest configured frame boundary.
    const frame = Math.round((macro + 1) / recordInterval);
    if (Math.abs((macro + 1) - frame * recordInterval) < 1e-9 && frame < frameCount) {
      recordFrame(frame, macro + 1);
    }

    if (options.onProgress && (macro % Math.max(1, options.yieldIntervalS ?? 10) === 0)) {
      options.onProgress({
        timeS: Math.min(options.durationS, macro + 1),
        durationS: options.durationS,
        runawayCount: events.length,
        substepCount,
      });
    }
    if (options.shouldStop?.()) {
      stopped = true;
      break;
    }
    if (macro % 10 === 9 && performance.now() - lastYield > 16) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }

  if (options.onProgress) {
    options.onProgress({ timeS: options.durationS, durationS: options.durationS, runawayCount: events.length, substepCount });
  }

  return {
    events,
    timesS: times,
    temperaturesDeciC: temperatures,
    states: frameStates,
    frameIntervalS: recordInterval,
    frameCount,
    substepCount,
    macroStepCount: macroSteps,
    maxStableDtS,
    stopped,
    suppressionStartS: suppressionStart,
  };
}

function cellSpecAt(graph: ThermalGraph, node: number) {
  const ci = graph.nodes.cellIndex[node];
  return ci >= 0 ? graph.cells[ci]?.spec : undefined;
}

export interface HandCalcCheck {
  expectedS: number;
  computedS: number;
  errorFraction: number;
  passed: boolean;
  formula: string;
}

/**
 * Independent closed-form target:
 * T2(t)=T0+(Ts-T0)*(1 + (r2/(r1-r2))exp(-r1 t) - (r1/(r1-r2))exp(-r2 t))
 * for C=5000 J/K, G12=G23=5 W/K, Ts=600 C, T0=25 C, alarm=150 C.
 * Bisection gives 280.7 s. The explicit solver must remain within 5%.
 */
export async function runHandCalcCheck(): Promise<HandCalcCheck> {
  const graph = buildHandCalcGraphLazy();
  const result = await solveThermalGraph(graph, undefined, { durationS: 420, recordIntervalS: 10, yieldIntervalS: 1000 });
  const second = result.events.find((e) => e.order === 2);
  const computedS = second?.timeS ?? Number.POSITIVE_INFINITY;
  const expectedS = 280.7;
  const errorFraction = Math.abs(computedS - expectedS) / expectedS;
  return {
    expectedS,
    computedS,
    errorFraction,
    passed: errorFraction <= 0.05,
    formula: 'C dT2/dt=G(T1-T2)+G(T3-T2), C dT3/dt=G(T2-T3); 解析根 t=280.7 s',
  };
}

import { buildHandCalcGraph } from './graph';
function buildHandCalcGraphLazy() {
  return buildHandCalcGraph();
}
