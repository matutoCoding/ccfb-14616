import { store } from './state/store';
import type { AppState } from './state/store';

const NAV = [
  ['layout', '舱体布置'], ['cells', '电芯模组'], ['trigger', '触发场景'],
  ['sim', '蔓延仿真'], ['detect', '探测喷放'], ['report', '评审报告'],
] as const;

export function mountShell(root: HTMLElement) {
  root.innerHTML = `
    <header class="topbar">
      <div class="brand">储能舱热失控蔓延仿真 <span class="tag">TS + WebGPU/WGSL</span></div>
      <nav id="nav"></nav>
      <div class="actions">
        <button id="btn-save" class="btn">存 IndexedDB</button>
        <select id="demo-select" class="btn">
          <option value="">载入示例…</option>
          <option value="demo">40尺两簇演示舱(含异常参数)</option>
          <option value="large">1.2万颗性能舱(含停泵)</option>
          <option value="three">三电芯手算小算例</option>
        </select>
      </div>
    </header>
    <div id="issue-bar"></div>
    <main id="page"></main>
    <div id="toast"></div>`;

  const nav = root.querySelector('#nav')!;
  nav.innerHTML = NAV.map(([k, label]) => `<a class="nav-item" data-page="${k}" href="#${k}">${label}</a>`).join('');

  root.querySelector('#btn-save')!.addEventListener('click', async () => {
    await store.persist();
    toast('已保存到 IndexedDB');
  });
  root.querySelector('#demo-select')!.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) { store.loadDemo(v as 'demo' | 'large' | 'three'); toast('示例已载入'); }
    (e.target as HTMLSelectElement).value = '';
  });

  store.subscribe((s) => {
    nav.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.page === s.page);
    });
    const bar = root.querySelector('#issue-bar')!;
    const errors = s.issues.filter((i) => i.level === 'error');
    const warns = s.issues.filter((i) => i.level === 'warning');
    bar.className = 'issue-bar ' + (errors.length ? 'has-error' : warns.length ? 'has-warn' : 'ok');
    bar.innerHTML = errors.length || warns.length
      ? `<b>参数校验 ${errors.length ? `❌ ${errors.length} 个错误` : ''} ${warns.length ? `⚠️ ${warns.length} 个警告` : ''}</b>
         <div class="issue-list">${[...errors, ...warns].map((i) => `<div class="issue ${i.level}">${i.message}</div>`).join('')}</div>`
      : '<b>✅ 参数校验通过</b>';
  });
}

export function toast(msg: string) {
  const el = document.querySelector('#toast')!;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}
