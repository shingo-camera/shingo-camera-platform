// ============================================================
// functions/api/_search.js
// 登録地点検索の共通探索コア。pinpoint / chance で重複していた
// 「日付走査・月/太陽位置・月齢/照度・日の出日没・方位差・上端/下端仰角・
//  時刻刻み・候補区間抽出・代表時刻選択・日時ソート」を集約する。
// 判定（プレフィルタ・候補採否・結果生成）は strategy 側へ分離する。
// ★現行正本の評価定義（chance / pinpoint 共通）：
//   ・理想状態＝天体中心が対象上端中央（方位＝対象中央方位／仰角＝上端仰角 topAlt）
//   ・評価値 moveM＝現在撮影地点から理想地点 P* までの実移動距離（横＋前後を含む）
//   ・P* の撮影標高は pElev = sElev（同一標高面。正式仕様。Terrain再取得しない）
//   ・代表時刻＝区間内 moveM 最小（旧・上端高度差最小は不使用）
//   ・chance = moveM≤200m ／ pinpoint = moveM≤30m ／ ★ = 5/10/50/100/200m
//   ・moveConverged 必須、NaN/Infinity/未収束は fail-closed
//   ・通常chance / 通常pinpoint / 一括pinpoint で同一定義
// 天体計算は functions/api/_astro.js を再利用（コピーしない）。
// ============================================================
import { moonPos, sunPos, moonAge, makeSunT, brng, hav, elAng, dest } from './_astro.js';

const _sunT = makeSunT();

// ============================================================
// 評価一本化：理想撮影地点 P* と「上端中央一致に必要な撮影地点移動距離」m
// ------------------------------------------------------------
// 理想状態（誤差0）＝ 天体中心が対象の上端中央を通る：
//   (1) 天体中心方位 = 対象中心方位
//   (2) 天体中心仰角 = 対象上端仰角
// これを満たす撮影地点 P* を求め、現在地点→P* の実距離を m とする。
// 横移動だけでなく前後移動（距離D変化＝上端仰角変化）も含む実移動距離。
// ============================================================

// solveDstar: 撮影地点標高 se・対象基部標高 te・対象高 th のとき、
// 対象上端仰角 = targetAlt(deg) となる水平距離 D*(m) を求める。
// ------------------------------------------------------------
// solveDstarRoots: elAng(D)=targetAlt の根を [dLoKm,dHiKm] 内で「全て」求める。
// elAng は単調とは限らない（高台から低い対象を見る場合など、増加⇔減少が反転する）。
// グリッド走査で符号変化区間を検出し、各区間を二分して根を得る（0/1/複数根に対応）。
// 戻り値：根の距離(m)配列（昇順）。magic 補正なし。
// ------------------------------------------------------------
const MOON_R = 0.265;
const EPS_KM = 0.0005; // 0.5m（最小距離クランプ）

