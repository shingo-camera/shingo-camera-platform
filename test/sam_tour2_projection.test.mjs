/**
 * P0回帰: Tour2 等価ズームの「画面上の相対位置・重なり判定」検証（GE Camera semantics）。
 *
 * 経緯:
 * - rev18: 「virt→天体の方位・高度=API値」→ 透視射影の光軸相似（×magT）と矛盾し実機FAIL
 *   （対象だけ拡大され太陽へ深く食い込む。相対誤差≈太陽径の数倍）。
 * - rev19: 光軸相対tan×magT で大ズレは解消。しかし実機で小残差
 *   （Tour1=先端と太陽下端に僅かな隙間 / Tour2=ほぼ接触）が残った。
 *   原因: GEは地球曲率で描画し、距離dの地物は見かけ仰角が d/(2R) rad 沈む。
 *   沈み込みは d に比例し相似（×magT）に従わないため、残差 (magT·d1−d2)/(2R)
 *   （実機相当で太陽視直径の5〜15%）が対象側にのみ生じる。
 * - rev20: 垂直方向を「両カメラから見た対象頂部の実方向（曲率込み・純幾何）」に
 *   アンカーした相似 tan(altV−ax)=tan(e2−ax)+magT·(tan(alt−ax)−tan(e1−ax)) へ修正。
 *   曲率→0 で rev19 式に厳密還元。経験的補正値なし。
 *
 * 本テストは GE semantics（透視射影=光軸相対tan・曲率込み地物描画・屈折なし）を再現し、
 * 対象「上端」×天体「下端」の screen-space gap まで Tour1/Tour2 で一致すること
 * （=重なり/接触判定が変わらないこと）を固定する。旧2方式のFAILも固定する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("public/apps/sun-and-moon/index.html", "utf8");
const DEG = Math.PI / 180;
const R = 6371000;
const fovLimit = 2 * Math.atan(36 / 400) / DEG;
const delta = 0.53; // 天体視直径[deg]

// ---- 実装ファイルに頂部アンカー相似の式が存在すること ----
test("[P0] 実装は頂部アンカー相似（曲率込み・純幾何）で天体を配置している", () => {
  assert.match(html, /const magT = \(virtRatio<1\) \? \(dist3dM\/\(dist3dM - virtMoveM\)\) : 1;/);
  assert.match(html, /const anchorE1=Math\.atan\(\(targetTopAlt-camElev\)\/_d1m-_d1m\/\(2\*6371000\)\);/);
  assert.match(html, /const anchorE2=Math\.atan\(\(targetTopAlt-virtElev\)\/_d2m-_d2m\/\(2\*6371000\)\);/);
  assert.match(html, /const tipTan1=Math\.tan\(anchorE1-_axRad\), tipTan2=Math\.tan\(anchorE2-_axRad\);/);
  assert.match(html, /const yTan=tipTan2\+magT\*\(Math\.tan\(dAlt\*Math\.PI\/180\)-tipTan1\);/);
  assert.match(html, /const altV=alphaCam_t1\+Math\.atan\(yTan\)\*180\/Math\.PI;/);
  assert.match(html, /const azV=targetAz\+Math\.atan\(magT\*Math\.tan\(dAz\*Math\.PI\/180\)\)\*180\/Math\.PI;/);
  assert.equal((html.match(/const magT =/g) || []).length, 1, "magT 定義は一箇所");
  // 旧2方式の残骸なし
  assert.ok(!html.includes("destPoint(virtLat,virtLng,s_.az,bodyDistKmT2)"), "rev18式(据え置き)なし");
  assert.ok(!/const altV=alphaCam_t1\+Math\.atan\(magT\*Math\.tan\(dAlt/.test(html), "rev19式(非アンカー)なし");
});

// ---- GE semantics モデル ----
// 地物（対象頂部）の見かけ仰角: 曲率込み・屈折なし
const tipElev = (topAlt, camElev, d) => Math.atan((topAlt - camElev) / d - d / (2 * R)) / DEG;
// 画面座標 = 光軸相対角の tan
const scrY = (altDeg, axDeg) => Math.tan((altDeg - axDeg) * DEG);
const scrX = (azDeg, axAzDeg) => Math.tan(((((azDeg - axAzDeg) + 540) % 360) - 180) * DEG);

// ケース生成（焦点×距離×天体ズレ×クランプ）
function makeCase(focal, distKm, off, clampTo) {
  const fovReal = 2 * Math.atan(36 / (2 * focal)) / DEG;
  const r = Math.tan((fovReal / 2) * DEG) / Math.tan((fovLimit / 2) * DEG);
  if (r >= 1) return null;
  const d1 = distKm * 1000, camElev = 250, dh = 100, topAlt = camElev + dh;
  const targetAz = 270;
  const vaTopPl = Math.atan(dh / d1) / DEG;
  const ax = vaTopPl - 0.9;
  const D3 = Math.hypot(d1, dh);
  const moveFull = D3 * (1 - r);
  const M = clampTo === null ? Math.min(moveFull, D3 * 0.5) : Math.min(moveFull, D3 * clampTo);
  const magT = D3 / (D3 - M);
  const moveH = M * Math.cos(ax * DEG), moveV = M * Math.sin(ax * DEG);
  const virtElev = camElev + moveV, d2 = d1 - moveH;
  const e1 = tipElev(topAlt, camElev, d1), e2 = tipElev(topAlt, virtElev, d2);
  const bodyAz = targetAz + off.dAz, bodyAlt = vaTopPl + off.dAlt;
  return { d1, d2, camElev, topAlt, targetAz, ax, magT, virtElev, e1, e2, bodyAz, bodyAlt, moveFull, M };
}

// 実装ミラー: rev20（アンカー）/ rev19（非アンカー）/ rev18（据え置き）の天体高度
function bodyAlt2_rev20(c) {
  const t1 = Math.tan((c.e1 - c.ax) * DEG), t2 = Math.tan((c.e2 - c.ax) * DEG);
  const y = t2 + c.magT * (Math.tan((c.bodyAlt - c.ax) * DEG) - t1);
  return c.ax + Math.atan(y) / DEG;
}
const bodyAlt2_rev19 = (c) => c.ax + Math.atan(c.magT * Math.tan((c.bodyAlt - c.ax) * DEG)) / DEG;
const bodyAlt2_rev18 = (c) => c.bodyAlt;

// 正規化gap（頂部×天体下端。太陽径基準）: Tour1は視半径δ/2、Tour2は atan(magT·tan(δ/2))
function gaps(c, alt2fn) {
  const tHalf = Math.tan((delta / 2) * DEG);
  const bot1 = scrY(c.bodyAlt - delta / 2, c.ax);
  const tip1 = scrY(c.e1, c.ax);
  const g1 = (bot1 - tip1) / (2 * tHalf);
  const alt2 = alt2fn(c);
  const rad2 = Math.atan(c.magT * tHalf) / DEG;
  const bot2 = scrY(alt2 - rad2, c.ax);
  const tip2 = scrY(c.e2, c.ax);
  const g2 = (bot2 - tip2) / (2 * c.magT * tHalf);
  return { g1, g2 };
}

const CASES = [];
for (const focal of [300, 600, 1000, 1200])
  for (const distKm of [0.9, 2.1, 4.0, 9.0, 12.0])
    for (const off of [
      { dAz: 0.0, dAlt: 0.33, name: "垂直" },
      { dAz: 0.4, dAlt: 0.33, name: "斜め" },
      { dAz: 0.3, dAlt: -0.35, name: "下側" },
    ])
      for (const clampTo of [null, 0.3]) {
        const c = makeCase(focal, distKm, off, clampTo);
        if (c) CASES.push({ ...c, tag: `f=${focal} d=${distKm} ${off.name} clamp=${clampTo}` });
      }

test("[P0] rev20: 対象上端×天体下端のgapがTour1/Tour2で一致し、天体中心は頂部アンカー相似（全ケース）", () => {
  for (const c of CASES) {
    // 中心の相対（頂部基準）: アンカー式は構成的に厳密
    const relY1 = scrY(c.bodyAlt, c.ax) - scrY(c.e1, c.ax);
    const relY2 = scrY(bodyAlt2_rev20(c), c.ax) - scrY(c.e2, c.ax);
    assert.ok(Math.abs(relY2 - c.magT * relY1) < 1e-9, `${c.tag}: 中心相対(垂直)`);
    const relX1 = scrX(c.bodyAz, c.targetAz);
    const az2 = c.targetAz + Math.atan(c.magT * Math.tan(scrX(c.bodyAz, c.targetAz) === 0 ? 0 : ((c.bodyAz - c.targetAz) * DEG))) / DEG;
    assert.ok(Math.abs(scrX(az2, c.targetAz) - c.magT * relX1) < 1e-9, `${c.tag}: 中心相対(水平)`);
    // gap（上端×下端）: S1二次項のみ許容（<0.3%太陽径）
    const { g1, g2 } = gaps(c, bodyAlt2_rev20);
    assert.ok(Math.abs(g2 - g1) < 0.003, `${c.tag}: gap維持 g1=${g1.toFixed(4)} g2=${g2.toFixed(4)}`);
  }
});

test("[P0] 旧方式のFAIL固定: rev19は曲率残差(magT·d1−d2)/2R・rev18はさらに大", () => {
  for (const c of CASES) {
    const theory = ((c.magT * c.d1 - c.d2) / (2 * R)) / DEG / delta; // 太陽径比の理論欠損（中心）
    // 中心の相対欠損 = magT·rel1 − rel2 は理論式 (magT·d1−d2)/2R と厳密対応
    const relY1 = scrY(c.bodyAlt, c.ax) - scrY(c.e1, c.ax);
    const relY2 = scrY(bodyAlt2_rev19(c), c.ax) - scrY(c.e2, c.ax);
    const deficitC = Math.atan(c.magT * relY1 - relY2) / DEG / delta;
    assert.ok(Math.abs(deficitC - theory) < 0.001, `${c.tag}: rev19中心欠損 ${deficitC.toFixed(4)} vs 理論 ${theory.toFixed(4)}`);
    // gap（上端×下端）でも曲率が効く条件では有意に検出＝rev19なら本テストはFAILしていた
    const { g1, g2 } = gaps(c, bodyAlt2_rev19);
    const deficit = g1 - g2;
    if (theory > 0.02) assert.ok(deficit > 0.01, `${c.tag}: rev19はgapでも有意にFAIL`);
    // rev18（据え置き）はさらに大きくズレる（垂直ズレありケース）
    const g18 = gaps(c, bodyAlt2_rev18).g2;
    if (Math.abs(c.bodyAlt - c.ax) > 0.5) {
      assert.ok(Math.abs(g18 - g1) > Math.abs(deficit), `${c.tag}: rev18はrev19より大`);
    }
  }
});

test("[P0] 実機18:31:40相当: Tour1の僅かな隙間がTour2でも維持され、接触判定が変わらない", () => {
  // Tour1: 先端と太陽下端に隙間（gap≈+0.15太陽径）となる構図。1000mm・9km・50%クランプ(magT=2)
  const c = makeCase(1000, 9.0, { dAz: 0.15, dAlt: 0.265 + 0.53 * 0.15 }, null);
  const { g1, g2 } = gaps(c, bodyAlt2_rev20);
  assert.ok(g1 > 0.05 && g1 < 0.35, `Tour1に隙間 g1=${g1.toFixed(4)}`);
  // rev20: 隙間維持（接触しない）
  assert.ok(g2 > 0, `rev20: Tour2でも隙間維持 g2=${g2.toFixed(4)}`);
  assert.ok(Math.abs(g2 - g1) < 0.003, "rev20: gap一致");
  // rev19: 曲率残差(≈11.6%太陽径)で隙間がほぼ消える/反転し得る＝実機の「ほぼ接触」を再現
  const g2o = gaps(c, bodyAlt2_rev19).g2;
  // 中心角度では11.5%太陽径の欠損（=実機の隙間消失）。gap正規化(tan)では約5.8%として現れる。
  assert.ok(g1 - g2o > 0.04, `rev19: 隙間が大幅減 ${g1.toFixed(3)}→${g2o.toFixed(3)}（実機症状の再現）`);
  const relY1 = scrY(c.bodyAlt, c.ax) - scrY(c.e1, c.ax);
  const relY2o = scrY(bodyAlt2_rev19(c), c.ax) - scrY(c.e2, c.ax);
  const centerDefPct = Math.atan(c.magT * relY1 - relY2o) / DEG / delta * 100;
  assert.ok(centerDefPct > 10 && centerDefPct < 13, `rev19中心欠損は実機観測レンジ（${centerDefPct.toFixed(1)}%太陽径）`);
});

test("[P0] 連続性: 曲率→0 でアンカー式は rev19 式（tan×magT）に厳密還元", () => {
  const c = makeCase(600, 4.0, { dAz: 0.2, dAlt: 0.3 }, null);
  // 曲率を除いた e1/e2（平面）で同式を評価
  const e1p = Math.atan((c.topAlt - c.camElev) / c.d1) / DEG;
  const e2p = Math.atan((c.topAlt - c.virtElev) / c.d2) / DEG;
  const t1 = Math.tan((e1p - c.ax) * DEG), t2 = Math.tan((e2p - c.ax) * DEG);
  const yAnchor = t2 + c.magT * (Math.tan((c.bodyAlt - c.ax) * DEG) - t1);
  const yPlain = c.magT * Math.tan((c.bodyAlt - c.ax) * DEG);
  // 平面では tip も厳密相似（t2=magT·t1、D基準の微小項のみ）→ 差は 1e-4 未満
  assert.ok(Math.abs(yAnchor - yPlain) < 1e-4, `連続性 差=${Math.abs(yAnchor - yPlain)}`);
});
