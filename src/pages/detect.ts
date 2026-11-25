import { store } from '../state/store';
import { buildLayout } from '../physics/geometry';
import type { DetectorKind, DetectorSpec, NozzleSpec, ProjectConfig } from '../types';
import { KELVIN_0C } from '../physics/constants';

const KIND: Record<DetectorKind, string> = { gas: '可燃气', smoke: '烟感', temp: '温感' };

export function renderDetectPage(root: HTMLElement) {
  const c = store.state.config;
  const layout = buildLayout(c);
  const room = layout.roomSize;
  root.innerHTML = `
    <div class="page-grid">
      <section class="panel wide">
        <h2>探测器布置(俯视图)</h2>
        ${detectorSvg(c, room.x, room.z)}
        <div class="legend">
          <span><i style="background:#ff5d5d"></i>可燃气</span>
          <span><i style="background:#f0b400"></i>烟感</span>
          <span><i style="background:#7ad7ff"></i>温感</span>
          <span><i style="background:#8affc1;border-radius:50%"></i>喷嘴</span>
        </div>
      </section>
      <section class="panel">
        <h2>探测器</h2>
        <table class="data-table">
          <thead><tr><th>类型</th><th>x</th><th>y</th><th>z</th><th>阈值</th><th></th></tr></thead>
          <tbody>
            ${c.detectors.map((d, i) => `<tr>
              <td>${KIND[d.kind]}</td><td>${d.x.toFixed(2)}</td><td>${d.y.toFixed(2)}</td><td>${d.z.toFixed(2)}</td>
              <td>${d.kind === 'temp' ? (d.threshold - KELVIN_0C).toFixed(0) + '℃' : d.threshold}</td>
              <td><button class="btn small" data-del-det="${i}">删</button></td></tr>`).join('')}
          </tbody>
        </table>
        <div class="row2">
          <select id="new-det-kind">${(Object.keys(KIND) as DetectorKind[]).map((k) => `<option value="${k}">${KIND[k]}</option>`).join('')}</select>
          <button id="add-det" class="btn">添加到舱中部</button>
        </div>
        <h2>全氟己酮喷嘴</h2>
        <table class="data-table">
          <thead><tr><th>x</th><th>y</th><th>z</th><th>半径 m</th><th>降温 K/s</th><th>喷放延时 s</th><th></th></tr></thead>
          <tbody>
            ${c.nozzles.map((n, i) => `<tr>
              <td><input type="number" step="0.1" value="${n.x}" data-nz="${i}" data-f="x"></td>
              <td><input type="number" step="0.1" value="${n.y}" data-nz="${i}" data-f="y"></td>
              <td><input type="number" step="0.1" value="${n.z}" data-nz="${i}" data-f="z"></td>
              <td><input type="number" step="0.1" value="${n.radius}" data-nz="${i}" data-f="radius"></td>
              <td><input type="number" step="0.1" value="${n.coolingRate}" data-nz="${i}" data-f="coolingRate"></td>
              <td><input type="number" step="1" value="${n.dischargeDelay}" data-nz="${i}" data-f="dischargeDelay"></td>
              <td><button class="btn small" data-del-nz="${i}">删</button></td></tr>`).join('')}
          </tbody>
        </table>
        <button id="add-nz" class="btn">添加喷嘴</button>
      </section>
      <section class="panel wide">
        <h2>报警时刻估算(基于最近一次仿真)</h2>
        ${store.state.result ? alarmTable(store.state.result.summary.detectorAlarms, store.state.result.summary.dischargeTime)
          : '<div class="hint">还没有仿真结果,先到「蔓延仿真」页运行。模型:喷发气体在本分区累积 mol/m³,按距离衰减后与阈值比较。</div>'}
      </section>
    </div>`;

  root.querySelector('#add-det')!.addEventListener('click', () => {
    const kind = (root.querySelector('#new-det-kind') as HTMLSelectElement).value as DetectorKind;
    store.update((cfg) => {
      const d: DetectorSpec = {
        id: `${kind}-${cfg.detectors.length + 1}`, kind,
        x: room.x / 2, y: room.y - 0.2, z: room.z / 2,
        threshold: kind === 'gas' ? 0.15 : kind === 'smoke' ? 0.02 : KELVIN_0C + 70,
      };
      cfg.detectors.push(d);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-del-det]').forEach((b) => b.addEventListener('click', () => {
    store.update((cfg) => cfg.detectors.splice(+b.dataset.delDet!, 1));
  }));
  root.querySelector('#add-nz')!.addEventListener('click', () => {
    store.update((cfg) => cfg.nozzles.push({ id: `nz-${cfg.nozzles.length + 1}`, x: room.x / 2, y: room.y - 0.15, z: room.z / 2, coolingRate: 1.2, radius: 3, dischargeDelay: 10 }));
  });
  root.querySelectorAll<HTMLButtonElement>('[data-del-nz]').forEach((b) => b.addEventListener('click', () => {
    store.update((cfg) => cfg.nozzles.splice(+b.dataset.delNz!, 1));
  }));
  root.querySelectorAll<HTMLInputElement>('[data-nz]').forEach((el) => el.addEventListener('change', () => {
    store.update((cfg) => {
      const n = cfg.nozzles[+el.dataset.nz!] as unknown as Record<string, number>;
      n[el.dataset.f!] = +el.value;
    });
  }));
}

function alarmTable(alarms: { detectorId: string; kind: DetectorKind; t: number }[], discharge: number | null) {
  if (!alarms.length) return '<div class="hint">本次仿真无探测器报警(检查阈值或探测器位置)。</div>';
  return `<table class="data-table"><thead><tr><th>探测器</th><th>类型</th><th>报警时刻 s</th></tr></thead><tbody>
    ${alarms.map((a) => `<tr><td>${a.detectorId}</td><td>${KIND[a.kind]}</td><td>${a.t.toFixed(1)}</td></tr>`).join('')}
  </tbody></table>
  <div class="hint">首报 ${alarms[0].t.toFixed(1)}s → 设计延时后喷放时刻 <b>${discharge?.toFixed(1) ?? '—'}s</b>。</div>`;
}

function detectorSvg(c: ProjectConfig, rx: number, rz: number) {
  const sc = 55;
  const color: Record<string, string> = { gas: '#ff5d5d', smoke: '#f0b400', temp: '#7ad7ff' };
  return `<svg viewBox="0 0 ${rx * sc + 10} ${rz * sc + 10}" class="topview">
    <rect x="0" y="0" width="${rx * sc}" height="${rz * sc}" fill="#16202e" stroke="#3a4a60"/>
    ${c.detectors.map((d: DetectorSpec) => `<circle cx="${d.x * sc}" cy="${(rz - d.z) * sc}" r="7" fill="${color[d.kind]}"><title>${d.id}</title></circle>`).join('')}
    ${c.nozzles.map((n: NozzleSpec) => `<g><circle cx="${n.x * sc}" cy="${(rz - n.z) * sc}" r="9" fill="none" stroke="#8affc1" stroke-width="2"/><circle cx="${n.x * sc}" cy="${(rz - n.z) * sc}" r="3" fill="#8affc1"/></g>`).join('')}
  </svg>`;
}
