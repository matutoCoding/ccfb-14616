import { mountShell } from './shell';
import { store } from './state/store';
import { renderLayoutPage } from './pages/layout';
import { renderCellsPage } from './pages/cells';
import { renderTriggerPage } from './pages/trigger';
import { renderSimPage } from './pages/sim';
import { renderDetectPage } from './pages/detect';
import { renderReportPage } from './pages/report';
import './styles.css';

const root = document.querySelector('#app')! as HTMLElement;
mountShell(root);

const pageRoot = root.querySelector('#page')! as HTMLElement;
let cleanup: (() => void) | void;

const RENDERERS: Record<string, (el: HTMLElement) => unknown> = {
  layout: renderLayoutPage,
  cells: renderCellsPage,
  trigger: renderTriggerPage,
  sim: renderSimPage,
  detect: renderDetectPage,
  report: renderReportPage,
};

function route() {
  if (typeof cleanup === 'function') cleanup();
  const page = store.state.page;
  cleanup = RENDERERS[page]?.(pageRoot) as (() => void) | void;
}
store.subscribe(route);
route();
