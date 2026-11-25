import type { DetectorAlarm, PropagationEvent, Scheme } from '../types';

interface ZoneState {
  id: string;
  volumeM3: number;
  gasPct: number;
  smokeDensity: number;
  tempC: number;
  gasAlarmAt: number | null;
  smokeAlarmAt: number | null;
  tempAlarmAt: number | null;
  peakGas: number;
  peakSmoke: number;
  peakTemp: number;
  peakRiseCPerMin: number;
}

function zoneVolume(scheme: Scheme, zoneId: string): number {
  const c = scheme.cabin.container;
  const total = c.length * c.width * c.height * 0.72;
  if (zoneId.includes('1') || zoneId.includes('2')) return total / Math.max(2, scheme.cabin.clusterCount);
  return total;
}

/**
 * Two-zone-style ceiling/gas partition estimate. It is not a CFD solve:
 * each cluster zone receives finite-duration vent gas/smoke/heat sources and
 * exchanges with neighbouring zones and exhaust. Detector thresholds then
 * give engineering alarm-time estimates for review scenarios.
 */
export function estimateDetectorAlarms(scheme: Scheme, events: PropagationEvent[]): DetectorAlarm[] {
  const durationS = Math.max(600, ...events.map((e) => e.timeS + 180));
  const dt = 2;
  const spec = scheme.cellSpecs.find((s) => s.id === scheme.defaultSpecId) ?? scheme.cellSpecs[0];
  const eruption = spec?.eruptionDurationS ?? 45;
  const gasPerCell = spec?.ventGasM3 ?? 0.25;
  const heatPerCell = spec?.runawayHeatJ ?? 5e6;
  const convectiveFraction = 1 - (spec?.retainedFraction ?? 0.45);

  const zoneIds = new Set<string>();
  for (const d of scheme.cabin.detectors) zoneIds.add(d.zoneId ?? `zone-cluster-1`);
  for (let i = 1; i <= scheme.cabin.clusterCount; i++) zoneIds.add(`zone-cluster-${i}`);
  const zones = new Map<string, ZoneState>();
  for (const id of zoneIds) {
    zones.set(id, {
      id,
      volumeM3: zoneVolume(scheme, id),
      gasPct: 0,
      smokeDensity: 0,
      tempC: 35,
      gasAlarmAt: null,
      smokeAlarmAt: null,
      tempAlarmAt: null,
      peakGas: 0,
      peakSmoke: 0,
      peakTemp: 35,
      peakRiseCPerMin: 0,
    });
  }

  const active = new Set<string>();
  const sorted = [...events].sort((a, b) => a.timeS - b.timeS);
  const eventByCell = new Map(sorted.map((e) => [e.cellId, e]));
  let eventCursor = 0;
  const exhaustAch = 12; // 1/h emergency ventilation/exhaust leakage
  const exchangePerS = 0.018;
  const rhoAir = 1.15;
  const cpAir = 1005;

  for (let t = 0; t <= durationS; t += dt) {
    while (eventCursor < sorted.length && sorted[eventCursor].timeS <= t) {
      active.add(sorted[eventCursor].cellId);
      eventCursor++;
    }
    // Events automatically leave the active release window.
    for (const id of [...active]) {
      const ev = eventByCell.get(id);
      if (ev && t > ev.timeS + eruption) active.delete(id);
    }

    const sourceByZone = new Map<string, { gasM3s: number; smoke: number; heatW: number }>();
    for (const cellId of active) {
      const ev = eventByCell.get(cellId);
      if (!ev) continue;
      const zid = `zone-cluster-${ev.clusterIndex + 1}`;
      const cur = sourceByZone.get(zid) ?? { gasM3s: 0, smoke: 0, heatW: 0 };
      cur.gasM3s += gasPerCell / eruption;
      // Approx smoke area yield: 2.0 m² per MJ of vented heat.
      cur.smoke += (heatPerCell * convectiveFraction / 1e6) * 2 / eruption;
      cur.heatW += heatPerCell * convectiveFraction * 0.72 / eruption;
      sourceByZone.set(zid, cur);
    }

    const updates = new Map<string, Partial<ZoneState>>();
    for (const z of zones.values()) {
      const src = sourceByZone.get(z.id) ?? { gasM3s: 0, smoke: 0, heatW: 0 };
      const gasSourcePctPerS = src.gasM3s / z.volumeM3 * 100;
      const smokeSourcePerS = src.smoke / z.volumeM3;
      const heatRateCPerS = src.heatW / (rhoAir * cpAir * z.volumeM3);
      const gasLoss = (exhaustAch / 3600 + 0.004) * z.gasPct;
      const smokeLoss = (exhaustAch / 3600 + 0.006) * z.smokeDensity;
      const tempLoss = (exhaustAch / 3600 + 0.002) * (z.tempC - 35);

      let neighborTermGas = 0;
      let neighborTermSmoke = 0;
      let neighborTermTemp = 0;
      const idx = Number(z.id.split('-').pop());
      for (const delta of [-1, 1]) {
        const nz = zones.get(`zone-cluster-${idx + delta}`);
        if (nz) {
          neighborTermGas += exchangePerS * (nz.gasPct - z.gasPct);
          neighborTermSmoke += exchangePerS * (nz.smokeDensity - z.smokeDensity);
          neighborTermTemp += exchangePerS * (nz.tempC - z.tempC);
        }
      }

      const prevTemp = z.tempC;
      z.gasPct = Math.max(0, z.gasPct + dt * (gasSourcePctPerS - gasLoss + neighborTermGas));
      z.smokeDensity = Math.max(0, z.smokeDensity + dt * (smokeSourcePerS - smokeLoss + neighborTermSmoke));
      z.tempC = Math.max(20, z.tempC + dt * (heatRateCPerS - tempLoss + neighborTermTemp));
      const rise = (z.tempC - prevTemp) / dt * 60;
      z.peakRiseCPerMin = Math.max(z.peakRiseCPerMin, rise);
      z.peakGas = Math.max(z.peakGas, z.gasPct);
      z.peakSmoke = Math.max(z.peakSmoke, z.smokeDensity);
      z.peakTemp = Math.max(z.peakTemp, z.tempC);

      if (z.gasAlarmAt === null && z.gasPct >= 0.8) z.gasAlarmAt = t;
      if (z.smokeAlarmAt === null && z.smokeDensity >= 0.12) z.smokeAlarmAt = t;
      if (z.tempAlarmAt === null && (z.tempC >= 57 || rise >= 8)) z.tempAlarmAt = t;
      updates.set(z.id, {});
    }
    void updates;
  }

  return scheme.cabin.detectors.map((d) => {
    const z = zones.get(d.zoneId ?? `zone-cluster-1`) ?? [...zones.values()][0];
    const distanceDelay = Math.hypot(d.position.x - (d.zoneId?.includes('2') ? 2.7 : -2.7), d.position.z) / 2.2;
    let alarm: number | null = null;
    let peak = 0;
    if (d.kind === 'gas') {
      alarm = z?.gasAlarmAt ?? null;
      peak = z?.peakGas ?? 0;
    } else if (d.kind === 'smoke') {
      alarm = z?.smokeAlarmAt ?? null;
      peak = z?.peakSmoke ?? 0;
    } else {
      alarm = z?.tempAlarmAt ?? null;
      peak = Math.max(z?.peakTemp ?? 35, z?.peakRiseCPerMin ?? 0);
    }
    if (alarm !== null) alarm = Math.round((alarm + distanceDelay) * 10) / 10;
    return {
      detectorId: d.id,
      name: d.name,
      kind: d.kind,
      timeS: alarm,
      peakValue: Math.round(peak * 1000) / 1000,
      threshold: d.alarmThreshold,
      zoneId: d.zoneId ?? '',
    };
  });
}
