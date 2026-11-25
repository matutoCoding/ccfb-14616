import { store } from '../state/store';
import { defaultCellSpec } from '../physics/constants';
import type { Chemistry } from '../types';

const num = (v: number, step = 0.001) => `<input type="number" step="${step}" value="${v}">`;

export function renderCellsPage(root: HTMLElement) {
  const c = store.state.config;
  const cell = c.cell;
  const il = c.cluster.interlayers;
  const ml = c.cluster.moduleLayout;
  root.innerHTML = `
    <div class="page-grid">
      <section class="panel">
        <h2>电芯规格</h2>
        <label>化学体系
          <select id="chem">
            <option value="LFP" ${cell.chemistry === 'LFP' ? 'selected' : ''}>磷酸铁锂 LFP</option>
            <option value="NCM" ${cell.chemistry === 'NCM' ? 'selected' : ''}>三元 NCM</option>
          </select>
        </label>
        <label>标称容量 Ah ${num(cell.capacityAh, 1)}</label>
        <label>外形 宽×高×深 mm
          <div class="row3">
            <input type="number" step="0.1" value="${(cell.width * 1000).toFixed(1)}" data-cell="widthMm">
            <input type="number" step="0.1" value="${(cell.height * 1000).toFixed(1)}" data-cell="heightMm">
            <input type="number" step="0.1" value="${(cell.depth * 1000).toFixed(1)}" data-cell="depthMm">
          </div>
        </label>
        <label>质量 kg <input type="number" step="0.01" value="${cell.mass}" data-cell="mass"></label>
        <label>比热 J/(kg·K) <input type="number" step="1" value="${cell.specificHeat}" data-cell="specificHeat"></label>
        <label>自产热起始温度 ℃ <input type="number" value="${(cell.selfHeatStartT - 273.15).toFixed(0)}" data-cell="selfHeatStartC"></label>
        <label>热失控触发温度 ℃ <input type="number" value="${(cell.trTriggerT - 273.15).toFixed(0)}" data-cell="trTriggerC"></label>
        <label>热失控放热量 kJ <input type="number" step="0.1" value="${(cell.trHeatTotal / 1000).toFixed(1)}" data-cell="trHeatKj"></label>
        <label>喷发时长 s <input type="number" step="0.5" value="${cell.ventDuration}" data-cell="ventDuration"></label>
        <label>喷发可燃气 mol <input type="number" step="0.05" value="${cell.ventGasMol}" data-cell="ventGasMol"></label>
        <label>火焰平台温度 ℃ <input type="number" value="${(cell.flamePlateauT - 273.15).toFixed(0)}" data-cell="flameC"></label>
        <label>平台维持 s <input type="number" value="${cell.flameHoldS}" data-cell="flameHoldS"></label>
      </section>
      <section class="panel">
        <h2>模组夹层(厚度 mm / 导热 W·m⁻¹K⁻¹)</h2>
        <h3>电芯间隔热垫(厚度 0 = 不加)</h3>
        <div class="row2">
          <label>厚度 <input type="number" step="0.1" value="${(il.aerogelPad.thickness * 1000).toFixed(2)}" data-il="padTmm"></label>
          <label>导热 <input type="number" step="0.001" value="${il.aerogelPad.conductivity}" data-il="padK"></label>
        </div>
        <h3>铝排</h3>
        <div class="row2">
          <label>厚度 <input type="number" step="0.1" value="${(il.aluminumBar.thickness * 1000).toFixed(2)}" data-il="barTmm"></label>
          <label>导热 <input type="number" step="0.1" value="${il.aluminumBar.conductivity}" data-il="barK"></label>
        </div>
        <h3>导热胶</h3>
        <div class="row2">
          <label>厚度 <input type="number" step="0.1" value="${(il.thermalGlue.thickness * 1000).toFixed(2)}" data-il="glueTmm"></label>
          <label>导热 <input type="number" step="0.01" value="${il.thermalGlue.conductivity}" data-il="glueK"></label>
        </div>
        <h3>电芯间空气隙(无实体夹层时生效)</h3>
        <label>间隙 mm <input type="number" step="0.1" value="${(il.cellGap * 1000).toFixed(2)}" data-il="gapMm"></label>
        <h3>模组外壳 / 液冷板</h3>
        <div class="row2">
          <label>外壳壁厚 mm <input type="number" step="0.1" value="${(ml.wallThickness * 1000).toFixed(2)}" data-ml="wallTmm"></label>
          <label>外壳导热 <input type="number" step="0.1" value="${ml.wallConductivity}" data-ml="wallK"></label>
        </div>
        <div class="row2">
          <label>冷板厚 mm <input type="number" step="0.1" value="${(ml.coldPlateThickness * 1000).toFixed(2)}" data-ml="plateTmm"></label>
          <label>冷板导热 <input type="number" step="0.1" value="${ml.coldPlateConductivity}" data-ml="plateK"></label>
        </div>
        <div class="hint">单位陷阱:厚度输入 mm 内部自动 /1000;导热系数参考 气凝胶 0.018、空气 0.026、铝 202。</div>
      </section>
      <section class="panel wide">
        <h2>个别电芯参数覆盖</h2>
        <table class="data-table">
          <thead><tr><th>电芯序号</th><th>覆盖字段</th><th>值</th><th></th></tr></thead>
          <tbody>
            ${Object.entries(c.cellOverrides).map(([idx, ov]) => `<tr><td>#${idx}</td><td colspan="2"><code>${JSON.stringify(ov)}</code></td><td><button data-del-ov="${idx}" class="btn small">删除</button></td></tr>`).join('')}
          </tbody>
        </table>
        <div class="row3">
          <input id="ov-idx" type="number" placeholder="电芯序号" style="width:120px">
          <select id="ov-field">
            <option value="contactK">接触导热 W/(m·K)</option>
            <option value="specificHeat">比热</option>
            <option value="trHeatTotal">放热量 J</option>
            <option value="mass">质量 kg</option>
          </select>
          <input id="ov-val" type="number" placeholder="数值">
          <button id="ov-add" class="btn">添加覆盖</button>
        </div>
      </section>
    </div>`;

  root.querySelector<HTMLSelectElement>('#chem')!.addEventListener('change', (e) => {
    const kind = (e.target as HTMLSelectElement).value as Chemistry;
    const d = defaultCellSpec(kind);
    store.update((cfg) => { Object.assign(cfg.cell, d); });
  });

  root.querySelectorAll<HTMLInputElement>('[data-cell]').forEach((el) => {
    el.addEventListener('change', () => store.update((cfg) => {
      const k = el.dataset.cell!;
      const v = +el.value;
      if (k === 'widthMm') cfg.cell.width = v / 1000;
      else if (k === 'heightMm') cfg.cell.height = v / 1000;
      else if (k === 'depthMm') cfg.cell.depth = v / 1000;
      else if (k === 'selfHeatStartC') cfg.cell.selfHeatStartT = v + 273.15;
      else if (k === 'trTriggerC') cfg.cell.trTriggerT = v + 273.15;
      else if (k === 'trHeatKj') cfg.cell.trHeatTotal = v * 1000;
      else if (k === 'flameC') cfg.cell.flamePlateauT = v + 273.15;
      else (cfg.cell as unknown as Record<string, number>)[k] = v;
    }));
  });
  root.querySelectorAll<HTMLInputElement>('[data-il]').forEach((el) => el.addEventListener('change', () => {
    const v = +el.value;
    store.update((cfg) => {
      const map: Record<string, () => void> = {
        padTmm: () => { cfg.cluster.interlayers.aerogelPad.thickness = v / 1000; },
        padK: () => { cfg.cluster.interlayers.aerogelPad.conductivity = v; },
        barTmm: () => { cfg.cluster.interlayers.aluminumBar.thickness = v / 1000; },
        barK: () => { cfg.cluster.interlayers.aluminumBar.conductivity = v; },
        glueTmm: () => { cfg.cluster.interlayers.thermalGlue.thickness = v / 1000; },
        glueK: () => { cfg.cluster.interlayers.thermalGlue.conductivity = v; },
        gapMm: () => { cfg.cluster.interlayers.cellGap = v / 1000; },
      };
      map[el.dataset.il!]();
    });
  }));
  root.querySelectorAll<HTMLInputElement>('[data-ml]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.ml!;
    const v = +el.value;
    store.update((cfg) => {
      if (k === 'wallTmm') cfg.cluster.moduleLayout.wallThickness = v / 1000;
      else if (k === 'wallK') cfg.cluster.moduleLayout.wallConductivity = v;
      else if (k === 'plateTmm') cfg.cluster.moduleLayout.coldPlateThickness = v / 1000;
      else if (k === 'plateK') cfg.cluster.moduleLayout.coldPlateConductivity = v;
    });
  }));
  root.querySelector('#ov-add')!.addEventListener('click', () => {
    const idx = +(root.querySelector('#ov-idx') as HTMLInputElement).value;
    const field = (root.querySelector('#ov-field') as HTMLSelectElement).value;
    const val = +(root.querySelector('#ov-val') as HTMLInputElement).value;
    if (Number.isInteger(idx) && Number.isFinite(val)) store.update((cfg) => { cfg.cellOverrides[idx] = { ...cfg.cellOverrides[idx], [field]: val }; });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-del-ov]').forEach((b) => b.addEventListener('click', () => {
    const k = Number(b.dataset.delOv);
    store.update((cfg) => { delete cfg.cellOverrides[k]; });
  }));
}
