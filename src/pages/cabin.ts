// 页面 1：舱体布置
import { store } from '../store/appStore';
import { h, numField, toast } from '../ui/dom';
import { idb } from '../store/idb';
import { defaultProject } from '../model/defaults';
import { k2c } from '../model/defaults';
import { refreshRenderer } from '../view3d';
import { hasError } from '../model/validation';

export function pageCabin(): HTMLElement {
  const p = store.project;
  const root = h('div');

  const issuePanel = h('div');
  const renderIssues = () => {
    issuePanel.innerHTML = '';
    if (store.issues.length === 0) {
      issuePanel.append(h('div', { class: 'issue warning' }, '✓ 未发现参数问题'));
      return;
    }
    for (const is of store.issues) {
      issuePanel.append(h('div', { class: `issue ${is.level}` },
        `${is.level === 'error' ? '⛔' : '⚠'} ${is.message}${is.cellIndex !== undefined ? `（电芯 #${is.cellIndex}）` : ''}`));
    }
  };
  renderIssues();

  const form = h('div', { class: 'grid c4' });
  const containerSel = h('select') as HTMLSelectElement;
  containerSel.append(new Option('20 尺集装箱 (6.06m)', '20ft'), new Option('40 尺集装箱 (12.19m)', '40ft'));
  containerSel.value = p.cabin.container;
  containerSel.addEventListener('change', () => {
    const fresh = defaultProject(containerSel.value as '20ft' | '40ft');
    fresh.id = p.id; fresh.name = p.name; fresh.createdAt = p.createdAt;
    store.setProject(fresh);
    refreshRenderer();
    root.replaceWith(pageCabin());
  });
  const cf = h('div', { class: 'field' }, h('label', {}, '集装箱规格'), containerSel);
  form.append(cf);

  form.append(numField('电池簇数量', p.cabin.rackCount, 1, (v) => {
    store.patchProject((c) => { c.cabin.rackCount = v; c.detectors = c.detectors.filter((d) => d.zone < v); });
    refreshRenderer(); root.replaceWith(pageCabin());
  }, '簇'));
  form.append(numField('每簇模组数', p.cabin.modulesPerRack, 1, (v) => {
    store.patchProject((c) => { c.cabin.modulesPerRack = v; c.layout.modulesPerRack = v; });
    refreshRenderer(); root.replaceWith(pageCabin());
  }, '个'));
  form.append(numField('舱内初始温度', k2c(p.cabin.ambientTemp), 1, (v) => {
    store.patchProject((c) => { c.cabin.ambientTemp = v + 273.15; }); refreshRenderer();
  }, '℃'));
  form.append(numField('舱壁对流系数', p.cabin.ambientH, 0.5, (v) => {
    store.patchProject((c) => { c.cabin.ambientH = v; });
  }, 'W/m²K'));
  form.append(numField('舱长', p.cabin.dims[0], 0.1, (v) => {
    store.patchProject((c) => { c.cabin.dims[0] = v; }); refreshRenderer();
  }, 'm'));
  form.append(numField('舱宽', p.cabin.dims[1], 0.1, (v) => {
    store.patchProject((c) => { c.cabin.dims[1] = v; }); refreshRenderer();
  }, 'm'));
  form.append(numField('舱高', p.cabin.dims[2], 0.1, (v) => {
    store.patchProject((c) => { c.cabin.dims[2] = v; }); refreshRenderer();
  }, 'm'));

  // 高压箱位置
  const hv = h('div', { class: 'grid c3' });
  (['X', 'Y', 'Z'] as const).forEach((ax, i) => {
    hv.append(numField(`高压箱位置 ${ax}`, p.cabin.hvBoxPos[i], 0.1, (v) => {
      store.patchProject((c) => { c.cabin.hvBoxPos[i] = v; }); refreshRenderer();
    }, 'm'));
  });

  // 空调出风口
  const ventList = h('div');
  const renderVents = () => {
    ventList.innerHTML = '';
    p.cabin.acVents.forEach((v, i) => {
      const row = h('div', { class: 'row', style: 'margin-bottom:6px' });
      (['X', 'Y', 'Z'] as const).forEach((ax, k) => {
        const inp = h('input', { type: 'number', step: '0.1', value: v[k].toFixed(2), style: 'width:90px' }) as HTMLInputElement;
        inp.addEventListener('change', () => {
          store.patchProject((c) => { c.cabin.acVents[i][k] = Number(inp.value); }); refreshRenderer();
        });
        row.append(h('span', { class: 'muted small' }, ax), inp);
      });
      row.append(h('button', {
        class: 'ghost small', onclick: () => {
          store.patchProject((c) => { c.cabin.acVents.splice(i, 1); }); refreshRenderer(); renderVents();
        },
      }, '删除'));
      ventList.append(row);
    });
  };
  renderVents();

  // 方案存取
  const saveBtn = h('button', {}, '保存方案到 IndexedDB');
  saveBtn.addEventListener('click', async () => {
    if (hasError(store.issues)) { toast('存在参数错误，请先修正后再保存'); return; }
    await idb.saveProject(store.project);
    toast('方案已保存');
  });
  const loadBtn = h('button', { class: 'ghost' }, '读取已存方案…');
  loadBtn.addEventListener('click', async () => {
    const list = await idb.listProjects();
    if (!list.length) { toast('没有已保存方案'); return; }
    const dlg = h('div', { class: 'dialog-back' });
    const box = h('div', { class: 'dialog' }, h('h2', {}, '选择方案'));
    for (const proj of list) {
      box.append(h('div', {
        class: 'row', style: 'justify-content:space-between;padding:8px;border-bottom:1px solid var(--line)',
        onclick: async () => {
          const full = await idb.loadProject(proj.id);
          if (full) { store.setProject(full); refreshRenderer(); dlg.remove(); root.replaceWith(pageCabin()); toast('已加载'); }
        },
      }, h('span', {}, `${proj.name}（${new Date(proj.updatedAt).toLocaleString()}）`), h('span', { class: 'muted small' }, '点击加载')));
    }
    box.append(h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => dlg.remove() }, '关闭'));
    dlg.append(box); document.body.append(dlg);
  });

  root.append(
    h('h2', {}, '舱体布置', h('span', { class: 'muted small' },
      `当前规模：${store.topo.rackCount} 簇 × ${store.topo.modulesPerRack} 模组 × ${store.topo.cellsPerModule} 电芯 = ${store.topo.cellCount} 节点`)),
    form,
    h('h3', {}, '高压箱位置'), hv,
    h('h3', {}, '空调出风口（可多个）'), ventList,
    h('button', {
      class: 'ghost', style: 'margin:6px 0 14px', onclick: () => {
        store.patchProject((c) => { c.cabin.acVents.push([0.3, 2.3, 1.2]); }); refreshRenderer(); renderVents();
      },
    }, '＋ 增加出风口'),
    h('h3', {}, '参数校验（数量级/量纲检查，错误电芯直接点名）'), issuePanel,
    h('div', { class: 'row', style: 'margin-top:12px' }, saveBtn, loadBtn),
  );
  return root;
}
