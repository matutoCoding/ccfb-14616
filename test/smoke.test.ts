// 端到端冒烟:演示舱参数校验必须报出 3 颗异常电芯;CPU 求解器能跑出非发散结果
import { createDemoProject, createLargeProject, createThreeCellProject } from '../src/physics/demoData';
import { validateConfig, hasError } from '../src/physics/validation';
import { buildLayout, buildNetwork } from '../src/physics/geometry';
import { runCpuSim } from '../src/gpu/GpuSimEngine';

function main() {
  const demo = createDemoProject();
  const issues = validateConfig(demo);
  console.log('演示舱校验问题:');
  for (const i of issues) console.log(`  [${i.level}] ${i.message}`);
  const badCells = issues.filter((i) => i.cellIndex !== undefined).map((i) => i.cellIndex);
  for (const expect of [12, 300, 500]) {
    if (!badCells.includes(expect)) throw new Error(`异常电芯 #${expect} 未被校验器报出`);
  }
  console.log(`✅ 三颗异常电芯(12/300/500)全部被识别,共 ${issues.length} 条问题\n`);

  const three = createThreeCellProject();
  const layout3 = buildLayout(three);
  const net3 = buildNetwork(three, layout3);
  console.log(`三电芯算例: N=${layout3.cellCount}, dtCrit=${net3.dtCrit.toFixed(3)}s, gCellPairX=${net3.gCellPairX.toFixed(4)} W/K`);

  const large = createLargeProject();
  const largeLayout = buildLayout(large);
  console.log(`\n大规模舱: ${largeLayout.cellCount} 颗电芯, ${largeLayout.moduleCount} 模组, 停泵支路=${large.cooling.stoppedBranches.join(',')}`);
  if (largeLayout.cellCount !== 12000) throw new Error('大规模舱电芯数应为 12000');
  const largeIssues = validateConfig(large);
  console.log(`大规模舱校验: ${largeIssues.length} 条问题(含注入异常 #12)`);
  if (!largeIssues.some((i) => i.cellIndex === 12)) throw new Error('大规模舱异常 #12 未报出');

  console.log('\n运行三电芯 CPU 仿真(延长到 20000s 观察完整蔓延)...');
  three.simDuration = 20000;
  const t0 = performance.now();
  return runCpuSim(three).then((r) => {
    console.log(`  墙钟 ${(performance.now() - t0).toFixed(0)}ms, 失控 ${r.summary.trCount} 颗, 首蔓延 ${r.summary.firstPropagationTime?.toFixed(1)}s, 最高温 ${r.summary.maxT.toFixed(1)}K, 快照 ${r.snapshots.length} 帧`);
    if (r.summary.diverged) throw new Error('三电芯算例发散');
    if (r.summary.trCount < 1) throw new Error('触发电芯至少应失控 1 颗');
    if (!Number.isFinite(r.summary.maxT)) throw new Error('最高温异常');
    console.log('\n✅ 冒烟测试全部通过');
    void hasError;
  });
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
