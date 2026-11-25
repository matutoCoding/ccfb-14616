import { createDemoProject, createLargeProject, createThreeCellProject } from '../physics/demoData';
import type { ProjectConfig, SimResult, ValidationIssue } from '../types';
import { validateConfig } from '../physics/validation';
import { saveProject, listProjects, getProject } from '../db/storage';

export interface AppState {
  config: ProjectConfig;
  issues: ValidationIssue[];
  result: SimResult | null;
  projects: { id: string; name: string; createdAt: number; resultCount: number }[];
  page: string;
}

type Listener = (s: AppState) => void;

class Store {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = {
      config: createDemoProject(),
      issues: [],
      result: null,
      projects: [],
      page: location.hash.slice(1) || 'layout',
    };
    this.state.issues = validateConfig(this.state.config);
    addEventListener('hashchange', () => {
      this.state.page = location.hash.slice(1) || 'layout';
      this.emit();
    });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit() { this.listeners.forEach((l) => l({ ...this.state })); }

  update(mut: (c: ProjectConfig) => void) {
    mut(this.state.config);
    this.state.issues = validateConfig(this.state.config);
    this.state.result = null; // 参数变了,旧结果失效
    this.emit();
  }

  setResult(r: SimResult) { this.state.result = r; this.emit(); }

  navigate(page: string) { location.hash = page; }

  async persist() {
    await saveProject(this.state.config);
    this.state.projects = await listProjects();
    this.emit();
  }

  async refreshList() { this.state.projects = await listProjects(); this.emit(); }

  async load(id: string) {
    const rec = await getProject(id);
    if (rec) {
      this.state.config = rec.config;
      this.state.result = rec.results[0] ?? null;
      this.state.issues = validateConfig(rec.config);
      this.emit();
    }
  }

  loadDemo(kind: 'demo' | 'large' | 'three') {
    this.state.config = kind === 'demo' ? createDemoProject() : kind === 'large' ? createLargeProject() : createThreeCellProject();
    this.state.issues = validateConfig(this.state.config);
    this.state.result = null;
    this.emit();
  }
}

export const store = new Store();
