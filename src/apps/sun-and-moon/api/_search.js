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

// 角度差（-180,180]。
function _adiff(a, b){ return ((a - b + 540) % 360) - 180; }

// D* 探索レンジ（min-move 根・wide）。moveM は最終フィルタであり、探索/評価ゲートには使わない（P0-1）。
// 交差近傍の D*≈Dref を確実に含む幅（±(2km か 距離の半分)）で全根を得る。
function _dstarRange(DrefM){
  const DKm = DrefM / 1000;
  const halfKm = Math.max(2, DKm * 0.5);
  return { loKm: Math.max(EPS_KM, DKm - halfKm), hiKm: DKm + halfKm };
}

// 正しい P* 配置（P0-4）：対象から距離 Dstar・「P*→対象方位 = bodyAz」を満たす点を、
// 配置方位 β（対象→P* 方位）の secant で解く。球面 forward/reverse 方位差を az 誤差にしない。
function placePstarForRoot(t, bodyAz, Dstar){
  let beta = (bodyAz + 180) % 360;          // 初期：対象→P* 方位
  let P = dest(t.lat, t.lng, beta, Dstar);
  for(let it = 0; it < 8; it++){
    const back = brng(P.lat, P.lng, t.lat, t.lng); // P*→対象 方位（同一 P* での対象中心方位）
    const e = _adiff(bodyAz, back);
    if(Math.abs(e) < 1e-8) break;
    beta = (beta + e + 360) % 360;           // d(back)/d(beta) ≈ 1
    P = dest(t.lat, t.lng, beta, Dstar);
  }
  return P;
}

// 検出専用の軽量 moveM（局所最小の「位置」検出のみに使用）。方位 secant 補正を省き、
// P0≈dest(target, bodyAz+180, Dstar) で近似する（真値との差は高々十数m・最終 refine/emit は厳密版）。
function coarseMoveGeo(sLat, sLng, sElev, t, bodyAz, bodyAlt, DrefM){
  const Dref = (DrefM != null) ? DrefM : hav(sLat, sLng, t.lat, t.lng) * 1000;
  const { loKm, hiKm } = _dstarRange(Dref);
  const roots = solveDstarRoots(bodyAlt, sElev, t.elev, t.h, loKm, hiKm);
  if(!roots.length) return Infinity;
  let m = Infinity;
  for(const Dstar of roots){
    const P = dest(t.lat, t.lng, (bodyAz + 180) % 360, Dstar);
    const mm = hav(sLat, sLng, P.lat, P.lng) * 1000;
    if(mm < m) m = mm;
  }
  return m;
}

// 純幾何版：bodyAz/bodyAlt 固定で、現在地点(sLat,sLng,sElev)から P* までの必要移動距離 m。
// D* は wide-range で全根探索（0/1/複数根対応・P0-5）、複数根は最小移動を採用。
// P* 配置は「P*→対象方位 = bodyAz」を満たすよう補正するため、az/alt 誤差は原理的に 0 付近（P0-4）。
export function idealMoveGeo(sLat, sLng, sElev, t, bodyAz, bodyAlt, DrefM, budgetM){
  const Dref = (DrefM != null) ? DrefM : hav(sLat, sLng, t.lat, t.lng) * 1000;
  const { loKm, hiKm } = _dstarRange(Dref);
  const roots = solveDstarRoots(bodyAlt, sElev, t.elev, t.h, loKm, hiKm);
  if(!roots.length) return { m: Infinity, ok: false };
  let best = null;
  for(const Dstar of roots){
    const P = placePstarForRoot(t, bodyAz, Dstar);
    const m = hav(sLat, sLng, P.lat, P.lng) * 1000;
    if(!best || m < best.m) best = { P, Dstar, m };
  }
  const tAz2 = brng(best.P.lat, best.P.lng, t.lat, t.lng);
  const dKm2 = hav(best.P.lat, best.P.lng, t.lat, t.lng);
  const topAlt2 = elAng(dKm2, sElev, t.elev, t.h);
  const azErr = Math.abs(_adiff(bodyAz, tAz2));
  const altErr = Math.abs(bodyAlt - topAlt2);
  return { m: best.m, azErr, altErr, Dstar: best.Dstar, ok: azErr < 0.02 && altErr < 0.02, P: best.P };
}

