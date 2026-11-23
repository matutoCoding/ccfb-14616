// 页面 6：评审报告
import { store } from '../store/appStore';
import { h, toast, download } from '../ui/dom';
import { idb } from '../store/idb';
import { runSimulation } from '../physics/engine';
import { buildMarkdown, buildCsv, runToRow, type ScenarioRow } from '../physics/report';
import { hasError } from '../model/validation';
import { k2c } from '../model/defaults';
import type { SimulationRun } from '../model/types';

export function pageReport(): HTMLElement {
  const root = h('div', { class: 'wide' });
  const p = store.project;

  const tableWrap = h('div');
  let rows: ScenarioRow[] = [];
  let loadedRuns: SimulationRun[] = [];

  const renderTable = () => {
    tableWrap.innerHTML = '';
    if (!rows.length) { tableWrap.append(h('div', { class: 'muted small' }, '暂无对比方案，先在蔓延仿真页运行，或用下方批量对比自动跑三组方案')); return; }
    const tbl = h('table');
    tbl.append(h('thead', {}, h('tr', {},
      h('th', {}, '方案'), h('th', {}, '求解器'), h('th', {}, '物理时长'), h('th', {}, '隔热垫'),
      h('th', {}, '间距 mm'), h('th', {}, '喷放延时 s'), h('th', {}, '首次报警 s'), h('th', {}, '喷放 s'),
      h('th', {}, '首次蔓延 s'), h('th', {}, '失控数'), h('th', {}, '占比'), h('th', {}, '墙钟 s'),
      h('th', {}, '各簇最高温 ℃'))));
    const tb = h('tbody');
    for (const r of rows) {
      tb.append(h('tr', {},
        h('td', {}, r.tag), h('td', {}, r.solver), h('td', {}, r.physicalTime.toFixed(0) + 's'),
        h('td', { class: r.aerogel ? 'ok-text' : 'warn-text' }, r.aerogel ? '加' : '无'),
        h('td', {}, r.cellGapMm.toFixed(1)),
        h('td', {}, String(r.dischargeDelay)),
        h('td', {}, r.firstAlarm >= 0 ? r.firstAlarm.toFixed(1) : '—'),
        h('td', {}, r.dischargeTime >= 0 ? r.dischargeTime.toFixed(1) : '未喷'),
        h('td', { class: r.firstPropagation < 0 ? 'ok-text' : 'err-text' }, r.firstPropagation < 0 ? '未蔓延' : r.firstPropagation.toFixed(1)),
        h('td', {}, String(r.runawayCount)),
        h('td', {}, r.runawayPct.toFixed(2) + '%'),
        h('td', {}, (r.wallMs / 1000).toFixed(1)),
        h('td', { class: 'small' }, r.rackMaxTemp.map((t) => k2c(t).toFixed(0)).join(' / '))));
    }
    tbl.append(tb);
    tableWrap.append(tbl);
  };

  const loadSaved = h('button', { class: 'ghost' }, '载入已存运行进行对比');
  loadSaved.addEventListener('click', async () => {
    const summaries = await idb.listRuns(p.id);
    if (!summaries.length) { toast('没有已存运行'); return; }
    loadedRuns = [];
    for (const s of summaries) {
      const full = await idb.loadRun(s.id);
      if (full) loadedRuns.push(full);
    }
    rows = loadedRuns.map((r) => runToRow(r, p));
    renderTable();
    toast(`已载入 ${loadedRuns.length} 条运行`);
  });

  // —— 批量对比：隔热垫 有/无 × 喷放延时 10s/30s ——
  const batchBtn = h('button', {}, '自动跑三组对比方案（加气凝胶 / 无隔热垫 / 喷放延时加倍）');
  const batchStatus = h('div', { class: 'muted small' }, '');
  batchBtn.addEventListener('click', async () => {
    if (hasError(store.issues)) { toast('存在参数错误，请先修正'); return; }
    if (!p.triggers.length) { toast('请先设置触发点'); return; }
    batchBtn.disabled = true;
    const variants: { tag: string; patch: (c: typeof p) => void }[] = [
      { tag: 'A 加气凝胶垫+10s喷放', patch: (c) => { c.materials.aerogelEnabled = true; c.suppression.dischargeDelay = 10; } },
      { tag: 'B 无隔热垫+10s喷放', patch: (c) => { c.materials.aerogelEnabled = false; c.suppression.dischargeDelay = 10; } },
      { tag: 'C 加气凝胶垫+20s喷放', patch: (c) => { c.materials.aerogelEnabled = true; c.suppression.dischargeDelay = 20; } },
    ];
    rows = [];
    loadedRuns = [];
    // 保存原始值，跑完恢复
    const orig = structuredClone(p);
    for (const v of variants) {
      batchStatus.textContent = `正在运行：${v.tag} …`;
      await new Promise((r) => setTimeout(r, 30));
      store.patchProject(v.patch);
      try {
        const out = await runSimulation(store.project, {
          endTime: 3600, maxDt: 2, snapshotInterval: 20, scenarioTag: v.tag,
          onProgress: (pr) => { batchStatus.textContent = `${v.tag}：${pr.physicalTime.toFixed(0)}s / 3600s，失控 ${pr.runawayCount} 颗`; },
        });
        await idb.saveRun(out.run);
        loadedRuns.push(out.run);
        rows.push(runToRow(out.run, store.project));
        renderTable();
      } catch (e) {
        toast(`${v.tag} 失败：${(e as Error).message}`);
      }
    }
    store.setProject(orig);
    batchBtn.disabled = false;
    batchStatus.textContent = '三组方案完成，可导出报告';
    toast('对比完成');
  });

  const expMd = h('button', {}, '导出 Markdown 评审报告');
  expMd.addEventListener('click', () => {
    if (!rows.length) { toast('没有可导出的方案'); return; }
    download(`储能舱热失控评审报告_${Date.now()}.md`, buildMarkdown(p, rows), 'text/markdown');
  });
  const expCsv = h('button', { class: 'ghost' }, '导出 CSV 数据表');
  expCsv.addEventListener('click', () => {
    if (!rows.length) { toast('没有可导出的方案'); return; }
    download(`蔓延仿真对比_${Date.now()}.csv`, buildCsv(rows), 'text/csv');
  });

  root.append(
    h('h2', {}, '评审报告（方案横向对比，导出后可直接提交评审专家）'),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, batchBtn, loadSaved, expMd, expCsv),
    batchStatus,
    tableWrap,
    h('h3', {}, '说明'),
    h('ul', { class: 'muted small', style: 'line-height:1.8' },
      h('li', {}, '首次蔓延时间：第一颗外部触发电芯之外，首次有电芯被导热引燃的时刻；“未蔓延”表示观测窗内热阻隔有效。'),
      h('li', {}, '失控占比 = 最终失控电芯 / 电芯总数，是评审最关注的蔓延抑制指标。'),
      h('li', {}, '各簇最高温用于判断泵故障工况下邻簇是否被热辐射/对流波及。'),
      h('li', {}, 'Markdown 报告含完整配置、对比表与结论要点；CSV 可直接粘贴进评审 PPT/Excel。')),
  );
  renderTable();
  return root;
}
