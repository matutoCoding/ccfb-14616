import { store } from '../state/store';
import { buildLayout } from '../physics/geometry';
import { runSimulation, isWebGpuAvailable } from '../gpu/GpuSimEngine';
import { dequantizeT } from '../physics/thermalModel';
import { saveResult } from '../db/storage';
import { toast } from '../shell';
import { GpuRenderer, type RenderState } from '../render/GpuRenderer';
import { Canvas2dRenderer } from '../render/Canvas2dRenderer';
import type { IRenderer } from '../render/IRenderer';
import type { SimResult } from '../types';

export function renderSimPage(root: HTMLElement) {
  const c = store.state.config;
  const layout = buildLayout(c);
  root.innerHTML = `
    <div class="sim-layout">
      <div class="sim-toolbar">
        <button id="btn-run" class="btn primary">▶ 运行仿真(${isWebGpuAvailable() ? 'WebGPU' : 'CPU 回退'})</button>
        <label>仿真时长 h <input id="sim-hours" type="number" step="0.5" min="0.1" value="${(c.simDuration / 3600).toFixed(1)}" style="width:80px"></label>
        <label>舱体透明 <input id="hull-alpha" type="range" min="0" max="100" value="30"></label>
        <label>按簇剖切 <select id="cut-cluster"><option value="-1">不剖</option>${Array.from({ length: c.clusterCount }, (_, i) => `<option value="${i}">保留 0..${i}</option>`).join('')}</select></label>
        <span id="run-status" class="status"></span>
      </div>
      <div class="canvas-wrap">
        <canvas id="sim-canvas"></canvas>
        <div class="hud" id="hud">温度色标: 蓝(常温) → 绿 → 黄 → 红(失控) → 白(火焰)</div>
      </div>
      <div class="timeline-bar">
        <button id="btn-play" class="btn">⏸</button>
        <input id="timeline" type="range" min="0" max="1000" value="0" disabled>
        <span id="time-label">t = 0 s</span>
        <span id="tr-label"></span>
      </div>
      <div class="sim-side">
        <h3>失控序列</h3>
        <div id="tr-seq" class="tr-seq"><div class="hint">运行后显示</div></div>
        <h3>蔓延路径</h3>
        <label class="check"><input type="checkbox" id="show-links" checked> 连线显示(模组内/跨模组)</label>
        <div id="path-stat" class="hint"></div>
      </div>
    </div>`;

  const canvas = root.querySelector('#sim-canvas') as HTMLCanvasElement;
  const cellSize = { w: c.cell.width, h: c.cell.height, d: c.cell.depth };
  let renderer: IRenderer | null = null;
  let result: SimResult | null = store.state.result;
  let raf = 0;
  let playing = true;
  let cursorT = 0;

  const initRenderer = async (): Promise<IRenderer> => {
    if (renderer) return renderer;
    try {
      renderer = await GpuRenderer.create(canvas, layout);
    } catch (e) {
      console.warn('WebGPU 渲染器初始化失败,用 Canvas2D', e);
      const ctx = canvas.getContext('2d')!;
      renderer = new Canvas2dRenderer(ctx, layout, cellSize);
    }
    bindCamera(canvas, renderer);
    return renderer;
  };

  const currentState = (): RenderState => {
    const temps = new Float32Array(layout.cellCount).fill(c.hvac.ambientT);
    const states = new Uint8Array(layout.cellCount);
    if (result?.snapshots.length) {
      const snaps = result.snapshots;
      let idx = 0;
      while (idx < snaps.length - 1 && snaps[idx + 1].t <= cursorT) idx++;
      const snap = snaps[idx];
      for (let i = 0; i < layout.cellCount; i++) {
        temps[i] = dequantizeT(snap.temp[i]);
        states[i] = snap.state[i];
      }
    }
    return {
      temps, states, ventDir: new Float32Array(),
      cutCluster: +(root.querySelector('#cut-cluster') as HTMLSelectElement).value,
      hullAlpha: +(root.querySelector('#hull-alpha') as HTMLInputElement).value / 100,
    };
  };

  const loop = () => {
    if (!renderer) return;
    if (playing && result) {
      cursorT += result.snapshotInterval * 4;
      if (cursorT >= c.simDuration) { cursorT = c.simDuration; playing = false; (root.querySelector('#btn-play') as HTMLButtonElement).textContent = '▶'; }
      (root.querySelector('#timeline') as HTMLInputElement).value = String((cursorT / c.simDuration) * 1000);
    }
    (root.querySelector('#time-label') as HTMLElement).textContent = `t = ${cursorT.toFixed(0)} s`;
    const st = currentState();
    renderer.updateInstances(layout, cellSize, st);
    renderer.render(canvas, st);
    raf = requestAnimationFrame(loop);
  };

  initRenderer().then(() => loop());

  root.querySelector('#sim-hours')!.addEventListener('change', (e) => {
    store.update((cfg) => { cfg.simDuration = Math.max(60, +(e.target as HTMLInputElement).value * 3600); });
  });

  root.querySelector('#btn-run')!.addEventListener('click', async () => {
    const btn = root.querySelector('#btn-run') as HTMLButtonElement;
    const status = root.querySelector('#run-status') as HTMLElement;
    btn.disabled = true; status.textContent = '求解中…';
    const t0 = performance.now();
    try {
      result = await runSimulation(store.state.config, (pct) => { status.textContent = `求解中 ${(pct * 100).toFixed(0)}%`; });
      store.setResult(result);
      await saveResult(store.state.config.id, result);
      cursorT = 0; playing = true;
      (root.querySelector('#timeline') as HTMLInputElement).disabled = false;
      (root.querySelector('#btn-play') as HTMLButtonElement).textContent = '⏸';
      status.textContent = `完成: ${(result.summary.wallTimeMs / 1000).toFixed(1)}s 墙钟 / ${result.summary.steps} 步`;
      toast(`仿真完成,失控 ${result.summary.trCount} 颗,耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      renderSeq();
      const r = await initRenderer();
      r.setPropagationLines(result.propagationLinks, layout);
      bindCamera(canvas, r);
    } catch (e) {
      status.textContent = '失败';
      toast((e as Error).message);
    } finally { btn.disabled = false; }
  });

  root.querySelector('#timeline')!.addEventListener('input', (e) => {
    playing = false;
    (root.querySelector('#btn-play') as HTMLButtonElement).textContent = '▶';
    cursorT = (+(e.target as HTMLInputElement).value / 1000) * c.simDuration;
  });
  root.querySelector('#btn-play')!.addEventListener('click', (e) => {
    playing = !playing;
    (e.target as HTMLButtonElement).textContent = playing ? '⏸' : '▶';
  });
  root.querySelector('#cut-cluster')!.addEventListener('change', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  });

  const renderSeq = () => {
    if (!result) return;
    const seq = root.querySelector('#tr-seq')!;
    seq.innerHTML = result.summary.trOrder.slice(0, 50).map((e, k) =>
      `<div class="tr-item"><b>#${k + 1}</b> 电芯 ${e.cell} <span class="muted">(模组 ${e.module})</span> <span class="t">${e.t.toFixed(1)}s</span></div>`).join('')
      + (result.summary.trOrder.length > 50 ? `<div class="hint">…共 ${result.summary.trOrder.length} 颗</div>` : '');
    const cross = result.propagationLinks.filter((l) => layout.cellModule[l.from] !== layout.cellModule[l.to]).length;
    const inner = result.propagationLinks.length - cross;
    root.querySelector('#path-stat')!.textContent =
      `蔓延连线 ${result.propagationLinks.length} 条:模组内 ${inner} 条,跨模组 ${cross} 条。首蔓延延时 ${result.summary.firstPropagationTime?.toFixed(1) ?? '—'} s`;
    root.querySelector('#tr-label')!.textContent = `失控 ${result.summary.trCount}/${layout.cellCount}`;
  };
  if (result) {
    (root.querySelector('#timeline') as HTMLInputElement).disabled = false;
    renderSeq();
  }

  return () => { cancelAnimationFrame(raf); renderer?.dispose(); };
}

function bindCamera(canvas: HTMLCanvasElement, r: { camera: { yaw: number; pitch: number; dist: number; target: [number, number, number] } }) {
  let drag = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; });
  addEventListener('pointerup', () => { drag = false; });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    r.camera.yaw += (e.clientX - lx) * 0.006;
    r.camera.pitch = Math.max(-1.2, Math.min(1.2, r.camera.pitch + (e.clientY - ly) * 0.006));
    lx = e.clientX; ly = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    r.camera.dist = Math.max(2, Math.min(40, r.camera.dist * (1 + Math.sign(e.deltaY) * 0.08)));
  }, { passive: false });
}
