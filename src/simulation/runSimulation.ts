import { GpuThermalSolver } from '../gpu/GpuThermalSolver';
import { estimateDetectorAlarms } from '../thermal/detectors';
import { buildThermalGraph } from '../thermal/graph';
import { solveThermalGraph, type SolveProgress } from '../thermal/solver';
import { validateScheme } from '../thermal/validation';
import type { RunSummary, Scheme } from '../types';

export interface ExecuteOptions {
  durationS: number;
  preferGpu?: boolean;
  recordIntervalS?: number;
  onProgress?: (p: SolveProgress & { backend?: string }) => void;
  shouldStop?: () => boolean;
}

export interface ExecuteResult {
  run: RunSummary;
  backend: 'webgpu' | 'cpu-reference';
  gpuAvailable: boolean;
}

export async function executeScheme(scheme: Scheme, options: ExecuteOptions): Promise<ExecuteResult> {
  const started = performance.now();
  const issues = validateScheme(scheme);
  const graph = buildThermalGraph(scheme);
  const gpu = options.preferGpu === false ? null : await GpuThermalSolver.getShared();
  let backend: 'webgpu' | 'cpu-reference' = gpu ? 'webgpu' : 'cpu-reference';

  let result;
  try {
    if (gpu) {
      result = await gpu.solve(graph, scheme, {
        durationS: options.durationS,
        recordIntervalS: options.recordIntervalS,
        onProgress: (p) => options.onProgress?.({ ...p, backend: 'webgpu' }),
        shouldStop: options.shouldStop,
      });
    } else {
      result = await solveThermalGraph(graph, scheme, {
        durationS: options.durationS,
        recordIntervalS: options.recordIntervalS,
        onProgress: (p) => options.onProgress?.({ ...p, backend: 'cpu-reference' }),
        shouldStop: options.shouldStop,
      });
    }
  } catch (error) {
    console.error('WebGPU 求解失败，回退 CPU 参考求解器', error);
    backend = 'cpu-reference';
    result = await solveThermalGraph(graph, scheme, {
      durationS: options.durationS,
      recordIntervalS: options.recordIntervalS,
      onProgress: (p) => options.onProgress?.({ ...p, backend: 'cpu-reference' }),
      shouldStop: options.shouldStop,
    });
  }

  const alarms = estimateDetectorAlarms(scheme, result.events);
  const cooling = scheme.cabin.cooling.map((circuit) => {
    const nodes = graph.coolantNodesByCircuit[circuit.id] ?? [];
    let peak = circuit.inletTempC;
    let heat = 0;
    for (const node of nodes) {
      peak = Math.max(peak, graph.nodes.peakTemp[node]);
      heat += graph.nodes.heatReceivedJ[node];
    }
    return {
      circuitId: circuit.id,
      name: circuit.name,
      failed: circuit.pumpFailed || !circuit.active,
      peakFluidTempC: Math.round(peak * 10) / 10,
      heatRemovedJ: Math.round(heat),
    };
  });

  const first = result.events[0] ?? null;
  const second = result.events[1] ?? null;
  const cellPeaks = graph.nodes.peakTemp.slice(0, graph.cells.length);
  const finalMaxTempC = Math.round(Math.max(...cellPeaks, 0) * 10) / 10;
  const computeElapsedMs = Math.round(performance.now() - started);

  const run: RunSummary = {
    id: `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`,
    schemeId: scheme.id,
    schemeName: scheme.name,
    createdAt: Date.now(),
    backend,
    status: result.stopped ? 'stopped' : 'completed',
    physicalDurationS: options.durationS,
    computeElapsedMs,
    cellCount: graph.cells.length,
    stepCount: result.macroStepCount,
    substepCount: result.substepCount,
    maxStableDtS: result.maxStableDtS,
    firstRunawayS: first?.timeS ?? null,
    firstPropagationS: second?.timeS ?? null,
    firstToSecondS: first && second ? Math.round((second.timeS - first.timeS) * 10) / 10 : null,
    runawayCount: result.events.length,
    events: result.events,
    alarms,
    cooling,
    issues,
    suppressionStartS: result.suppressionStartS,
    finalMaxTempC,
    frames: {
      intervalS: result.frameIntervalS,
      timesS: Float32Array.from(result.timesS),
      temperaturesDeciC: result.temperaturesDeciC,
      states: result.states,
      cellCount: graph.cells.length,
    },
  };

  return { run, backend, gpuAvailable: gpu !== null };
}
