/**
 * Phase D characterization: riseTime/windFollowRatio の client 補完を削除しても
 * **撮影結果（scene result）が変わらない**ことを、server seed 解決で固定する。
 *
 * データ構造の一致（numTable に field があるか）と、撮影結果に必要な計算結果の一致を分けて検証する。
 * ここでは後者（scene result）を正本とする。
 *
 * ケース（§3 A〜E）:
 *  A. 旧 export に riseTime/windFollowRatio が明示的に存在 → その値が使われる（ユーザーデータ優先）
 *  B. 旧 export に無い → server seed で解決（client 補完の有無で結果不変）
 *  C. fresh default（公開 num/height/dia のみ）→ server seed で同じ結果
 *  D. localStorage 相当（field あり）→ 結果不変
 *  E. wind 有無・複数号数でも一致
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveScene } from "./_bundle/hanabi_scene.mjs";
import { NUM_TABLE_SEED } from "./_bundle/hanabi_calc.mjs";

// 公開 default（num/height/dia のみ。riseTime/windFollowRatio を持たない）
const PUBLIC_DEFAULT = NUM_TABLE_SEED.map((r) => ({ num: r.num, height: r.height, dia: r.dia }));

function req(numTable, wind = null) {
  return {
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal: 100, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: [
      { id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: ["3", "5", "10"], enabled: true, ougiAz: 30, kunitomoNums: { "5": 5 } },
    ],
    targets: [], numTable, selectedTubeId: "T1", wind,
  };
}

// scene result から撮影結果に必要な数値だけを取り出す（データ構造でなく計算結果を比較）
function burstDigest(res) {
  const out = [];
  for (const tb of res.tubes) {
    for (const b of tb.bursts) out.push([tb.id, "burst", b.num, b.fwAzDeg, b.fwAltDeg, b.fwDkm, b.diaM, b.hasWind]);
    for (const o of tb.ougi) out.push([tb.id, "ougi", o.horzDeg, o.fwAzDeg, o.fwAltDeg, o.fwDkm]);
    for (const k of tb.kunitomo) out.push([tb.id, "kuni", k.num, k.horzDeg, k.fwAzDeg, k.fwAltDeg, k.fwDkm]);
    for (const k of tb.kmlKunitomo) out.push([tb.id, "kmlkuni", k.num, k.horzDeg, k.lat, k.lng, k.alt]);
  }
  return out;
}
function assertDigestEqual(a, b, msg) {
  assert.equal(a.length, b.length, msg + " length");
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[i].length; j++) {
      const x = a[i][j], y = b[i][j];
      if (typeof x === "number" && typeof y === "number") assert.ok(Math.abs(x - y) < 1e-12, `${msg} [${i}][${j}] ${x} vs ${y}`);
      else assert.equal(x, y, `${msg} [${i}][${j}]`);
    }
  }
}

// 完全な内部 field 付き numTable（旧 client 補完後 / user データ相当）
const FULL = NUM_TABLE_SEED.map((r) => ({ num: r.num, height: r.height, dia: r.dia, riseTime: r.riseTime, windFollowRatio: r.windFollowRatio }));

for (const wind of [null, { dirDeg: 45, speed: 8 }]) {
  const wl = wind ? "風あり" : "無風";

  test(`[phaseD] B/C: 内部 field 無し(公開default)でも full と scene result 一致 (${wl})`, () => {
    // 公開 default（field 無し）→ server seed 解決 と、full（field 有り）→ user データ が一致する
    // （seed 値 == default 値のため。client 補完の有無で結果不変）
    const withFull = solveScene(req(FULL, wind));
    const withPublic = solveScene(req(PUBLIC_DEFAULT, wind));
    assertDigestEqual(burstDigest(withPublic), burstDigest(withFull), `public-default vs full (${wl})`);
  });

  test(`[phaseD] A: ユーザー明示値(seedと異なる)は優先される (${wl})`, () => {
    // ユーザーが編集した riseTime/windFollowRatio（seed と異なる値）が使われることを固定
    const custom = FULL.map((r) => (r.num === "5" ? { ...r, riseTime: r.riseTime + 2, windFollowRatio: 0.5 } : r));
    const resCustom = solveScene(req(custom, wind));
    const resSeed = solveScene(req(FULL, wind));
    // num=5 の burst は異なるはず（ユーザー値が効いている）
    const bCustom = resCustom.tubes[0].bursts.find((b) => b.num === "5");
    const bSeed = resSeed.tubes[0].bursts.find((b) => b.num === "5");
    if (wind) {
      assert.ok(bCustom.fwAzDeg !== bSeed.fwAzDeg || bCustom.fwDkm !== bSeed.fwDkm, "ユーザー値で風ドリフトが変わる");
    }
    // num=3（未編集）は一致
    const b3c = resCustom.tubes[0].bursts.find((b) => b.num === "3");
    const b3s = resSeed.tubes[0].bursts.find((b) => b.num === "3");
    assert.ok(Math.abs(b3c.fwAzDeg - b3s.fwAzDeg) < 1e-12, "未編集号数は一致");
  });
}

test("[phaseD] 部分的に field 欠落した混在 numTable でも full と一致", () => {
  // 一部の行だけ field あり・他は無し（旧データ混在）→ 全行 full と scene result 一致
  const mixed = NUM_TABLE_SEED.map((r, i) =>
    i % 2 === 0 ? { num: r.num, height: r.height, dia: r.dia } : { num: r.num, height: r.height, dia: r.dia, riseTime: r.riseTime, windFollowRatio: r.windFollowRatio },
  );
  const wind = { dirDeg: 120, speed: 10 };
  assertDigestEqual(burstDigest(solveScene(req(mixed, wind))), burstDigest(solveScene(req(FULL, wind))), "mixed vs full");
});

/* ============================================================
 * 部分欠落 field 単位 fallback parity（STEP 1 P0）
 * 正本 = 統合前 HANABI の loadDB/importData の field 独立補完:
 *   riseTime 欠落 → seed.riseTime（seed 無→7） / windFollowRatio 欠落 → seed.windFollowRatio（seed 無→0.8）
 * 旧 client は row を補完してから calcWindOffset へ渡していたため、明示 field は維持・欠落 field だけ seed。
 * この「補完済み full row」を作って solveScene へ渡した結果を正本とし、
 * 部分欠落 row を渡した現行 server の結果と一致することを固定する。
 * ============================================================ */

