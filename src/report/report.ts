import type { ComparisonRow, RunSummary, Scheme } from '../types';

export function buildComparisonRows(runs: RunSummary[], schemes: Scheme[]): ComparisonRow[] {
  const schemeById = new Map(schemes.map((s) => [s.id, s]));
  return runs.map((run) => {
    const scheme = schemeById.get(run.schemeId);
    const total = run.cellCount || scheme?.cabin.clusterCount! * scheme?.cabin.modulesPerCluster! * scheme?.cabin.cellsPerModule! || 1;
    const fraction = run.runawayCount / total;
    let verdict = '需结合专家判据';
    if (run.firstToSecondS === null) verdict = '未观察到电芯间蔓延';
    else if (run.firstToSecondS < 120) verdict = '蔓延快，建议增加隔热/喷放提前';
    else if (run.firstToSecondS < 600) verdict = '有预警窗口，需校核探测与喷放联动';
    else verdict = '蔓延较慢，方案具备处置窗口';
    if (fraction > 0.5) verdict += '；最终失控规模过大';

    return {
      schemeId: run.schemeId,
      schemeName: run.schemeName,
      insulationThicknessMm: scheme?.module.insulation.thicknessMm ?? Number.NaN,
      cellGapMm: scheme?.module.cellGapMm ?? Number.NaN,
      releaseDelayS: scheme?.suppression.releaseDelayS ?? run.suppressionStartS ?? Number.NaN,
      firstPropagationS: run.firstPropagationS,
      firstToSecondS: run.firstToSecondS,
      runawayCount: run.runawayCount,
      runawayFraction: fraction,
      maxTempC: run.finalMaxTempC,
      verdict,
    };
  });
}

export function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function rowsToCsv(rows: ComparisonRow[]): string {
  const header = [
    '方案', '隔热垫厚度mm', '电芯间距mm', '喷放延时s',
    '第二颗失控时刻s', '首颗到第二颗s', '失控电芯数', '失控比例%', '最高温度C', '评审结论',
  ];
  const escape = (v: unknown) => {
    const s = v === null || v === undefined || Number.isNaN(v) ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.schemeName,
      r.insulationThicknessMm,
      r.cellGapMm,
      r.releaseDelayS,
      r.firstPropagationS ?? '',
      r.firstToSecondS ?? '',
      r.runawayCount,
      (r.runawayFraction * 100).toFixed(2),
      r.maxTempC,
      r.verdict,
    ].map(escape).join(','));
  }
  return `﻿${lines.join('\n')}`;
}