export function solveDstarRoots(targetAlt, se, te, th, dLoKm, dHiKm){
  if(!(dHiKm > dLoKm)) return [];
  const f = dKm => elAng(dKm, se, te, th) - targetAlt;
  const bis = (lo, hi, flo) => {
    for(let k = 0; k < 34; k++){
      const mid = (lo + hi) / 2, fm = f(mid);
      if(fm === 0) return mid;
      if((flo < 0) === (fm < 0)){ lo = mid; flo = fm; } else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const fLo = f(dLoKm), fHi = f(dHiKm);
  const spanKm = dHiKm - dLoKm;
  // 高速パス：狭帯（≤1km）は elAng が単調 → 端点が異符号なら根はちょうど1個（直接二分）。
  // 本番の band は ±budget(=200m 以下) なので大半がこの経路。
  if(spanKm <= 1.0){
    if(fLo === 0) return [dLoKm * 1000];
    if(fHi === 0) return [dHiKm * 1000];
    if((fLo < 0) !== (fHi < 0)) return [bis(dLoKm, dHiKm, fLo) * 1000];
    // 同符号（0 or 2根の稀ケース）は下のグリッド走査で拾う
  }
  // 一般：グリッド走査で符号変化区間を検出し各区間を二分（0/1/複数根・非単調に対応）。
  const N = 24;
  const roots = [];
  let prevD = dLoKm, prevF = fLo;
  if(prevF === 0) roots.push(prevD * 1000);
  for(let i = 1; i <= N; i++){
    const d = dLoKm + (dHiKm - dLoKm) * i / N;
    const fv = f(d);
    if(fv === 0){ roots.push(d * 1000); prevD = d; prevF = fv; continue; }
    if((prevF < 0) !== (fv < 0)) roots.push(bis(prevD, d, prevF) * 1000);
    prevD = d; prevF = fv;
  }
  return roots;
}

// 後方互換：単一の（現在距離に最も近い）根を返す。テスト・単純用途向け。
export function solveDstar(targetAlt, se, te, th, DrefKm){
  const dref = (DrefKm != null) ? DrefKm : 1;
  const roots = solveDstarRoots(targetAlt, se, te, th, EPS_KM, 500);
  if(!roots.length) return null;
  let best = roots[0];
  for(const r of roots) if(Math.abs(r / 1000 - dref) < Math.abs(best / 1000 - dref)) best = r;
  return best;
}

// 現在距離 DrefM(m)・移動許容 budgetM(m) のとき、band [Dref-budget, Dref+budget] 内で
// 上端中央一致地点 P* の根を全探索し、原点(oLat,oLng)からの移動距離が最小の根を選ぶ。
function bestPstar(oLat, oLng, t, sElev, bodyAz, bodyAlt, DrefM, budgetM){
  const DrefKm = DrefM / 1000;
  const loKm = Math.max(EPS_KM, DrefKm - budgetM / 1000);
  const hiKm = DrefKm + budgetM / 1000;
  const roots = solveDstarRoots(bodyAlt, sElev, t.elev, t.h, loKm, hiKm);
  if(!roots.length) return null;
  let best = null;
  for(const Dstar of roots){
    const P = dest(t.lat, t.lng, (bodyAz + 180) % 360, Dstar);
    const m = hav(oLat, oLng, P.lat, P.lng) * 1000;
    if(!best || m < best.m) best = { lat: P.lat, lng: P.lng, Dstar, m };
  }
  return best;
}

// 純幾何版：bodyAz/bodyAlt 固定で、現在地点(sLat,sLng,sElev)から P* までの必要移動距離 m。
// 複数根は最小移動を採用。上端中央一致の検算値(az/altErr)も返す（決定論・ephemeris不使用）。
export function idealMoveGeo(sLat, sLng, sElev, t, bodyAz, bodyAlt, DrefM, budgetM){
  const Dref = (DrefM != null) ? DrefM : hav(sLat, sLng, t.lat, t.lng) * 1000;
  const budget = (budgetM != null) ? budgetM : 200;
  const b = bestPstar(sLat, sLng, t, sElev, bodyAz, bodyAlt, Dref, budget);
  if(!b) return { m: Infinity, ok: false };
  const tAz2 = brng(b.lat, b.lng, t.lat, t.lng);
  const dKm2 = hav(b.lat, b.lng, t.lat, t.lng);
  const topAlt2 = elAng(dKm2, sElev, t.elev, t.h);
  const azErr = Math.abs(((bodyAz - tAz2 + 540) % 360) - 180);
  const altErr = Math.abs(bodyAlt - topAlt2);
  return { m: b.m, azErr, altErr, Dstar: b.Dstar, ok: azErr < 0.02 && altErr < 0.02 };
}

// 本番用：ある時刻 dt の天体を既存計算で評価し、理想地点 P* を置き、
// P* で天体 az/alt・対象方位・上端仰角を再評価して一致を確認（仕様 §5-6）。
// 撮影地点移動による天体 az/alt 変化を反映するため少数回反復。反復回数 iters と収束 converged を返す。
export function idealMove(sLat, sLng, sElev, t, dt, isSun, budgetM){
  const budget = (budgetM != null) ? budgetM : 200;
  let pLat = sLat, pLng = sLng; const pElev = sElev;
  let converged = false, azErr = Infinity, altErr = Infinity, iters = 0, m = Infinity;
  for(let it = 0; it < 4; it++){
    iters = it + 1;
    const bp = isSun ? sunPos(dt, pLat, pLng) : moonPos(dt, pLat, pLng);          // A: 現P での天体
    const DrefM = hav(pLat, pLng, t.lat, t.lng) * 1000;
    const b = bestPstar(sLat, sLng, t, pElev, bp.az, bp.alt, DrefM, budget);      // B+C: 最小移動根で P*
    if(!b) return { m: Infinity, converged: false, iters, azErr, altErr };
    pLat = b.lat; pLng = b.lng;
    const bp2 = isSun ? sunPos(dt, pLat, pLng) : moonPos(dt, pLat, pLng);         // D: 移動後の天体を再評価
    const tAz2 = brng(pLat, pLng, t.lat, t.lng);
    const dKm2 = hav(pLat, pLng, t.lat, t.lng);
    const topAlt2 = elAng(dKm2, pElev, t.elev, t.h);
    azErr  = Math.abs(((bp2.az - tAz2 + 540) % 360) - 180);
    altErr = Math.abs(bp2.alt - topAlt2);
    m = hav(sLat, sLng, pLat, pLng) * 1000;
    if(azErr < 0.02 && altErr < 0.02){ converged = true; break; }                // E: 収束
  }
  return { m, converged, iters, azErr, altErr };
}

// 上端中央一致に必要な撮影地点移動距離が m 以内になり得る候補の、保守的（superset）プレフィルタ境界。
// ・方位：m ≥ D·sin(azDiff) より azDiff ≤ asin(min(1, budget/D))（budget≥Dなら全方位）
// ・高度：D* ∈ [D-budget, D+budget]（∵ m ≥ |D-D*|）に対応する上端仰角 elAng の値域 ± 余裕
// これらを満たさない候補は必ず m>budget であり、落としても正解を失わない。
export function prefilterBounds(distM, sElev, te, th, budgetM){
  const DKm = distM / 1000;
  const loKm = Math.max(EPS_KM, DKm - budgetM / 1000);
  const hiKm = DKm + budgetM / 1000;
  let altLo = Infinity, altHi = -Infinity;
  const NS = 48;
  for(let i = 0; i <= NS; i++){
    const dk = loKm + (hiKm - loKm) * i / NS;
    const e = elAng(dk, sElev, te, th);
    if(e < altLo) altLo = e;
    if(e > altHi) altHi = e;
  }
  const margin = MOON_R + 0.5; // 月半径＋走査・数値安全余裕
  const azThr = (budgetM >= distM) ? 180 : Math.asin(budgetM / distM) * 180 / Math.PI;
  return { azThr, altLo: altLo - margin, altHi: altHi + margin };
}

// 採否述語（chance / pinpoint 共通・fail-closed）：
// 理想地点の再評価が収束(moveConverged===true)し、moveM が有限かつ閾値内のときのみ true。
// 未収束・NaN・Infinity はすべて false（P0-4）。
export function acceptMove(fd, maxMoveM){
  return fd && fd.moveConverged === true
    && typeof fd.moveM === 'number' && isFinite(fd.moveM)
    && fd.moveM <= maxMoveM;
}

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

  const DAYS = 365;
  const STEP  = step;
  const STEPS = Math.floor(1440 * 60000 / STEP);
  const today = new Date(dateStr + 'T00:00:00+09:00');
  const dOff = (typeof dayOffset === 'number' && dayOffset >= 0) ? dayOffset : 0;
  const dCnt = (typeof dayCount === 'number' && dayCount > 0) ? dayCount : DAYS;
  const dEnd = Math.min(dOff + dCnt, DAYS);

  // プレフィルタは「moveM≤budget の候補を絶対に落とさない」保守的(superset)境界のみ使用（P0-2）。
  // budget は chance の最大値 200m（pinpoint≤30 は部分集合なので同一候補集合でよい）。
  const PREFILTER_BUDGET = 200;
  const { azThr: AZ_THR, altLo: ALT_LO, altHi: ALT_HI } =
    prefilterBounds(distM, sElev, t.elev, t.h, PREFILTER_BUDGET);
  const ctx = { tAz, distH, distM, topAlt, baseAlt, targetAngDiam, sLat, sLng, sElev, t };
  const results = [];

  // 代表時刻 found（区間内 moveM 最小）について本番の idealMove（天体再評価）を実行し、
  // m・収束・反復回数を添付して buildResult（採否＝moveConverged かつ moveM≤threshold）へ渡す。
  const emit = (found, ds, isSun) => {
    const mv = idealMove(sLat, sLng, sElev, t, found.dt, isSun, PREFILTER_BUDGET);
    found.moveM = mv.m;
    found.moveConverged = mv.converged;
    found.moveIters = mv.iters;
    const r = strategy.buildResult(found, ds, isSun, ctx);
    if(r) results.push(r);
  };

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
        const inAlt = bp.alt >= ALT_LO && bp.alt <= ALT_HI; // moveM≤budget の superset 境界
        let inTimeWindow = true;
        if(isSun){
          const tMs = dt.getTime();
          const afterRise = sunRiseMs && tMs >= sunRiseMs && tMs <= sunRiseMs + 30 * 60000;
          const beforeSet = sunSetMs && tMs >= sunSetMs - 30 * 60000 && tMs <= sunSetMs;
          inTimeWindow = !!(afterRise || beforeSet);
        }
        if(azD <= AZ_THR && inAlt && inTimeWindow){
          // 代表時刻は「区間内で必要移動距離 moveM が最小」の時刻（純幾何版で高速評価）。
          // 旧高度差最小は最終rankingに使わない（P0-1）。
          const mg = idealMoveGeo(sLat, sLng, sElev, t, bp.az, bp.alt, distM, PREFILTER_BUDGET);
          if(!found || mg.m < found.mgeo){
            found = { dt, az: bp.az, alt: bp.alt, azDiff: azD, angDiam: bp.angDiam || 0.53, mgeo: mg.m };
          }
        } else {
          if(found){ emit(found, ds, isSun); found = null; }
        }
      }
      if(found){ emit(found, ds, isSun); }
    }
  }

  results.sort((a, b) => a.ts - b.ts);
  return { results, tAz, topAlt, baseAlt, AZ_THR, targetAngDiam };
}