const SEED_BY_NUM = new Map(NUM_TABLE_SEED.map((r) => [r.num, r]));
// 統合前 HANABI の field 独立補完を再現（欠落 field だけ seed / seed 無しは 7 / 0.8）
function oldClientResolveRow(row) {
  const seed = SEED_BY_NUM.get(row.num);
  const riseTime = row.riseTime !== undefined ? row.riseTime : seed ? seed.riseTime : 7;
  const windFollowRatio = row.windFollowRatio !== undefined ? row.windFollowRatio : seed ? seed.windFollowRatio : 0.8;
  return { ...row, riseTime, windFollowRatio };
}
function reqNum(numTable, wind, tbOver = {}) {
  return {
    viewpoint: { manual: true, lat: 34.68, lng: 135.5, elev: 10, tripodH: 150, elevOffset: 0 },
    camera: { focal: 100, sensor: { w: 36, h: 24 }, compMode: "land", azOffset: 0, elOffset: 0 },
    festivalTubes: [{ id: "T1", festivalId: "F", lat: 34.7, lng: 135.52, elev: 5, elevOffset: 0, nums: numTable.map((r) => r.num), enabled: true, ougiAz: 30, kunitomoNums: { "5": 5 } }],
    targets: [], numTable, selectedTubeId: "T1", wind,
  };
}
// 部分欠落 numTable と、旧 client 補完済み numTable で scene result が一致することを固定
function assertOldParity(name, partialTable, wind) {
  const oldResolved = partialTable.map(oldClientResolveRow); // 統合前 HANABI 正本
  const resOld = solveScene(reqNum(oldResolved, wind));
  const resNew = solveScene(reqNum(partialTable, wind)); // 現行 server（部分欠落を field 単位で解決）
  assertDigestEqual(burstDigest(resNew), burstDigest(resOld), name);
}

// 既知号数の代表行（seed に存在する num=5: riseTime 6.76 / windFollowRatio 0.85）
const BASE5 = { num: "5", height: 224, dia: 170 };
const seed5 = SEED_BY_NUM.get("5");

