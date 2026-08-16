// ============================================================
// functions/api/_search.js
// 登録地点検索の共通探索コア。pinpoint / chance で重複していた
// 「日付走査・月/太陽位置・月齢/照度・日の出日没・方位差・上端/下端仰角・
//  時刻刻み・候補区間抽出・代表時刻選択・日時ソート」を集約する。
// 判定（プレフィルタ・候補採否・結果生成）は strategy 側へ分離する。
// ★現行正本の評価定義（chance / pinpoint 共通）：
//   ・理想領域＝対象上端中央が月・太陽の円盤（半径 R=angDiam/2）内（|angSep(上端中央,天体中心)|≤R）
//   ・評価値 moveM＝現在撮影地点から「対象上端が円盤内となる撮影地点」までの実移動距離を
//     2次元地表上で数値的に探索した最短解（円盤内ならば 0m。円盤外のみ最寄り境界までの実移動）
//   ・中心完全一致地点 P*（天体中心＝対象上端中央）は探索上の補助解であり、最終評価の唯一の理想点ではない
//   ・P* / 撮影標高は pElev = sElev（同一標高面。正式仕様。Terrain再取得しない）
//   ・代表時刻＝区間内 moveM 最小（旧・上端高度差最小は不使用）
//   ・chance = moveM≤200m ／ pinpoint = moveM≤30m ／ ★ = 5/10/50/100/200m
//   ・moveConverged 必須、NaN/Infinity/未収束は fail-closed
//   ・R はその時刻の実角半径（bodyPos.angDiam/2 を再利用。固定値を新設しない）
//   ・通常chance / 通常pinpoint / 一括pinpoint で同一定義
// 天体計算は functions/api/_astro.js を再利用（コピーしない）。
// ============================================================
import { moonPos, sunPos, brng, hav, elAng, dest } from './_astro.js';


// ============================================================
// 補助解：中心完全一致地点 P*（天体中心が対象上端中央を通る撮影地点）
// ------------------------------------------------------------
//   (1) 天体中心方位 = 対象中心方位   (2) 天体中心仰角 = 対象上端仰角
// を満たす P* を求める（時刻探索・代表時刻・収束判定に使用）。最終評価 moveM は
// これ一点への距離ではなく「対象上端が円盤内となる最寄り地点」までの距離（diskEval）。
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