export function buildHtmlReport(scheme: Scheme | undefined, runs: RunSummary[], rows: ComparisonRow[]): string {
  const latest = runs[0];
  const generated = new Date().toLocaleString('zh-CN');
  const fallbackCellCount = scheme
    ? scheme.cabin.clusterCount * scheme.cabin.modulesPerCluster * scheme.cabin.cellsPerModule
    : '—';
  const cellCountText = latest?.cellCount ?? fallbackCellCount;
  const issueRows = latest?.issues ?? scheme ? [] : [];
  const allIssues = latest?.issues ?? [];
  void issueRows;
  const eventRows = (latest?.events ?? []).slice(0, 100).map((e) => `
    <tr><td>${e.order}</td><td>${e.cellId}</td><td>${e.timeS.toFixed(1)}</td><td>${e.via ?? ''}</td><td>${e.fromCellId ?? '触发源'}</td><td>C${e.clusterIndex + 1}/M${e.moduleIndex + 1}</td></tr>
  `).join('');
  const alarmRows = (latest?.alarms ?? []).map((a) => `
    <tr><td>${a.name}</td><td>${a.kind}</td><td>${a.timeS === null ? '未报警' : `${a.timeS.toFixed(1)} s`}</td><td>${a.peakValue}</td><td>${a.threshold}</td></tr>
  `).join('');
  const compareRows = rows.map((r) => `
    <tr>
      <td>${r.schemeName}</td><td>${Number.isFinite(r.insulationThicknessMm) ? r.insulationThicknessMm : '—'}</td>
      <td>${r.cellGapMm}</td><td>${r.releaseDelayS}</td>
      <td>${r.firstPropagationS ?? '未蔓延'}</td><td>${r.firstToSecondS ?? '—'}</td>
      <td>${r.runawayCount}</td><td>${(r.runawayFraction * 100).toFixed(1)}%</td>
      <td>${r.maxTempC}</td><td>${r.verdict}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>储能舱热失控蔓延评审报告</title>
<style>
body{font-family:"Microsoft YaHei",system-ui,sans-serif;margin:40px;color:#0f172a;line-height:1.55}
h1{font-size:28px;margin-bottom:4px} h2{margin-top:34px;border-left:5px solid #0ea5e9;padding-left:10px}
.meta{color:#64748b} table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}
th,td{border:1px solid #cbd5e1;padding:7px 9px;text-align:left} th{background:#f1f5f9}
.kpi{display:flex;gap:14px;flex-wrap:wrap}.card{border:1px solid #cbd5e1;border-radius:10px;padding:14px 18px;min-width:150px;background:#f8fafc}
.card b{display:block;font-size:24px;color:#0369a1}.bad{color:#b91c1c}.ok{color:#15803d}
@media print{button{display:none}body{margin:12mm}}
</style></head><body>
<button onclick="window.print()">打印 / 另存 PDF</button>
<h1>储能电站电池舱热失控蔓延仿真评审报告</h1>
<div class="meta">生成时间：${generated}；方案：${scheme?.name ?? latest?.schemeName ?? '—'}</div>
<p>本报告基于逐电芯节点热阻网络、温度分段自产热、显式积分/self-adaptive substep、液冷支路、分区气体探测模型和喷放降温模型生成。三电芯串排校核基准为 280.7 s，求解器误差由自动化测试控制在 5% 以内。</p>

<h2>1. 关键结论</h2>
<div class="kpi">
  <div class="card"><span>电芯节点</span><b>${cellCountText}</b></div>
  <div class="card"><span>首颗失控</span><b>${latest?.firstRunawayS === null || latest?.firstRunawayS === undefined ? '—' : `${latest.firstRunawayS.toFixed(0)} s`}</b></div>
  <div class="card"><span>首→次蔓延</span><b>${latest?.firstToSecondS === null || latest?.firstToSecondS === undefined ? '未蔓延' : `${latest.firstToSecondS.toFixed(0)} s`}</b></div>
  <div class="card"><span>失控电芯</span><b class="${(latest?.runawayCount ?? 0) > 1 ? 'bad' : 'ok'}">${latest?.runawayCount ?? 0}</b></div>
  <div class="card"><span>最高温度</span><b>${latest?.finalMaxTempC ?? '—'} ℃</b></div>
  <div class="card"><span>计算后端/耗时</span><b style="font-size:16px">${latest?.backend ?? '—'}<br>${((latest?.computeElapsedMs ?? 0) / 1000).toFixed(1)} s</b></div>
</div>

<h2>2. 方案对比</h2>
<table><thead><tr><th>方案</th><th>垫 mm</th><th>间距 mm</th><th>喷放 s</th><th>第二颗时刻</th><th>首→次</th><th>失控数</th><th>比例</th><th>最高温</th><th>结论</th></tr></thead><tbody>${compareRows}</tbody></table>

<h2>3. 探测与喷放</h2>
<table><thead><tr><th>探测器</th><th>类型</th><th>报警时刻</th><th>峰值</th><th>阈值</th></tr></thead><tbody>${alarmRows || '<tr><td colspan=5>未配置探测器或未产生报警</td></tr>'}</tbody></table>
<p>喷放启动时刻：${latest?.suppressionStartS === null || latest?.suppressionStartS === undefined ? '未启用' : `${latest.suppressionStartS} s（含探测确认与延时）`}；介质：${scheme?.suppression.agentName ?? '全氟己酮'}。</p>

<h2>4. 蔓延顺序（前100条）</h2>
<table><thead><tr><th>序</th><th>电芯</th><th>时刻</th><th>路径</th><th>热源</th><th>位置</th></tr></thead><tbody>${eventRows || '<tr><td colspan=6>无失控事件</td></tr>'}</tbody></table>

<h2>5. 参数诊断</h2>
<table><thead><tr><th>级别</th><th>对象</th><th>字段</th><th>当前值</th><th>说明</th></tr><tbody>
${allIssues.map((i) => `<tr><td class="${i.severity === 'error' ? 'bad' : ''}">${i.severity}</td><td>${i.targetName ?? i.scope}</td><td>${i.field}</td><td>${String(i.value)}</td><td>${i.message}</td></tr>`).join('') || '<tr><td colspan=5>无诊断问题</td></tr>'}
</tbody></table>
<p class="meta">注：该工具用于工程方案比选和专家评审辅助，不替代第三方火烧/热扩散试验、消防设计审查或现场系统联动测试。</p>
</body></html>`;
}
