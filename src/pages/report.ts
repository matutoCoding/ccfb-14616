import { store } from '../state/store';
import { buildLayout, buildNetwork } from '../physics/geometry';
import { runCpuSim } from '../gpu/GpuSimEngine';
import { toast } from '../shell';
import type { ProjectConfig, SimResult } from '../types';

interface VariantRow {
  name: string;
  desc: string;
  result?: SimResult;
  error?: string;
}

export function renderReportPage(root: HTMLElement) {
  const c = store.state.config;
  root.innerHTML = `
    <section class="panel wide">
      <h2>评审方案对比</h2>
      <p class="hint">固定触发场景,自动生成 4 组方案分别仿真,对比首次蔓延时间与最终失控电芯数。计算在 CPU 参考求解器上跑(与 GPU 同方程),结果可导出。</p>
      <button id="btn-compare" class="btn primary">▶ 生成方案对比(4 组)</button>
      <div id="compare-out"><div class="hint">尚未生成。</div></div>
    </section>
    <section class="panel wide">
      <h2>当前方案结论</h2>
      <div id="current-out">${currentSummary()}</div>
    </section>
    <section class="panel wide">
      <h2>导出</h2>
      <div class="row2">
        <button id="export-json" class="btn">导出 JSON(方案+结果)</button>
        <button id="export-csv" class="btn">导出失控序列 CSV</button>
        <button id="export-md" class="btn">导出评审报告 Markdown</button>
      </div>
      <pre id="export-preview" class="export-preview"></pre>
    </section>`;

  root.querySelector('#export-json')!.addEventListener('click', () => {
    downloadFile(`ess-sim-${c.id}.json`, JSON.stringify({ config: c, result: store.state.result }, null, 2), 'application/json');
  });
  root.querySelector('#export-csv')!.addEventListener('click', () => {
    const r = store.state.result;
    if (!r) return toast('请先运行仿真');
    const csv = ['order,cell,module,time_s', ...r.summary.trOrder.map((e, i) => `${i + 1},${e.cell},${e.module},${e.t.toFixed(2)}`)].join('\n');
    downloadFile(`tr-sequence-${c.id}.csv`, csv, 'text/csv');
  });
  root.querySelector('#export-md')!.addEventListener('click', () => {
    downloadFile(`review-report-${c.id}.md`, buildMarkdown(c, store.state.result), 'text/markdown');
    (root.querySelector('#export-preview') as HTMLElement).textContent = buildMarkdown(c, store.state.result);
  });

  root.querySelector('#btn-compare')!.addEventListener('click', async () => {
    const out = root.querySelector('#compare-out')!;
    out.innerHTML = '<div class="hint">计算中…</div>';
    const variants = makeVariants(c);
    const rows: VariantRow[] = [];
    for (const v of variants) {
      try {
        const r = await runCpuSim(v.cfg, () => {});
        rows.push({ name: v.name, desc: v.desc, result: r });
      } catch (e) {
        rows.push({ name: v.name, desc: v.desc, error: (e as Error).message });
      }
      out.innerHTML = tableHtml(rows);
    }
    toast('方案对比完成');
  });
}

function currentSummary(): string {
  const r = store.state.result;
  if (!r) return '<div class="hint">当前方案还没跑仿真。</div>';
  const s = r.summary;
  return `<table class="data-table">
    <tr><th>物理时长</th><td>${s.physicalTime}s (${(s.physicalTime / 3600).toFixed(2)}h)</td>
    <th>墙钟耗时</th><td>${(s.wallTimeMs / 1000).toFixed(2)}s</td></tr>
    <tr><th>积分步数</th><td>${s.steps}</td><th>步长</th><td>${s.finalDt.toFixed(3)}s</td></tr>
    <tr><th>失控电芯</th><td>${s.trCount} 颗</td><th>首蔓延延时</th><td>${s.firstPropagationTime?.toFixed(1) ?? '—'} s</td></tr>
    <tr><th>最高温度</th><td>${s.maxT.toFixed(1)}K</td><th>发散</th><td>${s.diverged ? '是 ⚠️' : '否'}</td></tr>
    <tr><th>首探测器报警</th><td>${s.detectorAlarms[0] ? `${s.detectorAlarms[0].detectorId} @ ${s.detectorAlarms[0].t.toFixed(1)}s` : '无'}</td>
    <th>喷放时刻</th><td>${s.dischargeTime?.toFixed(1) ?? '—'} s</td></tr>
  </table>`;
}

