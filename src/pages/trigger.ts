// 页面 3：触发场景
import { store } from '../store/appStore';
import { h, numField, toast } from '../ui/dom';
import type { TriggerKind } from '../model/types';
import { uid } from '../model/defaults';

const KIND_LABEL: Record<TriggerKind, string> = {
  overcharge: '过充', nail: '针刺', heater: '加热板',
};
const KIND_POWER: Record<TriggerKind, number> = {
  overcharge: 350, nail: 600, heater: 250,
};

export function pageTrigger(): HTMLElement {
  const p = store.project;
  const root = h('div');

  const hint = h('div', { class: 'muted small', style: 'margin-bottom:10px' },
    '提示：可直接在上方 3D 视图中点选电芯，再点下方按钮快速创建触发点；支持两处同时触发。针刺/过充为瞬时型（持续时长填 0 即到点强制失控），加热板为持续加热型。');

  const list = h('div');
  const renderList = () => {
    list.innerHTML = '';
    if (!p.triggers.length) { list.append(h('div', { class: 'muted small' }, '尚未设置触发点')); return; }
    const tbl = h('table');
    tbl.append(h('thead', {}, h('tr', {},
      h('th', {}, '触发方式'), h('th', {}, '电芯#'), h('th', {}, '时刻 s'), h('th', {}, '功率 W'), h('th', {}, '持续 s'), h('th', {}, '操作'))));
    const tb = h('tbody');
    p.triggers.forEach((tr, i) => {
      tb.append(h('tr', {},
        h('td', {}, KIND_LABEL[tr.kind]),
        h('td', {}, String(tr.cellIndex)),
        h('td', {}, String(tr.time)),
        h('td', {}, String(tr.power)),
        h('td', {}, tr.duration === 0 ? '瞬时' : String(tr.duration)),
        h('td', {}, h('button', {
          class: 'ghost small', onclick: () => {
            store.patchProject((c) => { c.triggers.splice(i, 1); });
            renderList();
          },
        }, '删除'))));
    });
    tbl.append(tb);
    list.append(tbl);
  };
  renderList();

  const addTrigger = (kind: TriggerKind, cellIndex: number) => {
    if (p.triggers.length >= 2) { toast('最多支持两处同时触发'); return; }
    if (cellIndex < 0) { toast('请先在 3D 视图中点选一颗电芯'); return; }
    store.patchProject((c) => {
      c.triggers.push({
        id: uid('trg'), kind, cellIndex,
        time: c.triggers.length ? 120 : 30,
        power: KIND_POWER[kind],
        duration: kind === 'heater' ? 120 : 0,
      });
    });
    renderList();
  };

  const selectedInfo = h('span', { class: 'tag' }, store.selectedCell >= 0 ? `已选电芯 #${store.selectedCell}` : '未选择电芯');
  // 订阅选择变化
  const unsub = store.subscribe(() => { selectedInfo.textContent = store.selectedCell >= 0 ? `已选电芯 #${store.selectedCell}` : '未选择电芯'; });
  window.setTimeout(() => window.addEventListener('hashchange', unsub, { once: true }), 0);

  const btnRow = h('div', { class: 'row' },
    selectedInfo,
    ...(['overcharge', 'nail', 'heater'] as TriggerKind[]).map((k) =>
      h('button', { onclick: () => addTrigger(k, store.selectedCell) }, `在选中电芯上${KIND_LABEL[k]}`)),
  );

  // 手动精确添加
  const manual = h('div', { class: 'grid c4', style: 'margin-top:14px' });
  const mCell = h('input', { type: 'number', value: '0', min: '0', max: String(store.topo.cellCount - 1) }) as HTMLInputElement;
  const mTime = h('input', { type: 'number', value: '30' }) as HTMLInputElement;
  const mPower = h('input', { type: 'number', value: '250' }) as HTMLInputElement;
  const mDur = h('input', { type: 'number', value: '0' }) as HTMLInputElement;
  const mKind = h('select') as HTMLSelectElement;
  (Object.entries(KIND_LABEL) as [TriggerKind, string][]).forEach(([k, l]) => mKind.append(new Option(l, k)));
  manual.append(
    h('div', { class: 'field' }, h('label', {}, '方式'), mKind),
    h('div', { class: 'field' }, h('label', {}, '电芯索引'), mCell),
    h('div', { class: 'field' }, h('label', {}, '时刻 s'), mTime),
    h('div', { class: 'field' }, h('label', {}, '功率 W'), mPower),
    h('div', { class: 'field' }, h('label', {}, '持续 s（0=瞬时）'), mDur),
  );
  manual.append(h('button', {
    style: 'grid-column:1/-1', onclick: () => {
      const idx = Number(mCell.value);
      if (idx < 0 || idx >= store.topo.cellCount) { toast('电芯索引越界'); return; }
      addTrigger(mKind.value as TriggerKind, idx);
      store.patchProject((c) => {
        const tr = c.triggers[c.triggers.length - 1];
        tr.time = Number(mTime.value); tr.power = Number(mPower.value); tr.duration = Number(mDur.value);
      });
      renderList();
    },
  }, '＋ 精确添加触发点'));

  // 快速场景
  const quick = h('div', { class: 'row', style: 'margin-top:14px' },
    h('span', { class: 'muted' }, '快速场景：'),
    h('button', {
      class: 'ghost', onclick: () => {
        store.patchProject((c) => {
          c.triggers = [{ id: uid('trg'), kind: 'nail', cellIndex: 0, time: 30, power: 600, duration: 0 }];
        }); renderList(); toast('已设为首颗电芯针刺单点触发');
      },
    }, '单点针刺（首颗）'),
    h('button', {
      class: 'ghost', onclick: () => {
        const n = store.topo.cellsPerModule;
        store.patchProject((c) => {
          c.triggers = [
            { id: uid('trg'), kind: 'heater', cellIndex: 0, time: 30, power: 250, duration: 120 },
            { id: uid('trg'), kind: 'nail', cellIndex: n, time: 30, power: 600, duration: 0 },
          ];
        }); renderList(); toast('已设为相邻模组双点同时触发');
      },
    }, '双点同时触发（跨模组）'),
  );

  root.append(h('h2', {}, '触发场景'), hint, list, btnRow, h('h3', {}, '手动精确配置'), manual, quick);
  return root;
}
