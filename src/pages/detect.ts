// 页面 5：探测喷放 + 液冷工况
import { store } from '../store/appStore';
import { h, numField, toast } from '../ui/dom';
import { uid, k2c } from '../model/defaults';
import type { DetectorKind } from '../model/types';
import { refreshRenderer } from '../view3d';

const DET_LABEL: Record<DetectorKind, string> = { gas: '可燃气体', smoke: '烟感', temp: '温感' };

export function pageDetect(): HTMLElement {
  const p = store.project;
  const root = h('div');

  // —— 探测器 ——
  const detWrap = h('div');
  const renderDet = () => {
    detWrap.innerHTML = '';
    const tbl = h('table');
    tbl.append(h('thead', {}, h('tr', {},
      h('th', {}, '类型'), h('th', {}, '编号'), h('th', {}, '分区'), h('th', {}, 'X m'), h('th', {}, 'Y m'), h('th', {}, 'Z m'), h('th', {}, '报警阈值'), h('th', {}, '操作'))));
    const tb = h('tbody');
    p.detectors.forEach((d, i) => {
      const posInputs = d.position.map((v, ax) => {
        const inp = h('input', { type: 'number', step: '0.05', value: v.toFixed(2), style: 'width:78px' }) as HTMLInputElement;
        inp.addEventListener('change', () => store.patchProject((c) => { c.detectors[i].position[ax] = Number(inp.value); refreshRenderer(); }));
        return inp;
      });
      const thrInp = h('input', { type: 'number', step: '0.01', value: String(d.kind === 'temp' ? k2c(d.threshold).toFixed(0) : d.threshold) }) as HTMLInputElement;
      thrInp.addEventListener('change', () => {
        const v = Number(thrInp.value);
        store.patchProject((c) => { c.detectors[i].threshold = d.kind === 'temp' ? v + 273.15 : v; });
      });
      tb.append(h('tr', {},
        h('td', {}, h('span', { class: `tag ${d.kind}` }, DET_LABEL[d.kind])),
        h('td', {}, d.label),
        h('td', {}, String(d.zone + 1)),
        h('td', {}, posInputs[0]), h('td', {}, posInputs[1]), h('td', {}, posInputs[2]),
        h('td', {}, thrInp, h('span', { class: 'muted small' }, d.kind === 'temp' ? ' ℃' : d.kind === 'gas' ? ' mol/m³' : ' %/m')),
        h('td', {}, h('button', {
          class: 'ghost small', onclick: () => { store.patchProject((c) => { c.detectors.splice(i, 1); }); renderDet(); },
        }, '删除'))));
    });
    tbl.append(tb);
    detWrap.append(tbl);
  };
  renderDet();

  const addDet = (kind: DetectorKind) => {
    const zone = p.detectors.length % Math.max(p.cabin.rackCount, 1);
    store.patchProject((c) => {
      c.detectors.push({
        id: uid('det'), kind, label: `${DET_LABEL[kind]}#${c.detectors.length + 1}`,
        position: [2 + zone * 4.5, 2.2, 1.2], zone,
        threshold: kind === 'gas' ? 0.25 : kind === 'smoke' ? 15 : k2c(70),
      });
    });
    renderDet(); refreshRenderer();
  };

  // —— 液冷 ——
  const cool = p.cooling;
  const coolGrid = h('div', { class: 'grid c4' });
  const coolChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  coolChk.checked = cool.enabled;
  coolChk.addEventListener('change', () => { store.patchProject((c) => { c.cooling.enabled = coolChk.checked; }); root.replaceWith(pageDetect()); });
  coolGrid.append(
    h('div', { class: 'field' }, h('label', {}, '启用液冷'), coolChk),
    numField('进液温度', k2c(cool.inletTemp), 1, (v) => store.patchProject((c) => { c.cooling.inletTemp = v + 273.15; }), '℃'),
    numField('总流量', cool.flowLpm, 5, (v) => store.patchProject((c) => { c.cooling.flowLpm = v; }), 'L/min'),
    numField('泵故障时刻', cool.failTime, 10, (v) => store.patchProject((c) => { c.cooling.failTime = v; }), 's'),
  );
  const branchRow = h('div', { class: 'row' }, h('span', { class: 'muted' }, '停泵支路（勾选后该簇到故障时刻失去冷却，观察邻簇升温）：'));
  for (let r = 0; r < p.cabin.rackCount; r++) {
    const chk = h('input', { type: 'checkbox' }) as HTMLInputElement;
    chk.checked = cool.failedBranches.includes(r);
    chk.addEventListener('change', () => {
      store.patchProject((c) => {
        const set = new Set(c.cooling.failedBranches);
        chk.checked ? set.add(r) : set.delete(r);
        c.cooling.failedBranches = [...set];
      });
    });
    branchRow.append(h('label', { style: 'display:flex;gap:4px;align-items:center' }, chk, `簇${r + 1}`));
  }

  // —— 灭火剂 ——
  const sup = p.suppression;
  const supGrid = h('div', { class: 'grid c4' });
  const supChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  supChk.checked = sup.enabled;
  supChk.addEventListener('change', () => { store.patchProject((c) => { c.suppression.enabled = supChk.checked; }); root.replaceWith(pageDetect()); });
  const agentSel = h('select') as HTMLSelectElement;
  [['FK-5-1-12', '全氟己酮 FK-5-1-12'], ['HFC-227ea', '七氟丙烷 HFC-227ea'], ['water-mist', '细水雾']].forEach(([v, l]) => agentSel.append(new Option(l, v)));
  agentSel.value = sup.agent;
  agentSel.addEventListener('change', () => store.patchProject((c) => { c.suppression.agent = agentSel.value as typeof sup.agent; }));
  supGrid.append(
    h('div', { class: 'field' }, h('label', {}, '启用灭火系统'), supChk),
    h('div', { class: 'field' }, h('label', {}, '灭火剂'), agentSel),
    numField('喷放延时', sup.dischargeDelay, 1, (v) => store.patchProject((c) => { c.suppression.dischargeDelay = v; }), 's'),
    numField('等效降温速率', sup.coolRate, 0.05, (v) => store.patchProject((c) => { c.suppression.coolRate = v; }), 'K/s'),
    numField('作用时长', sup.duration, 10, (v) => store.patchProject((c) => { c.suppression.duration = v; }), 's'),
    numField('分区体积', sup.zoneVolume, 1, (v) => store.patchProject((c) => { c.suppression.zoneVolume = v; }), 'm³'),
  );

  // —— 最近一次报警结果 ——
  const alarmWrap = h('div');
  const run = store.activeRun;
  if (run && run.alarms.length) {
    const tbl = h('table');
    tbl.append(h('thead', {}, h('tr', {}, h('th', {}, '探测器'), h('th', {}, '类型'), h('th', {}, '分区'), h('th', {}, '报警时刻 s'), h('th', {}, '读数'), h('th', {}, '距首喷放 s'))));
    const tb = h('tbody');
    for (const a of run.alarms) {
      tb.append(h('tr', {},
        h('td', {}, a.detectorId),
        h('td', {}, DET_LABEL[a.kind]),
        h('td', {}, String(a.zone + 1)),
        h('td', {}, a.time.toFixed(1)),
        h('td', {}, a.kind === 'temp' ? `${k2c(a.reading).toFixed(1)}℃` : a.reading.toFixed(3)),
        h('td', {}, run.dischargeTime >= 0 ? (run.dischargeTime - a.time).toFixed(1) : '未喷放')));
    }
    tbl.append(tb);
    alarmWrap.append(tbl);
  } else {
    alarmWrap.append(h('div', { class: 'muted small' }, '运行仿真后在此显示各探测器报警时刻与喷放联动时序'));
  }

  root.append(
    h('h2', {}, '探测与喷放'),
    h('h3', {}, '探测器布置（气体分区模型：按喷发量/分区体积估算浓度报警时刻）'),
    detWrap,
    h('div', { class: 'row', style: 'margin:8px 0 16px' },
      ...(['gas', 'smoke', 'temp'] as DetectorKind[]).map((k) => h('button', { class: 'ghost', onclick: () => addDet(k) }, `＋ ${DET_LABEL[k]}`))),
    h('h3', {}, '液冷系统（可设某一路泵停）'), coolGrid, branchRow,
    h('h3', {}, '灭火剂喷放（喷放后按设定降温速率作用到电芯）'), supGrid,
    h('h3', {}, '最近一次仿真的报警时序'), alarmWrap,
  );
  void toast;
  return root;
}
