// 页面 2：电芯模组参数
import { store } from '../store/appStore';
import { h, numField, toast } from '../ui/dom';
import { LFP_280AH, NCM_50AH, c2k, k2c } from '../model/defaults';
import { refreshRenderer } from '../view3d';

export function pageModule(): HTMLElement {
  const p = store.project;
  const root = h('div');

  // —— 化学体系切换 ——
  const chemSel = h('select') as HTMLSelectElement;
  chemSel.append(new Option(LFP_280AH.name, 'lfp'), new Option(NCM_50AH.name, 'ncm'));
  chemSel.value = p.chem.kind === 'LFP' ? 'lfp' : 'ncm';
  chemSel.addEventListener('change', () => {
    const src = chemSel.value === 'lfp' ? LFP_280AH : NCM_50AH;
    store.patchProject((c) => {
      c.chem = { ...src, id: src.id + '-' + Date.now(), selfHeatTable: src.selfHeatTable.map((s) => ({ ...s })) };
    });
    refreshRenderer(); root.replaceWith(pageModule());
  });

  const chemGrid = h('div', { class: 'grid c4' });
  chemGrid.append(
    numField('单体质量', p.chem.mass, 0.01, (v) => store.patchProject((c) => { c.chem.mass = v; }), 'kg'),
    numField('比热容', p.chem.specificHeat, 10, (v) => store.patchProject((c) => { c.chem.specificHeat = v; }), 'J/kg·K'),
    numField('自产热起始 T1', k2c(p.chem.tOnset), 1, (v) => store.patchProject((c) => { c.chem.tOnset = c2k(v); }), '℃'),
    numField('热失控触发 T2', k2c(p.chem.tTrigger), 1, (v) => store.patchProject((c) => { c.chem.tTrigger = c2k(v); }), '℃'),
    numField('热失控放热量', p.chem.runawayEnergy, 500, (v) => store.patchProject((c) => { c.chem.runawayEnergy = v; }), 'J'),
    numField('喷发时长', p.chem.ventDuration, 1, (v) => store.patchProject((c) => { c.chem.ventDuration = v; }), 's'),
    numField('喷发气体量', p.chem.ventGasMol, 0.1, (v) => store.patchProject((c) => { c.chem.ventGasMol = v; }), 'mol'),
    numField('标称容量', p.chem.capacityAh, 10, (v) => store.patchProject((c) => { c.chem.capacityAh = v; }), 'Ah'),
  );

  // 自产热分段表
  const tableWrap = h('div', { class: 'scroll' });
  const renderTable = () => {
    tableWrap.innerHTML = '';
    const tbl = h('table');
    tbl.append(h('thead', {}, h('tr', {}, h('th', {}, '温度 ℃'), h('th', {}, '自产热功率 W'), h('th', {}, '操作'))));
    const tb = h('tbody');
    p.chem.selfHeatTable.forEach((row, i) => {
      const tInp = h('input', { type: 'number', value: k2c(row.t).toFixed(0) }) as HTMLInputElement;
      const qInp = h('input', { type: 'number', step: '0.1', value: String(row.power) }) as HTMLInputElement;
      tInp.addEventListener('change', () => store.patchProject((c) => { c.chem.selfHeatTable[i].t = c2k(Number(tInp.value)); }));
      qInp.addEventListener('change', () => store.patchProject((c) => { c.chem.selfHeatTable[i].power = Number(qInp.value); }));
      tb.append(h('tr', {},
        h('td', {}, tInp), h('td', {}, qInp),
        h('td', {}, h('button', {
          class: 'ghost small', onclick: () => store.patchProject((c) => { c.chem.selfHeatTable.splice(i, 1); renderTable(); }),
        }, '删除'))));
    });
    tbl.append(tb);
    tableWrap.append(tbl);
  };
  renderTable();

  // —— 模组结构 ——
  const m = p.materials;
  const matGrid = h('div', { class: 'grid c4' });
  const aerogelChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  aerogelChk.checked = m.aerogelEnabled;
  aerogelChk.addEventListener('change', () => {
    store.patchProject((c) => { c.materials.aerogelEnabled = aerogelChk.checked; });
    refreshRenderer();
  });
  matGrid.append(
    h('div', { class: 'field' }, h('label', {}, '气凝胶隔热垫'), aerogelChk),
    numField('隔热垫厚度', m.aerogel.thickness * 1000, 0.5, (v) => store.patchProject((c) => { c.materials.aerogel.thickness = v / 1000; }), 'mm'),
    numField('隔热垫导热系数', m.aerogel.conductivity, 0.001, (v) => store.patchProject((c) => { c.materials.aerogel.conductivity = v; }), 'W/m·K'),
    numField('电芯净间距', m.cellGap * 1000, 0.5, (v) => store.patchProject((c) => { c.materials.cellGap = v / 1000; }), 'mm'),
    numField('铝排厚度', m.busbar.thickness * 1000, 0.1, (v) => store.patchProject((c) => { c.materials.busbar.thickness = v / 1000; }), 'mm'),
    numField('铝排导热系数', m.busbar.conductivity, 1, (v) => store.patchProject((c) => { c.materials.busbar.conductivity = v; }), 'W/m·K'),
    numField('导热胶厚度', m.thermalGlue.thickness * 1000, 0.1, (v) => store.patchProject((c) => { c.materials.thermalGlue.thickness = v / 1000; }), 'mm'),
    numField('导热胶导热系数', m.thermalGlue.conductivity, 0.1, (v) => store.patchProject((c) => { c.materials.thermalGlue.conductivity = v; }), 'W/m·K'),
    numField('液冷板接触面积', m.coldPlateAreaPerCell * 1e4, 10, (v) => store.patchProject((c) => { c.materials.coldPlateAreaPerCell = v / 1e4; }), 'cm²'),
    numField('冷板导热系数', m.coldPlateConductivity, 1, (v) => store.patchProject((c) => { c.materials.coldPlateConductivity = v; }), 'W/m·K'),
    numField('模组外壳厚度', m.shellThickness * 1000, 0.1, (v) => store.patchProject((c) => { c.materials.shellThickness = v / 1000; }), 'mm'),
    numField('外壳导热系数', m.shellConductivity, 1, (v) => store.patchProject((c) => { c.materials.shellConductivity = v; }), 'W/m·K'),
  );

  // 模组排布
  const layoutGrid = h('div', { class: 'grid c4' });
  layoutGrid.append(
    numField('串联电芯数 X', p.layout.cellsSeriesX, 1, (v) => {
      store.patchProject((c) => { c.layout.cellsSeriesX = v; }); refreshRenderer();
    }, '颗'),
    numField('并联电芯数 Y', p.layout.cellsParallelY, 1, (v) => {
      store.patchProject((c) => { c.layout.cellsParallelY = v; }); refreshRenderer();
    }, '颗'),
    numField('模组长', p.layout.moduleDims[0], 0.01, (v) => store.patchProject((c) => { c.layout.moduleDims[0] = v; }), 'm'),
    numField('模组宽', p.layout.moduleDims[1], 0.01, (v) => store.patchProject((c) => { c.layout.moduleDims[1] = v; }), 'm'),
    numField('模组高', p.layout.moduleDims[2], 0.01, (v) => store.patchProject((c) => { c.layout.moduleDims[2] = v; }), 'm'),
  );

  // —— 逐芯异常注入（测试数据：故意填错数量级）——
  const ovWrap = h('div');
  const renderOverrides = () => {
    ovWrap.innerHTML = '';
    const keys = Object.keys(p.overrides);
    if (!keys.length) { ovWrap.append(h('div', { class: 'muted small' }, '暂无逐芯覆盖值')); return; }
    const tbl = h('table');
    tbl.append(h('thead', {}, h('tr', {}, h('th', {}, '电芯#'), h('th', {}, '导热倍率'), h('th', {}, '质量倍率'), h('th', {}, '比热倍率'), h('th', {}, '操作'))));
    const tb = h('tbody');
    for (const k of keys) {
      const ov = p.overrides[Number(k)];
      tb.append(h('tr', {},
        h('td', {}, k),
        h('td', { class: (ov.conductivityScale && (ov.conductivityScale < 0.05 || ov.conductivityScale > 50)) ? 'err-text' : '' }, String(ov.conductivityScale ?? '-')),
        h('td', {}, String(ov.massScale ?? '-')),
        h('td', {}, String(ov.specificHeatScale ?? '-')),
        h('td', {}, h('button', {
          class: 'ghost small', onclick: () => store.patchProject((c) => { delete c.overrides[Number(k)]; renderOverrides(); }),
        }, '删除'))));
    }
    tbl.append(tb);
    ovWrap.append(tbl);
  };
  renderOverrides();

  const addOv = (preset?: number) => {
    const idxInp = h('input', { type: 'number', placeholder: '电芯全局索引', min: '0', max: String(store.topo.cellCount - 1) }) as HTMLInputElement;
    const kInp = h('input', { type: 'number', step: '0.001', placeholder: '导热系数倍率', value: preset ? String(preset) : '' }) as HTMLInputElement;
    const row = h('div', { class: 'row', style: 'margin-top:8px' }, idxInp, kInp, h('button', {
      onclick: () => {
        const idx = Number(idxInp.value);
        if (!Number.isInteger(idx) || idx < 0 || idx >= store.topo.cellCount) { toast('电芯索引越界'); return; }
        store.patchProject((c) => {
          c.overrides[idx] = { ...c.overrides[idx], conductivityScale: Number(kInp.value) };
        });
        renderOverrides();
      },
    }, '添加'));
    ovWrap.append(row);
  };

  root.append(
    h('h2', {}, '电芯模组参数'),
    h('h3', {}, '化学体系'),
    h('div', { class: 'field', style: 'max-width:280px' }, h('label', {}, '电芯类型'), chemSel),
    chemGrid,
    h('h3', {}, '自产热分段表（温度→功率，分段线性插值，计算着色器同表）'),
    tableWrap,
    h('button', {
      class: 'ghost small', style: 'margin:6px 0', onclick: () => {
        store.patchProject((c) => { c.chem.selfHeatTable.push({ t: c.chem.tTrigger, power: 100 }); });
        renderTable();
      },
    }, '＋ 增加分段'),
    h('h3', {}, '模组结构材料（热阻按 R=Σδ/λ 分层串联 + 铝排并联路径）'),
    matGrid,
    h('h3', {}, '模组排布'),
    layoutGrid,
    h('h3', {}, '逐芯参数覆盖（模拟录入错误：数量级填错会在校验中被点名）'),
    ovWrap,
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'ghost', onclick: () => addOv() }, '＋ 添加覆盖值'),
      h('button', { class: 'danger', onclick: () => addOv(0.001) }, '注入测试错误：导热 ×0.001（小 3 个数量级）'),
      h('button', { class: 'danger', onclick: () => addOv(200) }, '注入测试错误：导热 ×200（大 2 个数量级）')),
  );
  return root;
}
