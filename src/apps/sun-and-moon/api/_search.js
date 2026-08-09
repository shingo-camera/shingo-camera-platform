// ============================================================
// functions/api/_search.js
// 登録地点検索の共通探索コア。pinpoint / chance で重複していた
// 「日付走査・月/太陽位置・月齢/照度・日の出日没・方位差・上端/下端仰角・
//  時刻刻み・候補区間抽出・最良時刻選択・日時ソート」を集約する。
// 判定（方位閾値・候補採否・結果生成）は strategy 側へ分離し、
// 既存 pinpoint.js / chance.js の結果を不変に再現する。
// 天体計算は functions/api/_astro.js を再利用（コピーしない）。
// ============================================================
import { moonPos, sunPos, moonAge, makeSunT, brng, hav, elAng } from './_astro.js';

const _sunT = makeSunT();

// input: { sLat, sLng, sElev, t, dateStr, dayOffset, dayCount, bodyModes, step }
// strategy: { azThr(distM)->deg, buildResult(found, ds, isSun, ctx)->obj|null }
//   buildResult が null を返した候補は不採用（pinpoint の移動量フィルタ等）。
// 戻り値: { results, tAz, topAlt, baseAlt, AZ_THR, targetAngDiam }
export function searchCore(input, strategy){
  const { sLat, sLng, sElev, t, dateStr, dayOffset, dayCount, bodyModes, step } = input;

  const tAz   = brng(sLat, sLng, t.lat, t.lng);
  const distH = hav(sLat, sLng, t.lat, t.lng);
  const distM = distH * 1000;
  const topAlt  = elAng(distH, sElev, t.elev, t.h);
  const baseAlt = elAng(distH, sElev, t.elev, 0);
  const targetAngDiam = Math.atan2(t.h, distM) * 180 / Math.PI;

  const MOON_R = 0.265;
  const DAYS = 365;
  const STEP  = step;
  const STEPS = Math.floor(1440 * 60000 / STEP);
  const today = new Date(dateStr + 'T00:00:00+09:00');
  const dOff = (typeof dayOffset === 'number' && dayOffset >= 0) ? dayOffset : 0;
  const dCnt = (typeof dayCount === 'number' && dayCount > 0) ? dayCount : DAYS;
  const dEnd = Math.min(dOff + dCnt, DAYS);

  const AZ_THR = strategy.azThr(distM);
  const ctx = { tAz, distH, distM, topAlt, baseAlt, targetAngDiam, sLat, sLng, sElev, t };
  const results = [];

  for(const isSun of bodyModes){
    for(let d = dOff; d < dEnd; d++){
      const base = new Date(today.getTime() + d * 86400000);
      const ds = base.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
      const dayStart = new Date(ds + 'T00:00:00+09:00');

      if(!isSun){
        const age = moonAge(new Date(ds + 'T03:00:00Z'));
        const illum = (1 - Math.cos(2 * Math.PI * age / 29.53058867)) / 2;
        if(illum < 0.01) continue;
      }

      let sunRiseMs = null, sunSetMs = null;
      if(isSun){
        const sun = _sunT(new Date(ds + 'T03:00:00Z'), t.lat, t.lng);
        if(sun){
          sunRiseMs = sun.rise ? sun.rise.getTime() : null;
          sunSetMs  = sun.set  ? sun.set.getTime()  : null;
        }
      }

      let found = null;
      for(let i = 0; i <= STEPS; i++){
        const dt = new Date(dayStart.getTime() + i * STEP);
        const bp = isSun ? sunPos(dt, sLat, sLng) : moonPos(dt, sLat, sLng);
        const azD = Math.abs(((bp.az - tAz + 180) % 360) - 180);
        const inAlt = bp.alt >= (baseAlt - MOON_R) && bp.alt <= (topAlt + MOON_R);
        let inTimeWindow = true;
        if(isSun){
          const tMs = dt.getTime();
          const afterRise = sunRiseMs && tMs >= sunRiseMs && tMs <= sunRiseMs + 30 * 60000;
          const beforeSet = sunSetMs && tMs >= sunSetMs - 30 * 60000 && tMs <= sunSetMs;
          inTimeWindow = !!(afterRise || beforeSet);
        }
        if(azD <= AZ_THR && inAlt && inTimeWindow){
          if(!found) found = { dt, az: bp.az, alt: bp.alt, azDiff: azD, angDiam: bp.angDiam || 0.53 };
          else if(Math.abs(bp.alt - topAlt) < Math.abs(found.alt - topAlt)) found = { dt, az: bp.az, alt: bp.alt, azDiff: azD, angDiam: bp.angDiam || 0.53 };
        } else {
          if(found){ const r = strategy.buildResult(found, ds, isSun, ctx); if(r) results.push(r); found = null; }
        }
      }
      if(found){ const r = strategy.buildResult(found, ds, isSun, ctx); if(r) results.push(r); }
    }
  }

  results.sort((a, b) => a.ts - b.ts);
  return { results, tAz, topAlt, baseAlt, AZ_THR, targetAngDiam };
}
