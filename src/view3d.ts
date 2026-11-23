// 共享 3D 视口：挂载 Renderer、轨道相机交互、点选、HUD、温度图例
import { store } from './store/appStore';
import { Renderer } from './render/renderer';
import { k2c } from './model/defaults';

let renderer: Renderer | null = null;
let tipEl: HTMLDivElement | null = null;

export async function mount3d(container: HTMLElement) {
  unmount3d();
  if (!navigator.gpu) {
    container.innerHTML = `<div style="padding:40px;color:#f0a832;text-align:center">
      当前浏览器/显卡不支持 WebGPU。<br>请使用 Chrome/Edge 116+ 并开启硬件加速；仿真仍可用 CPU 求解器运行。</div>`;
    return;
  }
  container.innerHTML = `
    <canvas></canvas>
    <div class="view-hud">
      <span class="chip" id="hud-time">t = 0 s</span>
      <span class="chip" id="hud-run">未运行</span>
      <span class="chip"><label style="display:flex;align-items:center;gap:5px;cursor:pointer">
        <input type="checkbox" id="hud-cut"> 按簇剖切</label></span>
      <span class="chip"><label style="display:flex;align-items:center;gap:5px;cursor:pointer">
        舱体透明 <input type="range" id="hud-opacity" min="0" max="0.6" step="0.02" style="width:90px"></label></span>
    </div>
    <div class="legend">电芯温度 ℃
      <div class="bar"></div>
      <div class="scale"><span>25</span><span>150</span><span>300+</span></div>
      <div class="small muted" style="margin-top:6px">紫线=跨模组蔓延<br>橙线=模组内蔓延<br>虚线锥=泄压喷发</div>
    </div>
    <div class="cell-tip" id="cell-tip"></div>`;

  const canvas = container.querySelector('canvas')!;
  try {
    renderer = await Renderer.create(canvas, store.project, store.topo);
  } catch (e) {
    container.innerHTML = `<div style="padding:40px;color:#f25c5c">渲染器初始化失败：${(e as Error).message}</div>`;
    return;
  }
  tipEl = container.querySelector('#cell-tip');

  // 相机轨道交互
  let dragging = false; let lastX = 0; let lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !renderer) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    renderer.camera.yaw -= dx * 0.008;
    renderer.camera.pitch = Math.max(-1.3, Math.min(1.3, renderer.camera.pitch + dy * 0.008));
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('wheel', (e) => {
    if (!renderer) return;
    e.preventDefault();
    renderer.camera.dist = Math.max(1.5, Math.min(40, renderer.camera.dist * (1 + Math.sign(e.deltaY) * 0.08)));
  }, { passive: false });
  // 点选电芯（单击无拖动）
  let downPos = [0, 0];
  canvas.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
  canvas.addEventListener('click', (e) => {
    if (!renderer) return;
    if (Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 5) return;
    const rect = canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const idx = renderer.pick(nx, ny);
    store.setSelectedCell(idx);
    showTip(e, idx);
  });

  const cut = container.querySelector('#hud-cut') as HTMLInputElement;
  cut.checked = store.view.cutaway;
  cut.addEventListener('change', () => store.setView({ cutaway: cut.checked }));
  const op = container.querySelector('#hud-opacity') as HTMLInputElement;
  op.value = String(store.view.cabinOpacity);
  op.addEventListener('input', () => store.setView({ cabinOpacity: Number(op.value) }));

  renderer.start(
    () => store.view,
    () => store.activeRun,
    () => store.selectedCell,
  );

  // 每帧把回放数据送给渲染器
  const tick = () => {
    if (!renderer) return;
    const run = store.activeRun;
    const f = store.replayFrame;
    const hudT = container.querySelector('#hud-time');
    const hudR = container.querySelector('#hud-run');
    if (run && run.tempFrames.length) {
      const frame = Math.min(f, run.tempFrames.length - 1);
      renderer.setFrame(run.tempFrames[frame], run.stateFrames[frame], run.snapshotTimes[frame]);
      if (hudT) hudT.textContent = `t = ${run.snapshotTimes[frame].toFixed(1)} s`;
      if (hudR) hudR.textContent = `${run.scenarioTag} · 失控 ${run.finalRunawayCount} 颗`;
    } else {
      const n = store.topo.cellCount;
      renderer.setFrame(new Array(n).fill(store.project.cabin.ambientTemp), new Array(n).fill(0), 0);
      if (hudR) hudR.textContent = '未运行（显示初始温度场）';
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function showTip(e: MouseEvent, idx: number) {
  if (!tipEl || idx < 0) { if (tipEl) tipEl.style.display = 'none'; return; }
  const t = store.topo;
  const run = store.activeRun;
  const frame = run ? Math.min(store.replayFrame, run.tempFrames.length - 1) : -1;
  const T = run ? run.tempFrames[frame][idx] : store.project.cabin.ambientTemp;
  const s = run ? run.stateFrames[frame][idx] : 0;
  const stateText = ['正常', '自产热', '失控喷发中', '喷发结束'][s];
  tipEl.innerHTML = `
    <b>电芯 #${idx}</b><br>
    簇 ${t.rackId[idx] + 1} / 模组 ${t.moduleId[idx] + 1} / 位 ${t.indexInModule[idx]}<br>
    温度：<b>${k2c(T).toFixed(1)} ℃</b><br>
    状态：${stateText}<br>
    热容 C=${t.cap[idx].toFixed(1)} J/K<br>
    Gx=${t.gx[idx].toFixed(3)} G冷=${t.gCold[idx].toFixed(3)} W/K`;
  tipEl.style.display = 'block';
  tipEl.style.left = `${e.clientX + 14}px`;
  tipEl.style.top = `${e.clientY + 14}px`;
}

export function unmount3d() {
  renderer?.destroy();
  renderer = null;
}

export function refreshRenderer() {
  if (renderer) renderer.updateConfig(store.project, store.topo);
}
