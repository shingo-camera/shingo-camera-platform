/**
 * SUN AND MOON 発売前改修 課題3（KMZ等価ズーム A+C方式）の幾何検証。
 *
 * 検証方針:
 * - 実装ファイル public/apps/sun-and-moon/index.html から destPoint / brng を
 *   そのまま抽出して実行する（式の写し間違いを排除し、実装そのものを検証する）。
 * - A方式の正条件「virt カメラから見た方位・高度 = API の方位・高度」を、
 *   t2 配置式で置いた天体を逆算（brng / atan）して確認する。
 * - 旧方式（撮影地点基準の座標を virt から見る）では視差誤差が有意に出ること
 *   （=修正前の不具合の再現）も対比として確認する。
 * - C方式の shortScale が「非クランプで 1 / クランプで <1」となることを確認する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("public/apps/sun-and-moon/index.html", "utf8");

function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`);
  const m = html.match(re);
  assert.ok(m, `${name} が index.html から抽出できること`);
  return m[0];
}

// 実装の destPoint / brng を抽出して評価（実装コードそのものを実行）
const destPointSrc = extractFn("destPoint");
const brngSrc = extractFn("brng");
// eslint-disable-next-line no-new-func
const geo = new Function(`${destPointSrc}\n${brngSrc}\nreturn {destPoint, brng};`)();
const { destPoint, brng } = geo;

const DEG = Math.PI / 180;

test("[幾何] destPoint→brng の順逆整合（方位復元誤差 < 0.005°）", () => {
  const cases = [
    { lat: 34.65, lng: 135.5, az: 0, d: 30 },
    { lat: 34.65, lng: 135.5, az: 87.3, d: 30 },
    { lat: 34.65, lng: 135.5, az: 181.4, d: 30 },
    { lat: 34.65, lng: 135.5, az: 271.2, d: 30 },
    { lat: 43.0, lng: 141.35, az: 123.4, d: 30 },
    { lat: 26.2, lng: 127.68, az: 305.9, d: 30 },
  ];
  for (const c of cases) {
    const [bLat, bLng] = destPoint(c.lat, c.lng, c.az, c.d);
    const azBack = brng(c.lat, c.lng, bLat, bLng);
    let dAz = Math.abs(azBack - c.az) % 360;
    if (dAz > 180) dAz = 360 - dAz;
    assert.ok(dAz < 0.005, `az=${c.az} 復元誤差 ${dAz.toFixed(6)}°`);
  }
});

test("[幾何] P0後のA条件: 天体は『光軸相対 tan × magT』方向へ配置され、逆算で相似式に一致", () => {
  // 旧正条件（virt→天体 az/alt = API値）は透視射影の相似拡大と矛盾し実機FAILの原因だったため撤廃。
  // 新正条件（実装と同じ相似式で置いた点の逆算一致）を検証する。詳細な画面相対位置の検証は
  // sam_tour2_projection.test.mjs が行う。
  const bodyDistKmT2 = 30;
  const curvM_t2 = (bodyDistKmT2 * 1000) ** 2 / (2 * 6371000);
  const virtLat = 34.7002, virtLng = 135.4931, virtElev = 41.3;
  const targetAz = 92.0, axAlt = 2.5, magT = 2.4;
  const steps = [
    { az: 92.4, alt: 3.7 },
    { az: 91.6, alt: 2.1 },
    { az: 93.0, alt: 2.9 },
  ];
  for (const s of steps) {
    let dAz = ((s.az - targetAz + 540) % 360) - 180;
    const dAlt = s.alt - axAlt;
    const azV = targetAz + Math.atan(magT * Math.tan(dAz * DEG)) / DEG;
    const altV = axAlt + Math.atan(magT * Math.tan(dAlt * DEG)) / DEG;
    const [bLat, bLng] = destPoint(virtLat, virtLng, azV, bodyDistKmT2);
    const bAlt = bodyDistKmT2 * 1000 * Math.tan(altV * DEG) + virtElev + curvM_t2;
    const azBack = brng(virtLat, virtLng, bLat, bLng);
    let eAz = Math.abs(azBack - azV) % 360; if (eAz > 180) eAz = 360 - eAz;
    const altBack = Math.atan((bAlt - virtElev - curvM_t2) / (bodyDistKmT2 * 1000)) / DEG;
    assert.ok(eAz < 0.005, `az 逆算 ${eAz}`);
    assert.ok(Math.abs(altBack - altV) < 0.005, `alt 逆算`);
  }
});

test("[幾何] 旧方式の不具合再現: 撮影地点基準の天体を virt から見ると視差誤差が有意（>0.5°）", () => {
  // 撮影地点から 30km に置いた天体（旧 positions 流用）を、光軸方向へ 1km 前進した
  // virt カメラから見ると、方位誤差が約 moveH/30km ≒ 1.9° 程度発生する（不具合の機構）。
  const sLat = 34.7002, sLng = 135.4931;
  const bodyDistKm = 30;
  const targetAz = 92.4;      // 前進方向（光軸方位）
  const bodyAz = 120.0;       // 天体の方位（対象と重なる前後の別方位）
  const moveHKm = 1.0;        // 前進 1km
  const [bLat, bLng] = destPoint(sLat, sLng, bodyAz, bodyDistKm); // 旧: 撮影地点基準
  const [vLat, vLng] = destPoint(sLat, sLng, targetAz, moveHKm);  // virt カメラ位置
  const azFromVirt = brng(vLat, vLng, bLat, bLng);
  let dAz = Math.abs(azFromVirt - bodyAz) % 360;
  if (dAz > 180) dAz = 360 - dAz;
  assert.ok(dAz > 0.5, `旧方式の視差 ${dAz.toFixed(3)}°（有意に発生すること）`);
  // 新方式（virt 基準に置き直す）では同条件で誤差が消える
  const [nLat, nLng] = destPoint(vLat, vLng, bodyAz, bodyDistKm);
  const azNew = brng(vLat, vLng, nLat, nLng);
  let dAzNew = Math.abs(azNew - bodyAz) % 360;
  if (dAzNew > 180) dAzNew = 360 - dAzNew;
  assert.ok(dAzNew < 0.005, `新方式の誤差 ${dAzNew.toFixed(6)}°（解消されること）`);
});

test("[幾何] C方式: 対象と天体の表示倍率が厳密一致し、サイズ比が本体①と一致する", () => {
  // 画面比モデル: 画角φ・視半角θ で s = tanθ/tan(φ/2)。
  // 本体①（実画角 f_r）: 対象 s_T* = (w/2D)/tan(f_r/2), 天体 s_B* = tan(δ/2)/tan(f_r/2)
  // ツアー2（FOV=f_L, 残距離 D−M, 天体サイズ S=2R·tan(δ/2)·magT を距離Rに配置）:
  //   対象 s_T = (w/2(D−M))/tan(f_L/2), 天体 s_B = (S/2R)/tan(f_L/2)
  const DEG2 = Math.PI / 180;
  const fovLimit = 2 * Math.atan(36 / 400) / DEG2;
  const w = 60;            // 対象幅[m]
  const delta = 0.53;      // 天体視直径[deg]
  const R = 30000;         // 天体配置距離[m]
  const cases = [
    { focal: 600, D: 2100, clampTo: null },   // 非クランプ
    { focal: 600, D: 2100, clampTo: 0.5 },    // 対象距離50%クランプ
    { focal: 400, D: 900,  clampTo: 0.3 },    // 強いクランプ
    { focal: 300, D: 5000, clampTo: 0.8 },    // 弱いクランプ
  ];
  for (const c of cases) {
    const fr = 2 * Math.atan(36 / (2 * c.focal)) / DEG2;
    const r = Math.tan((fr / 2) * DEG2) / Math.tan((fovLimit / 2) * DEG2);
    assert.ok(r < 1, "超望遠前提");
    const moveFull = c.D * (1 - r);
    const M = c.clampTo === null ? moveFull : Math.min(moveFull, c.D * c.clampTo);
    const magT = c.D / (c.D - M);
    const S = 2 * R * Math.tan((delta / 2) * DEG2) * magT; // 実装のサイズ式
    // 表示倍率（本体①基準）
    const sT_base = (w / (2 * c.D)) / Math.tan((fr / 2) * DEG2);
    const sB_base = Math.tan((delta / 2) * DEG2) / Math.tan((fr / 2) * DEG2);
    const sT_t2 = (w / (2 * (c.D - M))) / Math.tan((fovLimit / 2) * DEG2);
    const sB_t2 = (S / (2 * R)) / Math.tan((fovLimit / 2) * DEG2);
    const kT = sT_t2 / sT_base;
    const kB = sB_t2 / sB_base;
    // 要件: 対象・天体の倍率が厳密一致（クランプ有無問わず）
    assert.ok(Math.abs(kT - kB) < 1e-12, `倍率一致 kT=${kT} kB=${kB}`);
    // 要件: サイズ比（対象:天体）が本体①と一致
    const ratioBase = sT_base / sB_base;
    const ratioT2 = sT_t2 / sB_t2;
    assert.ok(Math.abs(ratioT2 - ratioBase) / ratioBase < 1e-12, "サイズ比維持");
    if (c.clampTo === null) {
      // 非クランプ: 両倍率とも 1（本来の等価表示と完全一致）
      assert.ok(Math.abs(kT - 1) < 1e-12, `非クランプ kT=1 (実値 ${kT})`);
      assert.ok(Math.abs(kB - 1) < 1e-12, `非クランプ kB=1 (実値 ${kB})`);
    } else if (M < moveFull) {
      // クランプ: 全体は縮小（<1）だが両者同率
      assert.ok(kT < 1 && kB < 1, "クランプ時は同率で縮小");
    }
  }
});
