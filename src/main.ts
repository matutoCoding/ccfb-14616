// 应用入口：hash 路由 + 侧边导航 + 全局 3D 视口挂载
import './styles.css';
import { mount3d, unmount3d } from './view3d';
import { store } from './store/appStore';
import { pageCabin } from './pages/cabin';
import { pageModule } from './pages/module';
import { pageTrigger } from './pages/trigger';
import { pageSim } from './pages/sim';
import { pageDetect } from './pages/detect';
import { pageReport } from './pages/report';

const NAV: { hash: string; label: string; icon: string; build: () => HTMLElement }[] = [
  { hash: '#/cabin', label: '舱体布置', icon: '▣', build: pageCabin },
  { hash: '#/module', label: '电芯模组', icon: '▤', build: pageModule },
  { hash: '#/trigger', label: '触发场景', icon: '✦', build: pageTrigger },
  { hash: '#/sim', label: '蔓延仿真', icon: '▶', build: pageSim },
  { hash: '#/detect', label: '探测喷放', icon: '◉', build: pageDetect },
  { hash: '#/report', label: '评审报告', icon: '▦', build: pageReport },
];

function render() {
  const hash = location.hash || '#/cabin';
  const nav = NAV.find((n) => n.hash === hash) ?? NAV[0];
  document.querySelector('#app')!.innerHTML = `
    <aside class="sidebar">
      <div class="brand">储能舱热失控<br>蔓延仿真系统</div>
      ${NAV.map((n) => `
        <a class="navitem ${n.hash === nav.hash ? 'active' : ''}" href="${n.hash}">
          <span class="icon">${n.icon}</span>${n.label}
        </a>`).join('')}
      <div class="side-foot">
        <div>电芯总数：<b id="cell-count">${store.topo.cellCount}</b></div>
        <div id="issue-badge"></div>
      </div>
    </aside>
    <main class="main">
      <div id="view3d" class="view3d"></div>
      <section id="page" class="page"></section>
    </main>`;
  mount3d(document.querySelector('#view3d')!);
  const pageEl = document.querySelector('#page')!;
  pageEl.innerHTML = '';
  pageEl.appendChild(nav.build());
  renderIssueBadge();
}

function renderIssueBadge() {
  const el = document.querySelector('#issue-badge');
  if (!el) return;
  const errs = store.issues.filter((i) => i.level === 'error').length;
  const warns = store.issues.filter((i) => i.level === 'warning').length;
  el.innerHTML = errs
    ? `<span class="badge err">${errs} 个参数错误</span>`
    : warns ? `<span class="badge warn">${warns} 个警告</span>`
      : `<span class="badge ok">参数校验通过</span>`;
  const cc = document.querySelector('#cell-count');
  if (cc) cc.textContent = String(store.topo.cellCount);
}

window.addEventListener('hashchange', render);
store.subscribe(() => renderIssueBadge());
render();
void unmount3d;
// 调试钩子（控制台自动化测试用）
(window as unknown as { __store: unknown }).__store = store;
