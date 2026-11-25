// Canvas2D 回退渲染器:与 GpuRenderer 同接口,无 WebGPU 时使用。正交投影+画家算法。
import type { BuildResult } from '../types';
import type { RenderState } from './GpuRenderer';
import type { IRenderer, CellSize, PropLink } from './IRenderer';

function tempColor(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [330, [51, 115, 242]], [390, [64, 204, 102]], [450, [250, 204, 51]],
    [540, [242, 51, 31]], [700, [255, 242, 217]], [9999, [255, 255, 255]],
  ];
  for (const [lim, c] of stops) if (t < lim) return `rgb(${c[0]},${c[1]},${c[2]})`;
  return 'rgb(255,255,255)';
}

export class Canvas2dRenderer implements IRenderer {
  camera = { yaw: 0.6, pitch: 0.35, dist: 14, target: [6, 1.2, 1.2] as [number, number, number] };
  constructor(private ctx: CanvasRenderingContext2D, private layout: BuildResult, private cellSize: CellSize) {}

  private project(p: [number, number, number]): [number, number, number] {
    const { yaw, pitch, dist, target } = this.camera;
    const dx = p[0] - target[0], dy = p[1] - target[1], dz = p[2] - target[2];
    const x1 = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const z1 = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const y1 = dy * Math.cos(pitch) - z1 * Math.sin(pitch);
    const z2 = dy * Math.sin(pitch) + z1 * Math.cos(pitch);
    const scale = 400 / dist;
    const cw = this.ctx.canvas.clientWidth, ch = this.ctx.canvas.clientHeight;
    return [cw / 2 + x1 * scale, ch / 2 - y1 * scale, z2];
  }

  render(_canvas: HTMLCanvasElement, st?: RenderState) {
    if (!st) return;
    const state = st;
    const ctx = this.ctx;
    const cw = ctx.canvas.clientWidth, ch = ctx.canvas.clientHeight;
    ctx.canvas.width = cw * devicePixelRatio; ctx.canvas.height = ch * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.fillStyle = '#12171f'; ctx.fillRect(0, 0, cw, ch);
    const L = this.layout;

    // 舱体线框
    const r = L.roomSize;
    ctx.strokeStyle = 'rgba(160,190,220,0.5)'; ctx.lineWidth = 1;
    const corners: [number, number, number][] = [
      [0, 0, 0], [r.x, 0, 0], [r.x, r.y, 0], [0, r.y, 0],
      [0, 0, r.z], [r.x, 0, r.z], [r.x, r.y, r.z], [0, r.y, r.z],
    ];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of edges) {
      const pa = this.project(corners[a]), pb = this.project(corners[b]);
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
    }

    // 电芯按深度排序
    const items: { d: number; i: number }[] = [];
    for (let i = 0; i < L.cellCount; i++) {
      const cluster = L.moduleCluster[L.cellModule[i]];
      if (st.cutCluster >= 0 && cluster > st.cutCluster) continue;
      const p = this.project([L.cellPositions[i * 3], L.cellPositions[i * 3 + 1], L.cellPositions[i * 3 + 2]]);
      items.push({ d: p[2], i });
    }
    items.sort((a, b) => b.d - a.d);
    const w = this.cellSize.w * 0.9 * (400 / this.camera.dist), h = this.cellSize.h * 0.9 * (400 / this.camera.dist);
    for (const { i } of items) {
      const p = this.project([L.cellPositions[i * 3], L.cellPositions[i * 3 + 1], L.cellPositions[i * 3 + 2]]);
      ctx.fillStyle = st.states[i] >= 2 ? '#ff731f' : tempColor(st.temps[i] ?? 298);
      ctx.fillRect(p[0] - w / 2, p[1] - h / 2, Math.max(1.5, w), Math.max(2, h));
    }

    // 喷发方向
    ctx.strokeStyle = '#ff9a3c'; ctx.lineWidth = 2;
    for (let i = 0; i < L.cellCount; i++) {
      if (st.states[i] !== 2) continue;
      const a = this.project([L.cellPositions[i * 3], L.cellPositions[i * 3 + 1] + this.cellSize.h / 2, L.cellPositions[i * 3 + 2]]);
      const b = this.project([L.cellPositions[i * 3], L.cellPositions[i * 3 + 1] + this.cellSize.h / 2 + 0.35, L.cellPositions[i * 3 + 2]]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  }

  updateInstances(_layout: BuildResult, _cellSize: CellSize, _st: RenderState) {}
  setPropagationLines(_links: PropLink[], _layout: BuildResult) {}
  dispose() {}
}
