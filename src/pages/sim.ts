// 页面 4：蔓延仿真
import { store } from '../store/appStore';
import { h, toast } from '../ui/dom';
import { runSimulation } from '../physics/engine';
import { hasError } from '../model/validation';
import { idb } from '../store/idb';
import { k2c } from '../model/defaults';
import type { SimulationRun } from '../model/types';

export function pageSim(): HTMLElement {
  const root = h('div');
  const p = store.project;

  const gpuAvail = await_flag();
  const ctrl = h('div', { class: 'grid c4' });
  const endInp = h('input', { type: 'number', value: '7200', min: '60', step: '60' }) as HTMLInputElement;
  const snapInp = h('input', { type: 'number', value: '10', min: '1', step: '1' }) as HTMLInputElement;
  const dtInp = h('input', { type: 'number', value: '2', min: '0.1', step: '0.1' }) as HTMLInputElement;
  const tagInp = h('input', { value: p.materials.aerogelEnabled ? '加气凝胶垫' : '无隔热垫' }) as HTMLInputElement;
  const solverSel = h('select') as HTMLSelectElement;
  solverSel.append(new Option(gpuAvail ? 'WebGPU 计算着色器（推荐）' : 'WebGPU 不可用，使用 CPU', 'gpu'), new Option('CPU 参照求解器', 'cpu'));
  if (!gpuAvail) solverSel.value = 'cpu';
  ctrl.append(
    h('div', { class: 'field' }, h('label', {}, '物理时长 s'), endInp),
    h('div', { class: 'field' }, h('label', {}, '快照间隔 s'), snapInp),
    h('div', { class: 'field' }, h('label', {}, '最大积分步长 s（超出稳定条件自动切小）'), dtInp),
    h('div', { class: 'field' }, h('label', {}, '求解器'), solverSel),
    h('div', { class: 'field' }, h('label', {}, '方案标签（报告对比用）'), tagInp),
  );

  const progressWrap = h('div', { class: 'progress-wrap' }, h('div', { class: 'progress-bar', style: 'width:0%' }));
  const status = h('div', { class: 'muted small' }, '就绪');

  const metrics = h('div', { class: 'grid c4', style: 'margin:10px 0' });
  const metric = (k: string) => { const el = h('div', { class: 'metric' }, h('div', { class: 'v' }, '-'), h('div', { class: 'k' }, k)); return el; };
  const mFirst = metric('首次蔓延时间 s');
  const mCount = metric('最终失控电芯');
  const mWall = metric('墙钟耗时 s');
  const mRto = metric('实时倍率（物理s/墙钟s）');
  metrics.append(mFirst, mCount, mWall, mRto);

  let running = { cancelled: false };
  const runBtn = h('button', {}, '▶ 开始仿真');
  const stopBtn = h('button', { class: 'danger' }, '■ 停止');
  stopBtn.disabled = true;

  runBtn.addEventListener('click', async () => {
    if (hasError(store.issues)) {
      toast('存在参数错误（见舱体布置页），已阻止仿真以避免“算出一舱炸”');
      return;
    }
    if (!p.triggers.length) { toast('请先在触发场景页设置触发点'); return; }
    running = { cancelled: false };
    runBtn.disabled = true; stopBtn.disabled = false;
    const t0 = performance.now();
    try {
      const out = await runSimulation(store.project, {
        endTime: Number(endInp.value),
        maxDt: Number(dtInp.value),
        snapshotInterval: Number(snapInp.value),
        solverPref: solverSel.value as 'gpu' | 'cpu',
        scenarioTag: tagInp.value || '未命名方案',
        signal: running,
        onProgress: (pr) => {
          const pct = (100 * pr.physicalTime / pr.targetTime).toFixed(1);
          (progressWrap.firstChild as HTMLElement).style.width = `${pct}%`;
          status.textContent = `物理时间 ${pr.physicalTime.toFixed(0)}s / ${pr.targetTime}s · 当前 dt=${pr.currentDt.toFixed(3)}s · 已失控 ${pr.runawayCount} 颗 · 已用 ${(pr.wallMs / 1000).toFixed(1)}s`;
        },
      });
      await idb.saveRun(out.run);
      store.setActiveRun(out.run);
      const runs = await idb.listRuns(p.id);
      store.setRuns(runs);
      const wall = out.run.wallMs / 1000;
      (mFirst.querySelector('.v')!).textContent = out.run.firstPropagationTime >= 0 ? out.run.firstPropagationTime.toFixed(1) : '未蔓延';
      (mCount.querySelector('.v')!).textContent = String(out.run.finalRunawayCount);
      (mWall.querySelector('.v')!).textContent = wall.toFixed(1);
      (mRto.querySelector('.v')!).textContent = (out.run.physicalTime / Math.max(wall, 0.01)).toFixed(1);
      status.innerHTML = `完成：求解器 <b>${out.solver.toUpperCase()}</b>，${out.run.events.length} 次失控事件，${out.alarms.length} 次报警，喷放时刻 ${out.run.dischargeTime >= 0 ? out.run.dischargeTime.toFixed(1) + 's' : '未喷放'}`;
      buildTimeline(out.run);
      buildEventTable(out.run);
      toast(`仿真完成，耗时 ${wall.toFixed(1)}s，已存入 IndexedDB`);
    } catch (e) {
      status.textContent = `仿真失败：${(e as Error).message}`;
    } finally {
      runBtn.disabled = false; stopBtn.disabled = true;
      void t0;
    }
  });
  stopBtn.addEventListener('click', () => { running.cancelled = true; toast('正在停止…'); });

  // —— 时间轴回放 ——
  const tlWrap = h('div');
  const buildTimeline = (run: SimulationRun) => {
    tlWrap.innerHTML = '';
    const slider = h('input', { type: 'range', min: '0', max: String(run.snapshotTimes.length - 1), value: String(run.snapshotTimes.length - 1) }) as HTMLInputElement;
    const tLabel = h('span', { class: 'tag' }, '');
    const playBtn = h('button', { class: 'ghost small' }, '▶ 回放');
    const update = () => {
      const i = Number(slider.value);
      store.setReplayFrame(i);
      tLabel.textContent = `t = ${run.snapshotTimes[i].toFixed(1)} s`;
    };
    slider.addEventListener('input', update);
    let playing = false; let timer = 0;
    playBtn.addEventListener('click', () => {
      if (playing) { playing = false; clearInterval(timer); playBtn.textContent = '▶ 回放'; return; }
      playing = true; playBtn.textContent = '⏸ 暂停';
      timer = window.setInterval(() => {
        const next = Math.min(Number(slider.value) + 1, run.snapshotTimes.length - 1);
        slider.value = String(next); update();
        if (next >= run.snapshotTimes.length - 1) { playing = false; clearInterval(timer); playBtn.textContent = '▶ 回放'; }
      }, 120);
    });
    tlWrap.append(h('div', { class: 'timeline' }, playBtn, slider, tLabel));
    // 事件刻度
    const marks = h('div', { class: 'row small muted', style: 'gap:14px;flex-wrap:wrap' });
    run.events.slice(0, 12).forEach((e) => {
      marks.append(h('span', {}, `#${e.cellIndex}@${e.time.toFixed(0)}s${e.cause.startsWith('prop') ? '↯' : '★'}`));
    });
    if (run.events.length > 12) marks.append(h('span', {}, `…共 ${run.events.length} 起`));
    tlWrap.append(marks);
    update();
  };

  // —— 事件顺序表 ——
  const eventWrap = h('div');
  const buildEventTable = (run: SimulationRun) => {
    eventWrap.innerHTML = '';
    const tbl = h('table');
    tbl.append(h('thead', {}, h('tr', {},
      h('th', {}, '序号'), h('th', {}, '时刻 s'), h('th', {}, '电芯#'), h('th', {}, '簇'), h('th', {}, '模组'), h('th', {}, '类型'), h('th', {}, '来源'))));
    const tb = h('tbody');
    run.events.forEach((e, i) => {
      const cross = i > 0 && e.moduleId !== run.events[i - 1].moduleId;
      tb.append(h('tr', {},
        h('td', {}, String(i + 1)),
        h('td', {}, e.time.toFixed(1)),
        h('td', {}, String(e.cellIndex)),
        h('td', {}, String(e.rackId + 1)),
        h('td', {}, String(e.moduleId + 1)),
        h('td', { class: cross ? 'warn-text' : '' }, cross ? '跨模组蔓延' : '模组内蔓延'),
        h('td', {}, e.cause === 'trigger' ? '外部触发' : e.cause)));
    });
    tbl.append(tb);
    eventWrap.append(h('h3', {}, '失控事件顺序（★触发 / ↯蔓延；紫色路径=跨模组，橙色=模组内）'), tbl);
  };

  // 已存运行列表
  const savedWrap = h('div');
  const renderSaved = async () => {
    savedWrap.innerHTML = '';
    const runs = await idb.listRuns(p.id);
    if (!runs.length) { savedWrap.append(h('div', { class: 'muted small' }, '暂无历史运行')); return; }
    const tbl = h('table');
    tbl.append(h('thead', {}, h('tr', {}, h('th', {}, '方案'), h('th', {}, '求解器'), h('th', {}, '物理时长'), h('th', {}, '首蔓延 s'), h('th', {}, '失控数'), h('th', {}, '操作'))));
    const tb = h('tbody');
    for (const r of runs) {
      tb.append(h('tr', {},
        h('td', {}, r.scenarioTag),
        h('td', {}, r.solver.toUpperCase()),
        h('td', {}, `${r.physicalTime.toFixed(0)}s`),
        h('td', {}, r.firstPropagationTime >= 0 ? r.firstPropagationTime.toFixed(1) : '—'),
        h('td', {}, String(r.finalRunawayCount)),
        h('td', {}, h('button', {
          class: 'ghost small', onclick: async () => {
            const full = await idb.loadRun(r.id);
            if (full) { store.setActiveRun(full); buildTimeline(full); buildEventTable(full); toast('已载入回放'); }
          },
        }, '回放'), ' ', h('button', {
          class: 'ghost small', onclick: async () => { await idb.deleteRun(r.id); renderSaved(); toast('已删除'); },
        }, '删除'))));
    }
    tbl.append(tb);
    savedWrap.append(h('h3', {}, '历史运行（IndexedDB）'), tbl);
  };
  renderSaved();

  // 簇最高温
  const rackInfo = h('div', { class: 'muted small' });
  const showRack = () => {
    const r = store.activeRun;
    if (!r) return;
    rackInfo.innerHTML = r.rackMaxTemp.map((t, i) => `簇${i + 1}最高 ${k2c(t).toFixed(1)}℃`).join('　');
  };
  store.subscribe(showRack);

  root.append(
    h('h2', {}, '蔓延仿真'),
    ctrl,
    h('div', { class: 'row', style: 'margin:10px 0' }, runBtn, stopBtn),
    progressWrap, status,
    metrics, rackInfo,
    h('h3', {}, '时间轴回放（拖动查看任意时刻温度场与喷发状态）'), tlWrap,
    eventWrap, savedWrap,
  );
  if (store.activeRun) { buildTimeline(store.activeRun); buildEventTable(store.activeRun); showRack(); }
  return root;
}

function await_flag(): boolean {
  // 同步拿不到 GPU 状态，用默认 true，初始化失败时引擎自动回退 CPU
  return !!navigator.gpu;
}
