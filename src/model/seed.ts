// 测试数据：两簇 40 尺舱 + 故意填错导热系数数量级的电芯
// 要求：校验器必须报出这些电芯，而不是让求解器“算出一舱炸”
import { defaultProject, uid, c2k } from './defaults';
import type { ProjectConfig } from './types';

export function buildSeedProject(): ProjectConfig {
  const cfg = defaultProject('40ft');
  cfg.name = '测试舱：40尺两簇（含异常参数）';
  // 规模：2 簇 × 8 模组 × 52 电芯 = 832 颗（功能测试规模，性能测试可手动调到 1.2 万）
  cfg.cabin.rackCount = 2;
  cfg.cabin.modulesPerRack = 8;
  cfg.layout.modulesPerRack = 8;
  cfg.layout.cellsSeriesX = 26;
  cfg.layout.cellsParallelY = 2;

  // 单点针刺触发：0 号模组首颗，30s 瞬时触发
  cfg.triggers = [{
    id: uid('trg'), kind: 'nail', cellIndex: 0, time: 30, power: 600, duration: 0,
  }];

  // —— 故意制造的录入错误 ——
  // 1) #17 电芯导热倍率 ×0.001：把正常接触面变成接近绝热，小了 3 个数量级
  cfg.overrides[17] = { conductivityScale: 0.001 };
  // 2) #120 电芯导热倍率 ×200：把隔热垫拉到金属量级，大了 2 个数量级
  cfg.overrides[120] = { conductivityScale: 200 };
  // 3) #333 比热倍率异常（质量/热容类错误）
  cfg.overrides[333] = { specificHeatScale: 0.05 };

  // 一路液冷泵故障工况：1 号簇在 600s 停泵
  cfg.cooling.failedBranches = [1];
  cfg.cooling.failTime = 600;

  // 喷放 10s 延时
  cfg.suppression.dischargeDelay = 10;
  cfg.suppression.zoneVolume = 28;

  // 进液 25℃，环境 25℃
  cfg.cooling.inletTemp = c2k(25);
  return cfg;
}

/** 大规模性能测试配置：约 1.2 万颗电芯（用于“两小时物理时间三分钟内跑完”验证） */
export function buildPerfProject(): ProjectConfig {
  const cfg = buildSeedProject();
  cfg.name = '性能舱：1.2万电芯';
  // 2 簇 × 12 模组 ×（48 串 × 52/48 取整）—— 直接给 50 串 × 2 并 = 100/模组
  cfg.cabin.rackCount = 2;
  cfg.cabin.modulesPerRack = 12;
  cfg.layout.modulesPerRack = 12;
  cfg.layout.cellsSeriesX = 50;
  cfg.layout.cellsParallelY = 2; // 2×12×100 = 2400/簇，共 4800；再翻倍簇数
  cfg.cabin.rackCount = 5;       // 5×12×100 = 6000
  cfg.cabin.rackCount = 10;      // 10 簇 × 12 × 100 = 12000
  cfg.cabin.dims[0] = 12.192;    // 40 尺舱内允许密集排布（几何上会自动紧凑）
  cfg.triggers = [{ id: uid('trg'), kind: 'nail', cellIndex: 0, time: 30, power: 600, duration: 0 }];
  // 性能测试移除异常值，避免校验拦截
  cfg.overrides = {};
  cfg.cooling.failedBranches = [];
  return cfg;
}
