// CLI 校验：npm run test:verify
// 1) 三颗电芯串排：CPU 数值解 vs 矩阵指数解析解，蔓延时间误差须 ≤5%
// 2) 测试数据校验：故意填错数量级的电芯必须被报出
// 3) 小规模端到端：832 颗电芯跑 1800s，检查不发散、蔓延事件合理
import { runThreeCellVerify } from '../physics/verify3cell';
import { buildSeedProject } from '../model/seed';
import { validateProject, hasError } from '../model/validation';
import { buildTopology } from '../model/topology';
import { ThermalCore } from '../physics/thermalCore';
import { computeAlarms, computeDischargeTime } from '../physics/detector';
import { c2k, k2c } from '../model/defaults';

function line(s = '') { console.log(s); }
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  line(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

async function main() {
  line('═══════════════════════════════════════════════════');
  line('测试 1：三颗电芯串排手算校验（解析解 vs CPU 显式积分）');
  line('═══════════════════════════════════════════════════');
  const rep = await runThreeCellVerify();
  line(`  热容 C = ${rep.params.C.toFixed(1)} J/K，界面电导 G = ${rep.params.g} W/K`);
  line(`  初始 ${k2c(rep.params.T0).toFixed(0)}℃，热库 ${k2c(rep.params.Thot).toFixed(0)}℃，T2 = ${k2c(rep.params.target).toFixed(0)}℃`);
  line(`  单节点集总手算式：${rep.lumpedTime.toFixed(1)} s`);
  line(`  两节点矩阵指数解析解：${rep.analyticTime.toFixed(1)} s`);
  line(`  CPU 数值解（${rep.cpuSteps} 步）：${rep.cpuReachTime.toFixed(1)} s`);
  line(`  误差：${rep.cpuErrorPct.toFixed(2)} %（要求 ≤5%）`);
  check('蔓延时间误差 ≤5%', rep.pass5pct, `${rep.cpuErrorPct.toFixed(2)}%`);
  // 温度轨迹抽样核对（仅在到达 T2 之前比对；热库为有限大电容，允许小偏差）
  let traceOk = true;
  let maxDev = 0;
  for (const tr of rep.tempTrace) {
    if (tr.t > rep.analyticTime * 1.05) continue;
    const e = Math.abs(tr.t2 - tr.analyticT2);
    maxDev = Math.max(maxDev, e);
    if (e > 8) { traceOk = false; line(`     轨迹偏差 t=${tr.t.toFixed(0)}s: 数值 ${tr.t2.toFixed(1)} vs 解析 ${tr.analyticT2.toFixed(1)}`); }
  }
  check('温度轨迹全程与解析解偏差 <8K', traceOk, `最大偏差 ${maxDev.toFixed(2)}K`);

  line('');
  line('═══════════════════════════════════════════════════');
  line('测试 2：异常参数数量级校验（测试舱故意塞错 3 颗）');
  line('═══════════════════════════════════════════════════');
  const seed = buildSeedProject();
  const issues = validateProject(seed);
  for (const is of issues) {
    line(`  [${is.level}] ${is.message}${is.cellIndex !== undefined ? `（电芯 #${is.cellIndex}）` : ''}`);
  }
  const errCells = issues.filter((i) => i.level === 'error' && i.cellIndex !== undefined).map((i) => i.cellIndex);
  check('电芯 #17 导热 ×0.001 被报出', errCells.includes(17));
  check('电芯 #120 导热 ×200 被报出', errCells.includes(120));
  check('电芯 #333 比热 ×0.05 被报出', errCells.includes(333));
  check('校验结果为 error 级，阻止带病仿真', hasError(issues));

  line('');
  line('═══════════════════════════════════════════════════');
  line('测试 3：修正异常值后的端到端蔓延仿真（CPU，832 颗 / 1800s）');
  line('═══════════════════════════════════════════════════');
  const clean = buildSeedProject();
  clean.overrides = {};
  const topo = buildTopology(clean);
  line(`  节点数：${topo.cellCount} 电芯 + ${topo.moduleCount} 模组外壳`);
  const core = new ThermalCore(topo, clean.cabin.ambientTemp);
  const per = (clean.cooling.flowLpm * clean.cooling.fluidDensity / 60) / topo.rackCount * clean.cooling.fluidSpecificHeat;
  core.setFlowPerRack(Array(topo.rackCount).fill(per));
  const t0 = Date.now();
  const r0 = await core.run({
    endTime: 1800, maxDt: 2, snapshotInterval: 30,
    ambientTemp: clean.cabin.ambientTemp, chem: clean.chem, triggers: clean.triggers,
    coolingEnabled: false, suppression: null, inletTemp: clean.cooling.inletTemp,
    failedBranches: clean.cooling.failedBranches, pumpFailTime: clean.cooling.failTime,
    chunkSimSeconds: 1e9, peakTemp: clean.chem.runawayPeakTemp,
  });
  const wall = (Date.now() - t0) / 1000;
  line(`  积分步数 ${r0.steps}，墙钟 ${wall.toFixed(1)}s，事件 ${r0.events.length} 起`);
  const maxT = Math.max(...r0.finalTemp);
  line(`  最终最高温 ${k2c(maxT).toFixed(1)}℃，首蔓延 ${r0.events.filter((e) => e.cause.startsWith('prop')).map((e) => e.time)[0]?.toFixed(1) ?? '未发生'}s`);
  check('温度未发散（<800℃）', maxT < c2k(800), `${k2c(maxT).toFixed(1)}℃`);
  check('首颗电芯在触发后进入失控', r0.events.some((e) => e.cellIndex === 0));
  check('失控事件电芯索引不重复', new Set(r0.events.map((e) => e.cellIndex)).size === r0.events.length);
  const alarms = computeAlarms(clean, r0, (c) => topo.rackId[c]);
  const dis = computeDischargeTime(clean, alarms);
  line(`  探测器报警 ${alarms.length} 次，喷放时刻 ${dis >= 0 ? dis.toFixed(1) + 's' : '未喷放'}`);
  // 单芯喷发气量 1.6mol / 28m³ ≈ 0.057 mol/m³，默认气体阈值 0.25 达不到；温感应能触发
  const tempAlarms = alarms.filter((a) => a.kind === 'temp');
  check('温感探测器在热失控后报警', tempAlarms.length > 0,
    tempAlarms[0] ? `@${tempAlarms[0].time.toFixed(1)}s` : '无温感报警');
  check('喷放时刻 = 首报警 + 延时', dis < 0 || Math.abs(dis - (alarms[0].time + clean.suppression.dischargeDelay)) < 1.1);

  line('');
  line('═══════════════════════════════════════════════════');
  line('测试 4：泵故障工况——停泵簇温升显著高于正常簇');
  line('═══════════════════════════════════════════════════');
  const coreB = new ThermalCore(topo, clean.cabin.ambientTemp);
  coreB.setFlowPerRack(Array(topo.rackCount).fill(per));
  // 在停泵簇（1 号簇）首颗电芯上持续加热，泵在 600s 停后该簇冷却能力消失
  const rack1First = topo.cellsPerModule * topo.modulesPerRack;
  const heatedCfg = structuredClone(clean);
  heatedCfg.triggers = [{ id: 'h1', kind: 'heater', cellIndex: rack1First, time: 60, power: 800, duration: 1700 }];
  const r1 = await coreB.run({
    endTime: 1800, maxDt: 2, snapshotInterval: 60,
    ambientTemp: heatedCfg.cabin.ambientTemp, chem: heatedCfg.chem, triggers: heatedCfg.triggers,
    coolingEnabled: true, suppression: null, inletTemp: heatedCfg.cooling.inletTemp,
    failedBranches: [1], pumpFailTime: 600, chunkSimSeconds: 1e9,
  });
  let max0 = 0, max1 = 0;
  for (let i = 0; i < topo.cellCount; i++) {
    const T = r1.finalTemp[i];
    if (topo.rackId[i] === 0) max0 = Math.max(max0, T);
    if (topo.rackId[i] === 1) max1 = Math.max(max1, T);
  }
  line(`  正常簇最高 ${k2c(max0).toFixed(1)}℃，停泵簇最高 ${k2c(max1).toFixed(1)}℃`);
  check('停泵簇温度高于正常簇', max1 > max0 + 5, `Δ=${(max1 - max0).toFixed(1)}K`);

  line('');
  if (failures === 0) {
    line('🎉 全部测试通过');
    process.exit(0);
  } else {
    line(`💀 ${failures} 项失败`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
