// 探测器分区模型：按喷发气体量估算各探测器报警时刻；喷放延时联动
// 气体/烟感：同一分区内失控电芯喷发物累积（按 ventDuration 线性释放），浓度达阈值即报警
// 温感：取分区内最高电芯温度达阈值的时刻（从仿真快照扫描）
import type { DetectorAlarmEvent, DetectorSpec, ProjectConfig, RunawayEvent } from '../model/types';
import type { CoreResult } from './thermalCore';

/** 某分区在时刻 t 的累积喷发物（mol 或烟量纲），每颗失控电芯按喷发时长线性释放 */
function zoneEmissionAt(
  events: RunawayEvent[],
  zoneOfRack: (rack: number) => number,
  rackOfCell: (cell: number) => number,
  amount: (cell: number) => number,
  duration: (cell: number) => number,
  zone: number,
  t: number,
): number {
  let total = 0;
  for (const e of events) {
    if (zoneOfRack(e.rackId) !== zone) continue;
    const d = duration(e.cellIndex);
    const a = amount(e.cellIndex);
    if (t <= e.time) continue;
    total += a * Math.min((t - e.time) / d, 1);
  }
  return total;
}

export function computeAlarms(
  cfg: ProjectConfig,
  result: CoreResult,
  rackOfCell: (cell: number) => number,
): DetectorAlarmEvent[] {
  const alarms: DetectorAlarmEvent[] = [];
  const zoneOfRack = (rack: number) => rack; // 每簇一个分区，与 defaultDetectors 一致
  const zones = [...new Set(cfg.detectors.map((d) => d.zone))];

  const gasAmount = () => cfg.chem.ventGasMol;
  const smokeAmount = () => cfg.chem.ventSmoke;
  const dur = () => cfg.chem.ventDuration;

  // 在 0~endTime 上按 1s 粒度扫描（分区模型本身就是工程估算，1s 足够）
  const dt = 1;
  for (const det of cfg.detectors) {
    let alarmT = -1;
    let reading = 0;
    if (det.kind === 'gas' || det.kind === 'smoke') {
      const amount = det.kind === 'gas' ? gasAmount : smokeAmount;
      for (let t = 0; t <= result.endTime; t += dt) {
        const emitted = zoneEmissionAt(
          result.events, zoneOfRack, rackOfCell, amount, dur, det.zone, t,
        );
        const conc = emitted / cfg.suppression.zoneVolume;
        if (conc >= det.threshold) { alarmT = t; reading = conc; break; }
      }
    } else {
      // 温感：扫描快照中该分区最高温
      for (let f = 0; f < result.times.length; f++) {
        let tMax = 0;
        const frame = result.tempFrames[f];
        for (let c = 0; c < frame.length; c++) {
          if (zoneOfRack(rackOfCell(c)) === det.zone) tMax = Math.max(tMax, frame[c]);
        }
        if (tMax >= det.threshold) { alarmT = result.times[f]; reading = tMax; break; }
      }
    }
    if (alarmT >= 0) {
      alarms.push({ detectorId: det.id, kind: det.kind, time: alarmT, zone: det.zone, reading });
    }
  }
  return alarms.sort((a, b) => a.time - b.time);
}

/** 喷放时刻 = 最早报警 + 喷放延时；无报警则不喷放 */
export function computeDischargeTime(cfg: ProjectConfig, alarms: DetectorAlarmEvent[]): number {
  if (!cfg.suppression.enabled || alarms.length === 0) return -1;
  return alarms[0].time + cfg.suppression.dischargeDelay;
}
