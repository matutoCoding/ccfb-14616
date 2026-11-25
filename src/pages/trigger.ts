import { store } from '../state/store';
import { buildLayout } from '../physics/geometry';
import type { TriggerType } from '../types';

const TYPE_LABEL: Record<TriggerType, string> = { overcharge: '过充', nail: '针刺', heater: '加热板' };

export function renderTriggerPage(root: HTMLElement) {
  const c = store.state.config;
  const layout = buildLayout(c);
  root.innerHTML = `
    <div class="page-grid">
      <section class="panel wide">
        <h2>触发场景(最多两处同时触发)</h2>
        <table class="data-table">
          <thead><tr><th>#</th><th>电芯全局序号</th><th>所在模组</th><th>类型</th><th>触发时刻 s</th><th></th></tr></thead>
          <tbody>
            ${c.triggers.map((t, i) => `
              <tr>
                <td>${i + 1}</td>
                <td><input type="number" min="0" max="${layout.cellCount - 1}" value="${t.cellGlobalIndex}" data-tr-idx="${i}" data-f="cell"></td>
                <td>#${layout.cellModule[t.cellGlobalIndex] ?? '-'}</td>
                <td><select data-tr-idx="${i}" data-f="type">
                  ${(Object.keys(TYPE_LABEL) as TriggerType[]).map((k) => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${TYPE_LABEL[k]}</option>`).join('')}
                </select></td>
                <td><input type="number" min="0" step="1" value="${t.time}" data-tr-idx="${i}" data-f="time"></td>
                <td><button class="btn small" data-del-tr="${i}">删除</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
        <button id="add-tr" class="btn" ${c.triggers.length >= 2 ? 'disabled' : ''}>+ 添加触发点</button>
        <div class="hint">在右侧模组图上点击任意电芯,自动填入下一个触发点序号。</div>
      </section>
      <section class="panel wide">
        <h2>模组电芯图(点击选电芯)</h2>
        <div class="module-picker" id="picker">${modulePicker(layout, c)}</div>
      </section>
    </div>`;

  root.querySelectorAll<HTMLElement>('[data-tr-idx]').forEach((el) => el.addEventListener('change', () => {
    const i = +(el as HTMLElement).dataset.trIdx!;
    const f = (el as HTMLElement).dataset.f!;
    store.update((cfg) => {
      const trig = cfg.triggers[i];
      if (f === 'cell') trig.cellGlobalIndex = Math.min(layout.cellCount - 1, Math.max(0, +(el as HTMLInputElement).value));
      else if (f === 'time') trig.time = Math.max(0, +(el as HTMLInputElement).value);
      else trig.type = (el as HTMLSelectElement).value as TriggerType;
    });
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-del-tr]').forEach((b) => b.addEventListener('click', () => {
    store.update((cfg) => { cfg.triggers.splice(+b.dataset.delTr!, 1); });
  }));
  root.querySelector('#add-tr')!.addEventListener('click', () => {
    store.update((cfg) => {
      if (cfg.triggers.length < 2) cfg.triggers.push({ cellGlobalIndex: 0, type: 'nail', time: cfg.triggers.length ? 600 : 0 });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => b.addEventListener('click', () => {
    const cellIdx = +b.dataset.pick!;
    store.update((cfg) => {
      if (cfg.triggers.length === 0) cfg.triggers.push({ cellGlobalIndex: cellIdx, type: 'nail', time: 0 });
      else if (cfg.triggers.length === 1) cfg.triggers[0].cellGlobalIndex = cellIdx;
      else cfg.triggers[1].cellGlobalIndex = cellIdx;
    });
  }));
}

function modulePicker(layout: ReturnType<typeof buildLayout>, c: { triggers: { cellGlobalIndex: number }[] }) {
  const trigSet = new Set(c.triggers.map((t) => t.cellGlobalIndex));
  const cpm = layout.cellCount / layout.moduleCount;
  // 从坐标反推第一模组的 x/z 网格规模
  const xs = new Set<number>(), zs = new Set<number>();
  for (let i = 0; i < cpm; i++) {
    xs.add(+layout.cellPositions[i * 3].toFixed(4));
    zs.add(+layout.cellPositions[i * 3 + 2].toFixed(4));
  }
  const nx = xs.size;
  let html = '';
  for (let m = 0; m < Math.min(layout.moduleCount, 4); m++) {
    html += `<div class="module-block"><h4>模组 #${m}</h4><div class="cell-grid" style="grid-template-columns:repeat(${nx},1fr)">`;
    for (let k = 0; k < cpm; k++) {
      const gi = m * cpm + k;
      html += `<button class="cell-btn ${trigSet.has(gi) ? 'picked' : ''}" data-pick="${gi}" title="电芯 #${gi}"></button>`;
    }
    html += '</div></div>';
  }
  return html + (layout.moduleCount > 4 ? `<div class="hint">仅显示前 4 个模组,共 ${layout.moduleCount} 个;其余序号可直接输入。</div>` : '');
}