// 本番用：ある時刻 dt の天体を既存計算で評価して P* を置き、
// 「同一 P* 地点で再評価した天体中心方位」vs「同一 P* から見た対象中心方位」で収束判定（P0-4）。
// Moon 視差（撮影地点移動による天体 az/alt 変化）は P* 再評価で反映。moveM は現在地点→P* の実距離。
export function idealMove(sLat, sLng, sElev, t, dt, isSun, budgetM){
  const bp = isSun ? sunPos(dt, sLat, sLng) : moonPos(dt, sLat, sLng);   // 現在地点での天体
  const g = idealMoveGeo(sLat, sLng, sElev, t, bp.az, bp.alt);           // 純幾何で P*
  if(!g || !isFinite(g.m)) return { m: Infinity, converged: false, iters: 1, azErr: Infinity, altErr: Infinity };
  // 同一 P* で天体を再評価（視差反映）し、同一地点の 2 方位・2 仰角で検算する。
  const bp2 = isSun ? sunPos(dt, g.P.lat, g.P.lng) : moonPos(dt, g.P.lat, g.P.lng);
  const tAz2 = brng(g.P.lat, g.P.lng, t.lat, t.lng);
  const dKm2 = hav(g.P.lat, g.P.lng, t.lat, t.lng);
  const topAlt2 = elAng(dKm2, sElev, t.elev, t.h);
  const azErr  = Math.abs(_adiff(bp2.az, tAz2));   // 同一 P*：天体中心方位 vs 対象中心方位
  const altErr = Math.abs(bp2.alt - topAlt2);      // 同一 P*：天体中心仰角 vs 上端仰角
  return { m: g.m, converged: azErr < 0.02 && altErr < 0.02, iters: 1, azErr, altErr, P: g.P };
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

// 時刻探索と最終 moveM 採否を分離（P0-1/2/3）：
//  ・粗1分走査で「月/太陽が対象上端付近を通過する時間区間」を bracket（alt交差 g=bodyAlt-topAlt の
//    符号変化＋グレーズ=|g|局所最小。az は superset ゲート asin(200/D)+余裕、太陽は出没±30分窓）。
//    ここでは「その1分に200m以内で完全一致」を要求しない（区間検出のみ）。
//  ・各 bracket 内で moveM(t) を golden-section 最小化して代表時刻を求める（分間イベントも解ける）。
//  ・代表時刻の moveM を採否正本にし、chance≤200 / pinpoint≤30 でフィルタ（採否は buildResult 側）。
const AZ_SCAN_CUSHION_DEG = 1.0;

// input: { sLat, sLng, sElev, t, dateStr, dayOffset, dayCount, bodyModes, step }
// strategy: { buildResult(found, ds, isSun, ctx)->obj|null }
export function searchCore(input, strategy){
  const { sLat, sLng, sElev, t, dateStr, dayOffset, dayCount, bodyModes, step } = input;

  const tAz   = brng(sLat, sLng, t.lat, t.lng);
  const distH = hav(sLat, sLng, t.lat, t.lng);
  const distM = distH * 1000;
  const topAlt  = elAng(distH, sElev, t.elev, t.h);
  const baseAlt = elAng(distH, sElev, t.elev, 0);
  const targetAngDiam = Math.atan2(t.h, distM) * 180 / Math.PI;

  const DAYS = 365;
  const STEP  = step || 60000;
  const STEPS = Math.floor(1440 * 60000 / STEP);
  const today = new Date(dateStr + 'T00:00:00+09:00');
  const dOff = (typeof dayOffset === 'number' && dayOffset >= 0) ? dayOffset : 0;
  const dCnt = (typeof dayCount === 'number' && dayCount > 0) ? dayCount : DAYS;
  const dEnd = Math.min(dOff + dCnt, DAYS);

  // 方位スキャンゲート（superset）：moveM≤200 の候補は必ず azDiff ≤ asin(200/D)（∵ 横移動≤moveM）。
  // 区間検出の取りこぼし防止に +余裕。budget≥D なら全方位。
  const azGate = (200 >= distM) ? 180 : (Math.asin(200 / distM) * 180 / Math.PI + AZ_SCAN_CUSHION_DEG);
  const ctx = { tAz, distH, distM, topAlt, baseAlt, targetAngDiam, sLat, sLng, sElev, t };
  const results = [];

  // 最小時刻の特定には軽量 moveM（coarseMoveGeo）を使う（secant省略・真値との差は十数m・時刻位置は不変）。
  // 最終 emit は厳密 idealMove で moveM/収束/azErr/altErr を確定する（最終精度は不変）。
  const cheapMoveAt = (ms, isSun) => {
    const bp = isSun ? sunPos(new Date(ms), sLat, sLng) : moonPos(new Date(ms), sLat, sLng);
    return coarseMoveGeo(sLat, sLng, sElev, t, bp.az, bp.alt, distM);
  };

  // golden-section で区間 [aMs,bMs] の moveM 最小時刻を返す。
  const refineMin = (aMs, bMs, isSun) => {
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = aMs, b = bMs;
    let c = b - gr * (b - a), d = a + gr * (b - a);
    let fc = cheapMoveAt(c, isSun), fd = cheapMoveAt(d, isSun);
    for(let it = 0; it < 34; it++){
      if(fc < fd){ b = d; d = c; fd = fc; c = b - gr * (b - a); fc = cheapMoveAt(c, isSun); }
      else       { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = cheapMoveAt(d, isSun); }
    }
    return (a + b) / 2;
  };

  const emitAt = (ms, isSun, ds) => {
    const dt = new Date(ms);
    const mv = idealMove(sLat, sLng, sElev, t, dt, isSun, 200);
    const bp = isSun ? sunPos(dt, sLat, sLng) : moonPos(dt, sLat, sLng);
    const found = {
      dt, az: bp.az, alt: bp.alt, azDiff: Math.abs(_adiff(bp.az, tAz)),
      angDiam: bp.angDiam || 0.53,
      moveM: mv.m, moveConverged: mv.converged, moveIters: mv.iters, azErr: mv.azErr, altErr: mv.altErr,
    };
    const r = strategy.buildResult(found, ds, isSun, ctx);
    if(r) results.push(r);
  };

  for(const isSun of bodyModes){
    for(let d = dOff; d < dEnd; d++){
      const baseDate = new Date(today.getTime() + d * 86400000);
      const ds = baseDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
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

      // 粗1分走査で bracket を収集。検出は「真の moveM(t) の局所最小」を主軸にする
      //  （近距離では moveM≤200 が大角度離れた点でも成立するため、角距離や alt 差では取りこぼす）。
      //  併せて (a) alt交差 g の符号変化（遠距離 sub-minute 交差の保険）、
      //  (b) active ラン（az ゲート内の連続区間）の両端（窓境界にある最小の保険）も bracket 化する。
      //  active は az superset ゲート内・（太陽は）出没±30分窓内。moveM は探索ゲートに使わない（P0-1）。
      const brackets = [];
      let m2 = null, m1 = null;     // 直近2 active（moveM局所最小検出）: {ms, m}
      let gPrev = null;             // 直近 active（alt交差検出）: {ms, g}
      let lastActiveMs = null, prevActive = false;
      for(let i = 0; i <= STEPS; i++){
        const ms = dayStart.getTime() + i * STEP;
        const dt = new Date(ms);
        const bp = isSun ? sunPos(dt, sLat, sLng) : moonPos(dt, sLat, sLng);
        const azD = Math.abs(_adiff(bp.az, tAz));
        let inWin = true;
        if(isSun){
          const afterRise = sunRiseMs && ms >= sunRiseMs && ms <= sunRiseMs + 30 * 60000;
          const beforeSet = sunSetMs && ms >= sunSetMs - 30 * 60000 && ms <= sunSetMs;
          inWin = !!(afterRise || beforeSet);
        }
        const active = (azD <= azGate) && inWin;
        if(active){
          const g = bp.alt - topAlt;
          const cm = coarseMoveGeo(sLat, sLng, sElev, t, bp.az, bp.alt, distM);   // 検出専用 軽量moveM
          const cur = { ms, m: isFinite(cm) ? cm : Infinity };
          if(!prevActive) brackets.push([ms - STEP, ms + STEP]);                       // (b) ラン開始端
          if(gPrev && ((gPrev.g <= 0) !== (g <= 0))) brackets.push([gPrev.ms, ms]);    // (a) alt交差
          if(m1 && m2 && m1.m <= m2.m && m1.m <= cur.m && isFinite(m1.m))              // moveM局所最小
            brackets.push([m2.ms, ms]);
          m2 = m1; m1 = cur; gPrev = { ms, g }; lastActiveMs = ms;
        } else {
          if(prevActive && lastActiveMs != null) brackets.push([lastActiveMs - STEP, lastActiveMs + STEP]); // (b) ラン終了端
          m2 = null; m1 = null; gPrev = null;
        }
        prevActive = active;
      }
      if(prevActive && lastActiveMs != null) brackets.push([lastActiveMs - STEP, lastActiveMs + STEP]);     // 末尾がactiveのまま終了
      if(!brackets.length) continue;

      // 各 bracket を時刻 refine → 近接（2分以内）を最小 moveM で統合 → emit。
      const reps = [];
      for(const [aMs, bMs] of brackets){
        const ts = refineMin(aMs - STEP, bMs + STEP, isSun);
        reps.push({ ms: ts, m: cheapMoveAt(ts, isSun) });
      }
      reps.sort((x, y) => x.ms - y.ms);
      const uniq = [];
      for(const r of reps){
        if(uniq.length && Math.abs(r.ms - uniq[uniq.length - 1].ms) < 2 * 60000){
          if(r.m < uniq[uniq.length - 1].m) uniq[uniq.length - 1] = r;
        } else uniq.push(r);
      }
      // P1: 代表時刻の JST 日付が当日 ds と一致する候補だけを emit する。
      // bracket 検出は翌日 00:00 サンプルまで含み、refine も区間を跨ぐため、代表時刻が前日/翌日へ
      // はみ出すことがある。イベントは「真の最小時刻が属する日」に一意帰属させ、隣日走査との重複・
      // result.date と result.ts の JST 日付不一致を防ぐ（各イベントはその属する日の走査でのみ emit）。
      for(const u of uniq){
        const jstDate = new Date(u.ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
        if(jstDate !== ds) continue;
        emitAt(u.ms, isSun, ds);
      }
    }
  }

  results.sort((a, b) => a.ts - b.ts);
  return { results, tAz, topAlt, baseAlt, AZ_THR: azGate, targetAngDiam };
}