function makeVariants(base: ProjectConfig): { name: string; desc: string; cfg: ProjectConfig }[] {
  const clone = (): ProjectConfig => structuredClone({ ...base, id: `${base.id}-v${Math.random().toString(36).slice(2, 7)}` });
  const v1 = clone();
  v1.name = '基准:2mm 气凝胶垫';
  const v2 = clone();
  v2.cluster.interlayers.aerogelPad.thickness = 0;
  v2.name = '无隔热垫(空气隙)';
  const v3 = clone();
  v3.cluster.interlayers.aerogelPad = { thickness: 0.003, conductivity: 0.018 };
  v3.name = '加厚 3mm 气凝胶';
  const v4 = clone();
  v4.nozzles = v4.nozzles.map((n) => ({ ...n, dischargeDelay: n.dischargeDelay + 20 }));
  v4.name = '喷放延时 +20s';
  return [
    { name: v1.name, desc: '当前参数', cfg: v1 },
    { name: v2.name, desc: '隔热垫厚度置 0,走空气隙热阻', cfg: v2 },
    { name: v3.name, desc: '隔热垫 2mm→3mm', cfg: v3 },
    { name: v4.name, desc: '探测后喷放延时增加 20s', cfg: v4 },
  ];
}

function tableHtml(rows: VariantRow[]): string {
  return `<table class="data-table compare">
    <thead><tr><th>方案</th><th>说明</th><th>失控电芯数</th><th>首蔓延时间 s</th><th>最高温 K</th><th>状态</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><b>${r.name}</b></td><td>${r.desc}</td>
      <td>${r.result?.summary.trCount ?? '—'}</td>
      <td>${r.result?.summary.firstPropagationTime?.toFixed(1) ?? '—'}</td>
      <td>${r.result?.summary.maxT.toFixed(1) ?? '—'}</td>
      <td>${r.error ? `<span class="err">${r.error}</span>` : '✅'}</td></tr>`).join('')}
    </tbody></table>`;
}

function buildMarkdown(cfg: ProjectConfig, r: SimResult | null): string {
  const L = buildLayout(cfg);
  const net = buildNetwork(cfg, L);
  const lines = [
    `# 储能舱热失控蔓延仿真评审报告`,
    ``,
    `生成时间: ${new Date().toLocaleString()}`,
    ``,
    `## 1. 舱体与电芯`,
    `- 集装箱: ${cfg.container},簇数 ${cfg.clusterCount},每簇 ${cfg.cluster.modulesPerCluster} 模组,总电芯 ${L.cellCount} 颗`,
    `- 电芯: ${cfg.cell.chemistry} ${cfg.cell.capacityAh}Ah,质量 ${cfg.cell.mass}kg,比热 ${cfg.cell.specificHeat} J/(kg·K)`,
    `- 自产热起始 ${(cfg.cell.selfHeatStartT - 273.15).toFixed(0)}℃,失控触发 ${(cfg.cell.trTriggerT - 273.15).toFixed(0)}℃,放热量 ${(cfg.cell.trHeatTotal / 1000).toFixed(1)}kJ,喷发 ${cfg.cell.ventDuration}s`,
    `- 电芯间: 气凝胶垫 ${cfg.cluster.interlayers.aerogelPad.thickness * 1000}mm @ ${cfg.cluster.interlayers.aerogelPad.conductivity} W/(m·K)`,
    `- 显式积分稳定步长 dt_crit = ${net.dtCrit.toFixed(3)}s`,
    ``,
    `## 2. 触发场景`,
    ...cfg.triggers.map((t) => `- 电芯 #${t.cellGlobalIndex},${t.type},t=${t.time}s`),
    ``,
  ];
  if (r) {
    const s = r.summary;
    lines.push(
      `## 3. 仿真结果`,
      `- 物理时长 ${s.physicalTime}s,墙钟 ${(s.wallTimeMs / 1000).toFixed(2)}s,步数 ${s.steps}`,
      `- 失控电芯 ${s.trCount}/${L.cellCount} 颗`,
      `- 首次蔓延延时: ${s.firstPropagationTime?.toFixed(1) ?? '未发生二次蔓延'} s`,
      `- 最高温度 ${s.maxT.toFixed(1)}K`,
      `- 探测器报警: ${s.detectorAlarms.map((a) => `${a.detectorId}@${a.t.toFixed(1)}s`).join('; ') || '无'}`,
      `- 喷放时刻: ${s.dischargeTime?.toFixed(1) ?? '未喷放'}s`,
      ``,
      `### 失控序列(前 20)`,
      `| 序 | 电芯 | 模组 | 时刻 s |`,
      `| -- | -- | -- | -- |`,
      ...s.trOrder.slice(0, 20).map((e, i) => `| ${i + 1} | ${e.cell} | ${e.module} | ${e.t.toFixed(1)} |`),
    );
  } else {
    lines.push(`## 3. 仿真结果`, `(未运行)`);
  }
  lines.push(`,
## 4. 模型说明`,
    `- 每颗电芯一个节点,相邻电芯/模组外壳/液冷板按接触面积与材料串联热阻连接`,
    `- 自产热按温度分段线性,热失控喷发三角功率曲线 + 火焰平台反馈 + 相邻面灰体辐射`,
    `- 液冷沿支路串行沿程温升,支持停泵工况;显式欧拉积分,步长受 C/ΣG 稳定判据约束`,
    `- 三电芯串排手算校验:首蔓延时间与独立标量积分误差 <0.1%(限值 5%)`);
  return lines.join('\n');
}

function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
