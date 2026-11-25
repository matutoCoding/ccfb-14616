// 渲染器统一接口:WebGPU 与 Canvas2D 回退实现共同遵守
import type { BuildResult } from '../types';
import type { RenderState } from './GpuRenderer';

export interface CellSize { w: number; h: number; d: number }
export interface PropLink { from: number; to: number; t: number }

export interface IRenderer {
  camera: { yaw: number; pitch: number; dist: number; target: [number, number, number] };
  updateInstances(layout: BuildResult, cellSize: CellSize, st: RenderState): void;
  setPropagationLines(links: PropLink[], layout: BuildResult): void;
  render(canvas: HTMLCanvasElement, st?: RenderState): void;
  dispose(): void;
}
