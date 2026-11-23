// 仿真引擎：拓扑构建 → GPU(优先)/CPU 求解 → 探测器报警 → 喷放联动 → 组装 SimulationRun
import type { ProjectConfig, SimulationRun, SimProgress, RunawayEvent, DetectorAlarmEvent } from '../model/types';
import { buildTopology, type Topology } from '../model/topology';
import { hasWebGpu, GpuSolver } from '../gpu/gpuSolver';
import { ThermalCore, type CoreResult } from '../physics/thermalCore';
import { computeAlarms, computeDischargeTime } from '../physics/detector';
import { uid } from '../model/defaults';

export interface EngineOptions {
  endTime: number;
  maxDt?: number;
  snapshotInterval?: number;
  solverPref?: 'gpu' | 'cpu';
  scenarioTag?: string;
  runName?: string;
  onProgress?: (p: SimProgress) => void;
  signal?: { cancelled: boolean };
}

export interface EngineOutput {
  run: SimulationRun;
  solver: 'gpu' | 'cpu';
  topo: Topology;
  alarms: DetectorAlarmEvent[];
}

/** 两遍法：先无喷放试算求报警时刻，再带喷放正式跑（探测器模型在快照上工作，开销很小） */
export async function runSimulation(cfg: ProjectConfig, opts: EngineOptions): Promise<EngineOutput> {
  const topo = buildTopology(cfg);
  const initialTemp = cfg.cabin.ambientTemp;
  const maxDt = opts.maxDt ?? 2;
  const snapshotInterval = opts.snapshotInterval ?? 10;
  const gpuAvailable = opts.solverPref !== 'cpu' && await hasWebGpu();
  const solver: 'gpu' | 'cpu' = gpuAvailable ? 'gpu' : 'cpu';
  const wall0 = performance.now();

  const common = {
    endTime: opts.endTime, maxDt, snapshotInterval, initialTemp,
    onProgress: (t: number, dt: number, runaway: number) =>
      opts.onProgress?.({ physicalTime: t, targetTime: opts.endTime, wallMs: performance.now() - wall0, runawayCount: runaway, currentDt: dt }),
    signal: opts.signal,
  };

  let coreResult: CoreResult | null = null;
  let gpuResult: Awaited<ReturnType<GpuSolver['run']>> | null = null;

  if (solver === 'cpu') {
    // —— 第一遍：无喷放，求报警 ——
    const probe = new ThermalCore(topo, initialTemp);
    probe.setFlowPerRack(flowPerRack(cfg, topo));
    const r0 = await probe.run({
      ...common,
      ambientTemp: initialTemp, chem: cfg.chem, triggers: cfg.triggers,
      coolingEnabled: cfg.cooling.enabled, suppression: null,
      inletTemp: cfg.cooling.inletTemp, dischargeTime: -1,
      failedBranches: cfg.cooling.failedBranches, pumpFailTime: cfg.cooling.failTime,
      peakTemp: cfg.chem.runawayPeakTemp,
    });
    const alarms0 = computeAlarms(cfg, r0, (cell) => topo.rackId[cell]);
    const dischargeTime = computeDischargeTime(cfg, alarms0);

    // —— 第二遍：带喷放 ——
    const core = new ThermalCore(topo, initialTemp);
    core.setFlowPerRack(flowPerRack(cfg, topo));
    coreResult = await core.run({
      ...common,
      ambientTemp: initialTemp, chem: cfg.chem, triggers: cfg.triggers,
      coolingEnabled: cfg.cooling.enabled, suppression: cfg.suppression,
      inletTemp: cfg.cooling.inletTemp, dischargeTime,
      failedBranches: cfg.cooling.failedBranches, pumpFailTime: cfg.cooling.failTime,
      peakTemp: cfg.chem.runawayPeakTemp,
    });
  } else {
    // GPU 两遍
    const g0 = await GpuSolver.create(cfg, topo);
    const r0 = await g0.run({ ...common, dischargeTime: -1 });
    const asCore: CoreResult = {
      times: r0.times, tempFrames: r0.tempFrames, stateFrames: r0.stateFrames,
      events: r0.events, dischargeTime: -1, endTime: r0.endTime, steps: r0.steps,
      finalTemp: Float64Array.from(r0.tempFrames[r0.tempFrames.length - 1]),
      finalState: Uint8Array.from(r0.stateFrames[r0.stateFrames.length - 1]),
    };
    const alarms0 = computeAlarms(cfg, asCore, (cell) => topo.rackId[cell]);
    const dischargeTime = computeDischargeTime(cfg, alarms0);
    g0.destroy();

    const g1 = await GpuSolver.create(cfg, topo);
    gpuResult = await g1.run({ ...common, dischargeTime });
    g1.destroy();
  }

  const times = gpuResult?.times ?? coreResult!.times;
  const tempFrames = gpuResult?.tempFrames ?? coreResult!.tempFrames;
  const stateFrames = gpuResult?.stateFrames ?? coreResult!.stateFrames;
  const events = gpuResult?.events ?? coreResult!.events;
  const dischargeTime = gpuResult?.dischargeTime ?? coreResult?.dischargeTime ?? -1;

  // 最终一遍结果上重算报警（喷放会影响温感时刻）
  const finalCore: CoreResult = {
    times, tempFrames, stateFrames, events, dischargeTime,
    endTime: times[times.length - 1],
    steps: gpuResult?.steps ?? coreResult!.steps,
    finalTemp: Float64Array.from(tempFrames[tempFrames.length - 1]),
    finalState: Uint8Array.from(stateFrames[stateFrames.length - 1]),
  };
  const alarms = computeAlarms(cfg, finalCore, (cell) => topo.rackId[cell]);

  const firstProp = events.filter((e) => e.cause.startsWith('prop:'))
    .reduce((m, e) => Math.min(m, e.time), Infinity);
  const rackMax = new Float64Array(topo.rackCount);
  const last = tempFrames[tempFrames.length - 1];
  for (let i = 0; i < topo.cellCount; i++) rackMax[topo.rackId[i]] = Math.max(rackMax[topo.rackId[i]], last[i]);

  const run: SimulationRun = {
    id: uid('run'),
    projectId: cfg.id,
    name: opts.runName ?? `${opts.scenarioTag ?? '方案'} @ ${new Date().toLocaleTimeString()}`,
    createdAt: Date.now(),
    physicalTime: times[times.length - 1],
    wallMs: performance.now() - wall0,
    solver,
    snapshotInterval,
    cellCount: topo.cellCount,
    events: dedupeEvents(events),
    alarms,
    firstPropagationTime: Number.isFinite(firstProp) ? firstProp : -1,
    finalRunawayCount: events.length,
    scenarioTag: opts.scenarioTag ?? '默认方案',
    snapshotTimes: times,
    tempFrames,
    stateFrames,
    dischargeTime,
    pumpFailTime: cfg.cooling.enabled && cfg.cooling.failedBranches.length > 0 ? cfg.cooling.failTime : -1,
    rackMaxTemp: Array.from(rackMax),
  };

  return { run, solver, topo, alarms };
}

function flowPerRack(cfg: ProjectConfig, topo: Topology): number[] {
  const c = cfg.cooling;
  if (!c.enabled) return new Array(topo.rackCount).fill(0);
  const per = (c.flowLpm * c.fluidDensity / 60) / Math.max(topo.rackCount, 1) * c.fluidSpecificHeat;
  return Array.from({ length: topo.rackCount }, (_, r) =>
    c.failedBranches.includes(r) ? 0 : per);
}

function dedupeEvents(events: RunawayEvent[]): RunawayEvent[] {
  const seen = new Set<number>();
  const out: RunawayEvent[] = [];
  for (const e of [...events].sort((a, b) => a.time - b.time)) {
    if (seen.has(e.cellIndex)) continue;
    seen.add(e.cellIndex);
    out.push(e);
  }
  return out;
}