for (const wind of [{ dirDeg: 45, speed: 8 }, { dirDeg: 200, speed: 12 }]) {
  const wl = `風${wind.dirDeg}/${wind.speed}`;

  // A. riseTime あり / windFollowRatio あり → 両方ユーザー値維持
  test(`[phaseD-P0] A both present → 両方ユーザー値維持 (${wl})`, () => {
    assertOldParity("A", [{ ...BASE5, riseTime: 9.0, windFollowRatio: 0.5 }], wind);
  });

  // B. 両方欠落 → 両方 seed
  test(`[phaseD-P0] B both absent → 両方 seed (${wl})`, () => {
    assertOldParity("B", [{ ...BASE5 }], wind);
  });

  // C. riseTime あり / windFollowRatio 欠落 → riseTime ユーザー値・windFollowRatio だけ seed
  test(`[phaseD-P0] C riseTime有/windFollowRatio欠落 → wFR だけ seed (${wl})`, () => {
    assertOldParity("C", [{ ...BASE5, riseTime: 9.0 }], wind);
    // 直接確認: windFollowRatio が seed(0.85) で解決され、0.8 ではないこと
    const res = solveScene(reqNum([{ ...BASE5, riseTime: 9.0 }], wind));
    const ref08 = solveScene(reqNum([{ ...BASE5, riseTime: 9.0, windFollowRatio: 0.8 }], wind));
    const refSeed = solveScene(reqNum([{ ...BASE5, riseTime: 9.0, windFollowRatio: seed5.windFollowRatio }], wind));
    const b = (r) => r.tubes[0].bursts.find((x) => x.num === "5");
    assert.ok(Math.abs(b(res).fwAzDeg - b(refSeed).fwAzDeg) < 1e-12, "wFR は seed 値で解決");
    if (seed5.windFollowRatio !== 0.8) assert.ok(Math.abs(b(res).fwAzDeg - b(ref08).fwAzDeg) > 1e-13, "0.8 ではない（旧バグでない）");
  });

  // D. riseTime 欠落 / windFollowRatio あり → riseTime だけ seed・windFollowRatio ユーザー値保持
  test(`[phaseD-P0] D riseTime欠落/windFollowRatio有 → wFR ユーザー値保持 (${wl})`, () => {
    assertOldParity("D", [{ ...BASE5, windFollowRatio: 0.5 }], wind);
    // 直接確認: windFollowRatio=0.5(ユーザー値) が保持され、seed(0.85) に置換されないこと
    const res = solveScene(reqNum([{ ...BASE5, windFollowRatio: 0.5 }], wind));
    const refUser = solveScene(reqNum([{ ...BASE5, riseTime: seed5.riseTime, windFollowRatio: 0.5 }], wind));
    const refSeed = solveScene(reqNum([{ ...BASE5, riseTime: seed5.riseTime, windFollowRatio: seed5.windFollowRatio }], wind));
    const b = (r) => r.tubes[0].bursts.find((x) => x.num === "5");
    assert.ok(Math.abs(b(res).fwAzDeg - b(refUser).fwAzDeg) < 1e-12, "wFR=0.5 が保持される");
    assert.ok(Math.abs(b(res).fwAzDeg - b(refSeed).fwAzDeg) > 1e-13, "seed(0.85) に置換されていない");
  });

  // E. seed に存在しない未知号数 → riseTime=7 / windFollowRatio=0.8
  test(`[phaseD-P0] E 未知号数 → riseTime=7/wFR=0.8 fallback (${wl})`, () => {
    const unknown = [{ num: "99", height: 300, dia: 250 }];
    assertOldParity("E", unknown, wind);
    const res = solveScene(reqNum(unknown, wind));
    const ref = solveScene(reqNum([{ num: "99", height: 300, dia: 250, riseTime: 7, windFollowRatio: 0.8 }], wind));
    const b = (r) => r.tubes[0].bursts.find((x) => x.num === "99");
    assert.ok(Math.abs(b(res).fwAzDeg - b(ref).fwAzDeg) < 1e-12, "未知号数は 7/0.8");
  });
}

test("[phaseD-P0] 混在テーブル（各号数で欠落パターンが異なる）でも旧 client と一致", () => {
  const mixed = [
    { num: "3", height: 132, dia: 60, riseTime: 5.19, windFollowRatio: 0.85 }, // A
    { num: "5", height: 224, dia: 170 }, // B
    { num: "8", height: 336, dia: 280, riseTime: 8.28 }, // C
    { num: "10", height: 394, dia: 320, windFollowRatio: 0.5 }, // D
  ];
  assertOldParity("mixed", mixed, { dirDeg: 120, speed: 10 });
});