// 角距離（(az,alt)球面）。
function _angSepDeg(az1, al1, az2, al2){
  const r = Math.PI / 180;
  const c = Math.sin(al1 * r) * Math.sin(al2 * r)
          + Math.cos(al1 * r) * Math.cos(al2 * r) * Math.cos((az1 - az2) * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r;
}

// 新評価（正本）：理想領域＝「対象上端中央が天体円盤(半径 R=angDiam/2)内」。
// ・円盤内（angSep(上端中央, 天体中心) ≤ R）なら必要移動 moveM = 0m（中心完全一致まで動けても減点しない）。
// ・円盤外のみ：現在地点 S → 中心完全一致 P* の実移動経路上で
//     F(x) = angSep(P(x)から見た上端中央, P(x)から見た天体中心) − R(P(x))
//   を「各 P(x) で天体 az/alt・対象 az/topAlt・R=angDiam/2 を実再評価」して求め、S(F>0)〜P*(F<0) を
//   二分探索して F=0（円盤境界へ入る最初の点）までの実移動距離を moveM とする（線形近似は使わない）。
//   複数の中心一致 P* 候補があれば各経路の境界距離を求め最小 moveM を採用。
// ・R はその時刻の実角半径（既存 bodyPos.angDiam を再利用）。pElev=sElev 維持・magic/新天文計算なし。
// ・disk moveM ≤ 中心一致 moveM が常に成立するため chance≤200 / pinpoint≤30 の候補は減らない。
// F(P): 実地点 P で本体を再評価して angSep − R を返す（円盤外で >0、円盤内で <0）。
function _diskF(pLat, pLng, sElev, t, dt, isSun){
  const bp = isSun ? sunPos(dt, pLat, pLng) : moonPos(dt, pLat, pLng);
  const tAz = brng(pLat, pLng, t.lat, t.lng);
  const topAlt = elAng(hav(pLat, pLng, t.lat, t.lng), sElev, t.elev, t.h);
  const R = (bp.angDiam || 0.53) / 2;
  return _angSepDeg(tAz, topAlt, bp.az, bp.alt) - R;
}

// 円盤外の最終 moveM：現在地点 S から「対象上端が円盤内(F≤0)となる撮影地点」までの実移動距離を
// 2次元地表上で数値的に探索した最短解。S→中心一致 P* の1本の線には限定しない。
// F の勾配ニュートン法：各反復で S/現P で F と数値勾配∇F（1m 有限差分・実再評価）を求め、
// レベル集合 F=0 への方向（−∇F）へ Newton ステップ（step=F/|∇F|）で進み、F=0 境界へ収束させる。
// （一般の非凸領域に対する数学的 global optimizer ではない。代表的な Sun/Moon・近/遠・方位/高度/両ズレ
//  fixture で test 専用の 2次元 brute-force oracle 参照値と characterization 一致を確認している。）
// 全方位高密度 scan はしない。chance の上限(200m)を大きく超える解や勾配消失・発散は対象外（Infinity）。
const _DISK_MAX_M = 400;
function _nearestDiskMove(sLat, sLng, sElev, t, dt, isSun){
  if(_diskF(sLat, sLng, sElev, t, dt, isSun) <= 0) return 0;   // 既に円盤内
  let pLat = sLat, pLng = sLng;
  for(let it = 0; it < 16; it++){
    const F0 = _diskF(pLat, pLng, sElev, t, dt, isSun);
    if(F0 <= 1e-7) break;
    const Pe = dest(pLat, pLng, 90, 1), Pn = dest(pLat, pLng, 0, 1);   // 東/北へ1m 有限差分
    const gE = _diskF(Pe.lat, Pe.lng, sElev, t, dt, isSun) - F0;
    const gN = _diskF(Pn.lat, Pn.lng, sElev, t, dt, isSun) - F0;
    const gn = Math.hypot(gE, gN);
    if(gn < 1e-12) return Infinity;                            // 勾配消失＝進めない
    const step = F0 / gn;                                      // F=0 まで（線形近似・反復で補正）
    if(step > _DISK_MAX_M) return Infinity;                    // 遠すぎ＝対象外
    const brg = (Math.atan2(-gE / gn, -gN / gn) * 180 / Math.PI + 360) % 360;  // −∇F 方向
    const P = dest(pLat, pLng, brg, step);
    if(hav(sLat, sLng, P.lat, P.lng) * 1000 > _DISK_MAX_M) return Infinity;
    pLat = P.lat; pLng = P.lng;
  }
  if(_diskF(pLat, pLng, sElev, t, dt, isSun) > 1e-4) return Infinity;  // 円盤内へ到達できず
  return hav(sLat, sLng, pLat, pLng) * 1000;
}

export function diskEval(sLat, sLng, sElev, t, dt, isSun){
  const bp = isSun ? sunPos(dt, sLat, sLng) : moonPos(dt, sLat, sLng);
  const R = (bp.angDiam || 0.53) / 2;
  const tAz = brng(sLat, sLng, t.lat, t.lng);
  const topAlt = elAng(hav(sLat, sLng, t.lat, t.lng), sElev, t.elev, t.h);
  const angSep0 = _angSepDeg(tAz, topAlt, bp.az, bp.alt);
  const mvc = idealMove(sLat, sLng, sElev, t, dt, isSun, 200); // 中心一致 P*（補助解・不変）＋収束/代表用
  if(angSep0 <= R){                                            // 既に円盤内＝理想領域
    return { moveM: 0, converged: true, inDisk: true, R, angSep0, centerM: mvc.m,
             azErr: mvc.azErr, altErr: mvc.altErr, iters: mvc.iters, bodyAz: bp.az, bodyAlt: bp.alt, tAz, topAlt };
  }
  const m = _nearestDiskMove(sLat, sLng, sElev, t, dt, isSun); // 円盤外：2次元の数値的最短解（勾配ニュートン）
  // 保証上界：中心一致 P* は円盤内(F<0)なので、S→P* 線上の F=0 境界は必ず存在し ≤ centerM。
  // 勾配法が発散/未収束(Infinity)でも、この上界により disk moveM ≤ centerM を担保する。
  let m2 = Infinity;
  if(isFinite(mvc.m) && mvc.P){
    const D = mvc.m;
    const brg = brng(sLat, sLng, mvc.P.lat, mvc.P.lng);
    const Ff = (fr) => { const P = dest(sLat, sLng, brg, D * fr); return _diskF(P.lat, P.lng, sElev, t, dt, isSun); };
    if(Ff(1) <= 0){ let lo = 0, hi = 1; for(let k = 0; k < 44; k++){ const md = (lo + hi) / 2; (Ff(md) > 0) ? lo = md : hi = md; } m2 = D * (lo + hi) / 2; }
  }
  const best = Math.min(m, m2);
  const converged = isFinite(best);
  return { moveM: converged ? best : Infinity, converged, inDisk: false, R, angSep0, centerM: mvc.m,
           azErr: mvc.azErr, altErr: mvc.altErr, iters: mvc.iters, bodyAz: bp.az, bodyAlt: bp.alt, tAz, topAlt };
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
//    符号変化＋グレーズ=|g|局所最小。az は superset ゲート asin(200/D)+余裕）。
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

  // 表示用の「方位一致時刻」：|bodyAz − targetAz| が最小になる時刻を代表時刻(ms=moveM最小)の近傍で求める。
  // 表示時刻・高度%はこの時刻の天体中心を使う（評価 moveM/★ は別＝moveM最小時刻のまま）。sub-minute で
  // 求め UI は1分丸め。方位差は event 近傍で単調→単峰なので golden-section で内部最小を取る。
  const azDiffAt = (mms, isSun) => {
    const bp = isSun ? sunPos(new Date(mms), sLat, sLng) : moonPos(new Date(mms), sLat, sLng);
    return Math.abs(_adiff(bp.az, tAz));
  };
  const azMatchTime = (centerMs, isSun) => {
    const W = 30 * 60000;                         // ±30分窓（event近傍）
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = centerMs - W, b = centerMs + W;
    let c = b - gr * (b - a), d = a + gr * (b - a);
    let fc = azDiffAt(c, isSun), fd = azDiffAt(d, isSun);
    for(let it = 0; it < 34; it++){
      if(fc < fd){ b = d; d = c; fd = fc; c = b - gr * (b - a); fc = azDiffAt(c, isSun); }
      else       { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = azDiffAt(d, isSun); }
    }
    const tm = (a + b) / 2;
    // 窓端に張り付いた（=窓内に方位一致が無い・単調）なら代表時刻へフォールバック。
    if(azDiffAt(tm, isSun) > azDiffAt(centerMs, isSun) + 1e-9) return centerMs;
    return tm;
  };

  const emitAt = (ms, isSun, ds) => {
    const dtMove = new Date(ms);
    const de = diskEval(sLat, sLng, sElev, t, dtMove, isSun);   // 評価（moveM/★/採否）：moveM最小時刻のまま不変
    // 表示時刻＝方位一致時刻（1分丸め）。ts・date・重複判定・ソートは正準時刻(moveM最小)のまま維持。
    let dispMs = Math.round(azMatchTime(ms, isSun) / 60000) * 60000;
    if(new Date(dispMs).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) !== ds) dispMs = Math.round(ms / 60000) * 60000;
    const dtDisp = new Date(dispMs);
    const bp = isSun ? sunPos(dtDisp, sLat, sLng) : moonPos(dtDisp, sLat, sLng);  // 表示時刻の天体中心（高度%はこの alt）
    const found = {
      dt: dtMove,             // 正準時刻（ts/date/重複/ソート用：不変）
      dispDt: dtDisp,         // 表示時刻（方位一致・1分丸め。buildResult の time はこれを使う）
      az: bp.az, alt: bp.alt, azDiff: Math.abs(_adiff(bp.az, tAz)),  // 高度%・表示は方位一致時刻の天体中心
      angDiam: bp.angDiam || 0.53,
      moveM: de.moveM, moveConverged: de.converged, moveIters: de.iters, azErr: de.azErr, altErr: de.altErr,
    };
    const r = strategy.buildResult(found, ds, isSun, ctx);
    if(r) results.push(r);
  };

  for(const isSun of bodyModes){
    for(let d = dOff; d < dEnd; d++){
      const baseDate = new Date(today.getTime() + d * 86400000);
      const ds = baseDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
      const dayStart = new Date(ds + 'T00:00:00+09:00');

      // A-2: 旧 Moon illum<0.01 の日スキップは撤去。幾何的 chance 検索では月の照度は候補の成否に
      //  無関係（円盤の角径は照度によらず存在）で、商品仕様でもないため、検索不能にしない（完全性優先）。
      //  月齢 age は buildResult 側で別途算出するため、ここでは不要。

      // A: 旧 太陽 rise/set ±30分の inWin 固定窓は撤去（未指定・非対称の hard gate で、高仰角の遠距離
      //  対象＝本栖湖ダイヤモンド富士 07:47 等の真の disk 候補を diskEval 到達前に落としていた）。
      //  太陽も月と同様、固定時間窓なしで candidate detection へ通す（active は azGate のみで判定）。

      // 粗1分走査で bracket を収集。検出は「真の moveM(t) の局所最小」を主軸にする
      //  （近距離では moveM≤200 が大角度離れた点でも成立するため、角距離や alt 差では取りこぼす）。
      //  併せて (a) alt交差 g の符号変化（遠距離 sub-minute 交差の保険）、
      //  (b) active ラン（az ゲート内の連続区間）の両端（ラン境界の最小の保険）も bracket 化する。
      //  active は az superset ゲート内（太陽の出没窓・月の照度スキップは撤去済み）。moveM は探索ゲートに使わない（P0-1）。
      const brackets = [];
      let m2 = null, m1 = null;     // 直近2 active（moveM局所最小検出）: {ms, m}
      let gPrev = null;             // 直近 active（alt交差検出）: {ms, g}
      let lastActiveMs = null, prevActive = false;
      for(let i = 0; i <= STEPS; i++){
        const ms = dayStart.getTime() + i * STEP;
        const dt = new Date(ms);
        const bp = isSun ? sunPos(dt, sLat, sLng) : moonPos(dt, sLat, sLng);
        const azD = Math.abs(_adiff(bp.az, tAz));
        // A: active は azGate（superset）のみで判定。太陽の rise/set 窓・月の照度スキップは撤去。
        //  azGate = asin(200/D)+1.0° は「200m移動＋天体円半径R＋数値誤差」を含めても真の chance 候補
        //  （disk_moveM≤200）を絶対に落とさない superset（回帰テストで証明）。
        const active = (azD <= azGate);
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
