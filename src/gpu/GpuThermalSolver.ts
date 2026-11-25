import thermalShader from './thermal.wgsl?raw';
import type { Scheme } from '../types';
import type { ThermalGraph } from '../thermal/graph';
import { buildEventsFromRunaway } from '../thermal/events';
import type { SolveOptions, SolveResult } from '../thermal/solver';

function round4(n: number) {
  return Math.ceil(n / 4) * 4;
}

export class GpuThermalSolver {
  private constructor(
    public readonly adapter: GPUAdapter,
    public readonly device: GPUDevice,
  ) {}

  private static sharedPromise: Promise<GpuThermalSolver | null> | null = null;

  static async getShared(): Promise<GpuThermalSolver | null> {
    if (!this.sharedPromise) this.sharedPromise = this.create();
    return this.sharedPromise;
  }

  static async create(): Promise<GpuThermalSolver | null> {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      return new GpuThermalSolver(adapter, device);
    } catch (error) {
      console.warn('WebGPU 初始化失败，将使用 CPU 参考求解器', error);
      return null;
    }
  }

  async solve(graph: ThermalGraph, scheme: Scheme, options: SolveOptions): Promise<SolveResult> {
    const device = this.device;
    const n = graph.nodes.count;
    const cellCount = graph.cells.length;

    const sumG = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let e = graph.csr.offsets[i]; e < graph.csr.offsets[i + 1]; e++) {
        sumG[i] += graph.csr.conductance[e];
      }
    }
    let dtStable = 1;
    for (let i = 0; i < n; i++) {
      if (!graph.nodes.fixed[i] && graph.nodes.kind[i] !== 3 && sumG[i] > 0) dtStable = Math.min(dtStable, 0.38 * graph.nodes.capacity[i] / sumG[i]);
    }
    const maxStableDtS = Math.min(1, dtStable);

    const tempBytes = round4(n * 4);
    const tempA = device.createBuffer({ size: tempBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const tempB = device.createBuffer({ size: tempBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(tempA, 0, Float32Array.from(graph.nodes.temp));

    // NodeInfo stride = 24 bytes (six 4-byte fields).
    const nodeBytes = round4(n * 24);
    const nodeData = new ArrayBuffer(nodeBytes);
    const nodeF32 = new Float32Array(nodeData);
    const nodeU32 = new Uint32Array(nodeData);
    const nodeI32 = new Int32Array(nodeData);
    for (let i = 0; i < n; i++) {
      const base = i * 6;
      nodeF32[base] = graph.nodes.capacity[i];
      nodeU32[base + 1] = graph.nodes.kind[i];
      nodeI32[base + 2] = graph.nodes.cellIndex[i];
      nodeI32[base + 3] = graph.csr.offsets[i];
      nodeI32[base + 4] = graph.csr.offsets[i + 1];
      nodeU32[base + 5] = 0;
    }
    const nodeBuffer = device.createBuffer({ size: nodeBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(nodeBuffer, 0, nodeData);

    const edgeCount = graph.csr.neighbors.length;
    const edgeData = new ArrayBuffer(round4(Math.max(1, edgeCount) * 16));
    const edgeI32 = new Int32Array(edgeData);
    const edgeF32 = new Float32Array(edgeData);
    const edgeU32 = new Uint32Array(edgeData);
    for (let e = 0; e < edgeCount; e++) {
      edgeI32[e * 4] = graph.csr.neighbors[e];
      edgeF32[e * 4 + 1] = graph.csr.conductance[e];
      edgeU32[e * 4 + 2] = graph.csr.edgeKinds[e];
    }
    const edgeBuffer = device.createBuffer({ size: edgeData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(edgeBuffer, 0, edgeData);

    // RuntimeNode stride 16 bytes.
    const runtimeData = new ArrayBuffer(round4(n * 16));
    const runtimeF32 = new Float32Array(runtimeData);
    const runtimeU32 = new Uint32Array(runtimeData);
    for (let i = 0; i < n; i++) {
      runtimeF32[i * 4] = -1;
      runtimeU32[i * 4 + 1] = 0;
      runtimeF32[i * 4 + 2] = graph.nodes.peakTemp[i];
      runtimeF32[i * 4 + 3] = 0;
    }
    for (const target of scheme.trigger.targets.slice(0, 2)) {
      const cell = graph.cells.find((c) => c.id === target.cellId);
      if (cell && target.kind === 'manual') {
        runtimeF32[cell.index * 4] = 0;
        runtimeU32[cell.index * 4 + 1] = 2;
      }
    }
    const runtimeBuffer = device.createBuffer({ size: runtimeData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(runtimeBuffer, 0, runtimeData);

    const uniformData = new ArrayBuffer(128);
    const uf = new Float32Array(uniformData);
    const uu = new Uint32Array(uniformData);
    const ui = new Int32Array(uniformData);
    const spec = graph.cells[0]?.spec ?? scheme.cellSpecs[0];
    const heatSegments = spec.selfHeat.filter((s) => s.heatW > 0).slice(-4);
    while (heatSegments.length < 4) heatSegments.unshift({ id: `pad-${heatSegments.length}`, fromC: 1e9, heatW: 0 });
    const suppressionStart = options.suppressionStartS === undefined
      ? (scheme.suppression.active ? scheme.suppression.releaseDelayS : -1)
      : options.suppressionStartS;
    const suppressionRate = (options.coolingRateCPerMin ?? scheme.suppression.coolingRateCPerMin) / 60;
    const t0 = scheme.trigger.targets[0];
    const t1 = scheme.trigger.targets[1];
    const nodeForTarget = (id?: string) => graph.cells.find((c) => c.id === id)?.index ?? -1;
    const triggerDuration = (target: typeof t0) => target?.durationS ?? (target?.kind === 'nail' ? 1800 : target?.kind === 'overcharge' ? 3600 : 900);
    const triggerPower = (target: typeof t0) => target?.powerW ?? (target?.kind === 'nail' ? 12000 : target?.kind === 'overcharge' ? 6500 : 9000);

    uu[2] = n;
    uu[3] = cellCount;
    uf[4] = spec.onsetTempC;
    uf[5] = spec.selfHeatStartC;
    uf[6] = spec.runawayHeatJ;
    uf[7] = spec.retainedFraction;
    uf[8] = spec.eruptionDurationS;
    uf[9] = suppressionStart ?? -1;
    uf[10] = suppressionRate;
    ui[11] = nodeForTarget(t0?.cellId);
    ui[12] = nodeForTarget(t1?.cellId);
    uf[13] = t0 && t0.kind !== 'manual' ? triggerPower(t0) : 0;
    uf[14] = t1 && t1.kind !== 'manual' ? triggerPower(t1) : 0;
    uf[15] = t0 && t0.kind !== 'manual' ? triggerDuration(t0) : 0;
    uf[16] = t1 && t1.kind !== 'manual' ? triggerDuration(t1) : 0;
    heatSegments.forEach((seg, idx) => {
      uf[17 + idx * 2] = seg.fromC;
      uf[18 + idx * 2] = seg.heatW;
    });

    const uniformBuffer = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const shaderModule = device.createShaderModule({ code: thermalShader });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: shaderModule, entryPoint: 'integrate' },
    });

    const makeBindGroup = (input: GPUBuffer, output: GPUBuffer) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: nodeBuffer } },
        { binding: 3, resource: { buffer: edgeBuffer } },
        { binding: 4, resource: { buffer: runtimeBuffer } },
        { binding: 5, resource: { buffer: uniformBuffer } },
      ],
    });
    const groupAB = makeBindGroup(tempA, tempB);
    const groupBA = makeBindGroup(tempB, tempA);

    const recordInterval = options.recordIntervalS ?? Math.max(2, Math.ceil(options.durationS / 1200));
    const frameCapacity = Math.floor(options.durationS / recordInterval) + 1;
    const frameBuffer = device.createBuffer({
      size: round4(frameCapacity * cellCount * 4),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const copyFrame = (frameIndex: number, source: GPUBuffer) => {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, frameBuffer, frameIndex * cellCount * 4, cellCount * 4);
      device.queue.submit([encoder.finish()]);
    };
    copyFrame(0, tempA);

    const macroSteps = Math.ceil(options.durationS);
    let parity = 0;
    let substepCount = 0;
    let recordedFrames = 1;
    let stopped = false;

    for (let macro = 0; macro < macroSteps; macro++) {
      const tMacro = macro;
      const requestedDt = Math.min(1, options.durationS - tMacro);
      if (requestedDt <= 0) break;
      const cuts = Math.max(1, Math.ceil(requestedDt / maxStableDtS - 1e-12));
      const dt = requestedDt / cuts;
      for (let cut = 0; cut < cuts; cut++) {
        uf[0] = dt;
        uf[1] = tMacro + cut * dt;
        device.queue.writeBuffer(uniformBuffer, 0, uniformData);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, parity % 2 === 0 ? groupAB : groupBA);
        pass.dispatchWorkgroups(Math.ceil(n / 64));
        pass.end();
        device.queue.submit([encoder.finish()]);
        parity++;
        substepCount++;
      }

      if ((macro + 1) % recordInterval < 1e-9 && recordedFrames < frameCapacity) {
        const current = parity % 2 === 0 ? tempA : tempB;
        copyFrame(recordedFrames, current);
        recordedFrames++;
      }

      if (options.onProgress && macro % Math.max(1, options.yieldIntervalS ?? 20) === 0) {
        options.onProgress({ timeS: macro + 1, durationS: options.durationS, runawayCount: 0, substepCount });
      }
      if (options.shouldStop?.()) {
        stopped = true;
        break;
      }
      if (macro % 60 === 59) {
        await device.queue.onSubmittedWorkDone();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    await device.queue.onSubmittedWorkDone();

    const currentTemp = parity % 2 === 0 ? tempA : tempB;
    const [runawayBytes, runtimeOut, tempOut] = await Promise.all([
      this.readBuffer(runtimeBuffer, runtimeData.byteLength),
      Promise.resolve(null),
      this.readBuffer(currentTemp, tempBytes),
    ]);
    void runtimeOut;
    const finalRuntime = new Float32Array(runawayBytes);
    const finalTemp = new Float32Array(tempOut);
    const runawayTime = new Float32Array(n);
    for (let i = 0; i < n; i++) runawayTime[i] = finalRuntime[i * 4];

    graph.nodes.temp.set(finalTemp);
    for (let i = 0; i < n; i++) graph.nodes.peakTemp[i] = finalRuntime[i * 4 + 2];
    for (let i = 0; i < n; i++) graph.nodes.heatReceivedJ[i] = finalRuntime[i * 4 + 3];

    const events = buildEventsFromRunaway(graph, runawayTime, finalTemp);

    await frameBuffer.mapAsync(GPUMapMode.READ);
    const mapped = frameBuffer.getMappedRange();
    const frameTempsF32 = new Float32Array(mapped, 0, recordedFrames * cellCount);
    const temperaturesDeciC = new Uint16Array(recordedFrames * cellCount);
    for (let i = 0; i < frameTempsF32.length; i++) {
      temperaturesDeciC[i] = Math.max(0, Math.min(65535, Math.round(frameTempsF32[i] * 10)));
    }
    frameBuffer.unmap();
    frameBuffer.destroy();

    const states = new Uint8Array(recordedFrames * cellCount);
    const eventByCellIndex = new Map(events.map((e) => [e.cellIndex, e]));
    for (let f = 0; f < recordedFrames; f++) {
      const t = f * recordInterval;
      for (let i = 0; i < cellCount; i++) {
        const tempC = temperaturesDeciC[f * cellCount + i] / 10;
        const ev = eventByCellIndex.get(i);
        if (ev) {
          const duration = spec.eruptionDurationS;
          if (t >= ev.timeS && t <= ev.timeS + duration) states[f * cellCount + i] = 2;
          else if (t > ev.timeS + duration) states[f * cellCount + i] = 3;
        } else if (tempC >= spec.selfHeatStartC) {
          states[f * cellCount + i] = 1;
        }
      }
    }

    for (const buffer of [tempA, tempB, nodeBuffer, edgeBuffer, runtimeBuffer, uniformBuffer]) buffer.destroy();

    return {
      events,
      timesS: Array.from({ length: recordedFrames }, (_, i) => Number((i * recordInterval).toFixed(3))),
      temperaturesDeciC,
      states,
      frameIntervalS: recordInterval,
      frameCount: recordedFrames,
      substepCount,
      macroStepCount: macroSteps,
      maxStableDtS,
      stopped,
      suppressionStartS: suppressionStart ?? null,
    };
  }

  private async readBuffer(source: GPUBuffer, size: number): Promise<ArrayBuffer> {
    const device = this.device;
    const staging = device.createBuffer({ size: round4(size), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, staging, 0, round4(size));
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  }
}
