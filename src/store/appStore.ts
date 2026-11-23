// 轻量全局状态：当前项目、拓扑、最近一次运行、回放帧、校验问题
import type { ProjectConfig, SimulationRun, ValidationIssue } from '../model/types';
import type { Topology } from '../model/topology';
import { defaultProject } from '../model/defaults';
import { buildTopology } from '../model/topology';
import { validateProject } from '../model/validation';
import { buildSeedProject } from '../model/seed';

type Listener = () => void;

class AppStore {
  project: ProjectConfig = buildSeedProject();
  topo: Topology = buildTopology(this.project);
  issues: ValidationIssue[] = [];
  runs: SimulationRun[] = [];
  /** 当前回放的运行记录（完整快照） */
  activeRun: SimulationRun | null = null;
  /** 回放帧索引 */
  replayFrame = 0;
  /** 3D 视图设置 */
  view = {
    cutaway: false,
    cutRack: 0,
    cabinOpacity: 0.12,
    showPropagation: true,
    showVents: true,
    showDetectors: true,
    showCooling: true,
  };
  selectedCell = -1;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() { this.listeners.forEach((fn) => fn()); }

  setProject(p: ProjectConfig, rebuild = true) {
    this.project = p;
    if (rebuild) this.rebuild();
    this.emit();
  }
  patchProject(mut: (p: ProjectConfig) => void) {
    mut(this.project);
    this.project.updatedAt = Date.now();
    this.rebuild();
    this.emit();
  }
  rebuild() {
    this.topo = buildTopology(this.project);
    this.issues = validateProject(this.project);
  }
  setRuns(runs: SimulationRun[]) { this.runs = runs; this.emit(); }
  setActiveRun(run: SimulationRun | null) {
    this.activeRun = run;
    this.replayFrame = run ? run.snapshotTimes.length - 1 : 0;
    this.emit();
  }
  setReplayFrame(i: number) {
    if (!this.activeRun) return;
    this.replayFrame = Math.max(0, Math.min(i, this.activeRun.snapshotTimes.length - 1));
    this.emit();
  }
  setView(patch: Partial<AppStore['view']>) { Object.assign(this.view, patch); this.emit(); }
  setSelectedCell(i: number) { this.selectedCell = i; this.emit(); }
}

export const store = new AppStore();
store.rebuild();
