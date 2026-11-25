import { store } from '../state/store';
import { buildLayout, CONTAINER_DIMS } from '../physics/geometry';
import type { ProjectConfig } from '../types';

export function renderLayoutPage(root: HTMLElement) {
  const s = store.state;
  const c = s.config;
  const layout = buildLayout(c);
  root.innerHTML = `
    <div class="page-grid">
      <section class="panel">
        <h2>舱体与簇布置</h2>
        <label>集装箱规格
          <select data-k="container">
            <option value="20ft" ${c.container === '20ft' ? 'selected' : ''}>20 尺</option>
            <option value="40ft" ${c.container === '40ft' ? 'selected' : ''}>40 尺</option>
          </select>
        </label>
        <label>电池簇数量 <input type="number" min="1" max="12" value="${c.clusterCount}" data-k="clusterCount"></label>
        <label>每簇模组数(竖直堆叠) <input type="number" min="1" max="16" value="${c.cluster.modulesPerCluster}" data-k="modulesPerCluster"></label>
        <label>模组 x 向电芯数 <input type="number" min="1" max="64" value="${c.cluster.moduleLayout.cellsX}" data-k="cellsX"></label>
        <label>模组 z 向电芯数 <input type="number" min="1" max="16" value="${c.cluster.moduleLayout.cellsZ}" data-k="cellsZ"></label>
        <div class="hint">改簇数/模组数后几何自动重排;总电芯 <b>${layout.cellCount}</b> 颗,模组 <b>${layout.moduleCount}</b> 个。</div>
        <h3>液冷</h3>
        <label>进液温度 ℃ <input type="number" step="0.5" value="${(c.cooling.inletTemp - 273.15).toFixed(1)}" data-k="inletC"></label>
        <label>单路流量 L/min <input type="number" step="1" value="${c.cooling.flowLpm}" data-k="flowLpm"></label>
        <label>停运支路(逗号分隔,从 0 起) <input value="${c.cooling.stoppedBranches.join(',')}" data-k="stopped"></label>
        <h3>空调</h3>
        <label>舱内送风温度 ℃ <input type="number" step="0.5" value="${(c.hvac.ambientT - 273.15).toFixed(1)}" data-k="ambientC"></label>
      </section>
      <section class="panel wide">
        <h2>俯视布置图(自动重排)</h2>
        ${topViewSvg(c, layout)}
        <div class="legend">
          <span><i style="background:#3a7bf2"></i>电池簇</span>
          <span><i style="background:#e0a030"></i>高压箱</span>
          <span><i style="background:#50c878"></i>空调</span>
          <span><i style="background:#7fd4ff"></i>液冷主管</span>
        </div>
        <pre class="spec">舱内净尺寸: ${CONTAINER_DIMS[c.container].x} × ${CONTAINER_DIMS[c.container].z} × ${CONTAINER_DIMS[c.container].y} m
模组外形: ${layout.moduleDims.sx.toFixed(3)} × ${layout.moduleDims.sz.toFixed(3)} × ${layout.moduleDims.sy.toFixed(3)} m</pre>
      </section>
    </div>`;

  root.querySelectorAll<HTMLInputElement>('[data-k]').forEach((el) => {
    el.addEventListener('change', () => {
      const k = el.dataset.k!;
      store.update((cfg) => {
        if (k === 'container') cfg.container = el.value as '20ft' | '40ft';
        else if (k === 'clusterCount') cfg.clusterCount = Math.max(1, +el.value || 1);
        else if (k === 'modulesPerCluster') cfg.cluster.modulesPerCluster = Math.max(1, +el.value || 1);
        else if (k === 'cellsX') cfg.cluster.moduleLayout.cellsX = Math.max(1, +el.value || 1);
        else if (k === 'cellsZ') cfg.cluster.moduleLayout.cellsZ = Math.max(1, +el.value || 1);
        else if (k === 'inletC') cfg.cooling.inletTemp = +el.value + 273.15;
        else if (k === 'flowLpm') cfg.cooling.flowLpm = Math.max(0.1, +el.value);
        else if (k === 'stopped') cfg.cooling.stoppedBranches = el.value.split(',').map((x) => +x.trim()).filter((x) => Number.isInteger(x) && x >= 0);
        else if (k === 'ambientC') cfg.hvac.ambientT = +el.value + 273.15;
      });
    });
  });
}

function topViewSvg(c: ProjectConfig, layout: ReturnType<typeof buildLayout>) {
  const room = layout.roomSize;
  const sc = 62;
  const rect = (e: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; name?: string; kind?: string }, color: string) =>
    `<rect x="${e.minX * sc}" y="${(room.z - e.maxZ) * sc}" width="${(e.maxX - e.minX) * sc}" height="${(e.maxZ - e.minZ) * sc}" fill="${color}" stroke="#0b1018" stroke-width="1"><title>${e.name ?? ''}</title></rect>`;
  const colors: Record<string, string> = { cabinet: '#3a7bf2', hvBox: '#e0a030', hvac: '#50c878', pipe: '#7fd4ff' };
  return `<svg viewBox="0 0 ${room.x * sc + 10} ${room.z * sc + 10}" class="topview">
    ${layout.equipment.map((e) => rect(e, colors[e.kind] ?? '#888')).join('')}
    ${layout.clusterPositions.map((p, i) => `<text x="${p.x * sc}" y="${(room.z - p.z) * sc - 4}" fill="#cfe0ff" font-size="13">簇${i + 1}${c.cooling.stoppedBranches.includes(i) ? '(停泵)' : ''}</text>`).join('')}
  </svg>`;
}
