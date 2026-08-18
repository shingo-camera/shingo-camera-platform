/**
 * P0: 旧 HANABI export → 新 Platform 版 HANABI import のデータ後方互換テスト。
 *
 * 指示（最重要要件）:
 * - 旧 HANABI でexportしたデータを、新 HANABI が「そのまま import できる」こと。
 * - 「例外なく終わった」だけでは不十分。主要保存データ（festivals/tubes/targets/numTable/ougi/pins）の
 *   値まで比較する。
 * - 欠落フィールドへの後方互換挙動（ougi/kunitomo/topWidth/riseTime/windFollowRatio 等の補完）を検証。
 * - malformed import は拒否される。
 *
 * ドリフト防止:
 * - テスト用にロジックを写経せず、実成果物 public/apps/hanabi/index.html から
 *   exportData / importData / DEFAULT_NUM_TABLE / DEFAULT_OUGI を「実コードのまま抽出」して評価する。
 *   これにより実装が変わればテストも追随し、写経による乖離を防ぐ。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const HTML = readFileSync("public/apps/hanabi/index.html", "utf8");

/* ---- 実ファイルから対象コードを抽出（写経しない） ---- */
function extractFunction(src, name) {
  // "function NAME(" から、対応する最上位の閉じ括弧までを素朴に抽出する。
  const marker = "function " + name + "(";
  const start = src.indexOf(marker);
  assert.ok(start >= 0, "関数が実ファイルに存在する: " + name);
  // 本体開始 '{' を探す
  const braceOpen = src.indexOf("{", start);
  assert.ok(braceOpen > start, name + " の本体開始 { が見つかる");
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("関数の終端が見つからない: " + name);
}

function extractConst(src, name) {
  const marker = "const " + name + " =";
  const start = src.indexOf(marker);
  assert.ok(start >= 0, "定数が実ファイルに存在する: " + name);
  // 定数定義は行末 ; まで、または配列/オブジェクトの対応閉じ括弧まで。
  // DEFAULT_NUM_TABLE は複数行配列、DEFAULT_OUGI は1行。素朴に括弧バランスで終端を取る。
  let i = src.indexOf("=", start) + 1;
  // 先頭の空白をスキップ
  while (i < src.length && /\s/.test(src[i])) i++;
  const openCh = src[i];
  if (openCh === "[" || openCh === "{") {
    const closeCh = openCh === "[" ? "]" : "}";
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === openCh) depth++;
      else if (src[j] === closeCh) {
        depth--;
        if (depth === 0) return src.slice(start, j + 1) + ";";
      }
    }
  } else {
    const semi = src.indexOf(";", start);
    return src.slice(start, semi + 1);
  }
  throw new Error("定数の終端が見つからない: " + name);
}

const exportSrc = extractFunction(HTML, "exportData");
const importSrc = extractFunction(HTML, "importData");
const numTableSrc = extractConst(HTML, "DEFAULT_NUM_TABLE");
const ougiSrc = extractConst(HTML, "DEFAULT_OUGI");

/* ---- 抽出コードを実行するサンドボックス（DOM/UI はスタブ、データ層は本物の挙動） ---- */
function makeSandbox(initialDb) {
  const areaValues = {
    "data-transfer-area-modal": "",
    "data-transfer-area-settings": "",
  };
  const store = {}; // localStorage スタブ（pins 用）
  const alerts = [];
  const sandbox = {
    // データ層
    db: initialDb,
    // pins は localStorage 経由（実装同様）。PIN_KEY は実装の 'hanabiPlannerPins_v1'。
    loadPins() {
      try { return JSON.parse(store["hanabiPlannerPins_v1"] || "[]"); } catch (e) { return []; }
    },
    savePins(p) {
      try { store["hanabiPlannerPins_v1"] = JSON.stringify(p); } catch (e) { /* noop */ }
    },
    saveDB() {
      try { store["hanabiPlanner"] = JSON.stringify(sandbox.db); } catch (e) { /* noop */ }
    },
    // UI 更新は no-op（データ比較には不要）
    buildNumTableModal() {},
    refreshFestivalSelects() {},
    refreshTargetSelects() {},
    refreshTubeSelect() {},
    refreshMobDrawerSelects() {},
    refreshMapMarkers() {},
    // ダイアログ
    alert(m) { alerts.push(String(m)); },
    confirm() { return true; }, // import は confirm 上書きを常に承諾
    // DOM
    document: {
      getElementById(id) {
        if (id in areaValues) {
          return {
            get value() { return areaValues[id]; },
            set value(v) { areaValues[id] = v; },
            select() {},
          };
        }
        return null;
      },
      execCommand() { return true; },
    },
    JSON,
    Array,
    console,
    __areaValues: areaValues,
    __alerts: alerts,
    __store: store,
  };
  return sandbox;
}

function buildContext(initialDb) {
  const sandbox = makeSandbox(initialDb);
  const ctx = vm.createContext(sandbox);
  // 定数と関数を評価してコンテキストへ載せる。
  vm.runInContext(numTableSrc + "\n" + ougiSrc + "\n" + exportSrc + "\n" + importSrc, ctx);
  return { ctx, sandbox };
}

/* ---- 現実的な旧 export fixture（複数フィールド・pins 含む） ---- */
function makeOldExportFixture() {
  return {
    festivals: [
      { id: 1, name: "○○花火大会", memo: "河川敷" },
      { id: 2, name: "△△祭り", memo: "" },
    ],
    tubes: [
      // 旧データ: ougi 系・kunitomo 系・enabled が欠落しているケース（後方互換の要）
      { id: 10, festivalId: 1, name: "第一筒場", lat: 34.6851, lng: 135.5030, nums: ["5", "10"] },
      { id: 11, festivalId: 1, name: "第二筒場", lat: 34.6900, lng: 135.5100, nums: ["3"], ougi: false, ougiAz: 45 },
    ],
    targets: [
      // 旧データ: topWidth が欠落
      { id: 20, name: "被写体A", lat: 34.6800, lng: 135.5200, height: 30 },
    ],
    // 旧データ: numTable の一部 row に riseTime / windFollowRatio が欠落
    numTable: [
      { num: "5", height: 224, dia: 170 },
      { num: "10", height: 394, dia: 320, riseTime: 8.97, windFollowRatio: 0.81 },
    ],
    ougi: { height: 90 },
    pins: [
      { name: "計画1", lat: 34.6851, lng: 135.5030, elev: 5 },
    ],
  };
}

/* ============================ テスト ============================ */

test("[P0] 旧 export を新 import → 主要フィールドの値が一致する", () => {
  const fixture = makeOldExportFixture();
  const db0 = { festivals: [], tubes: [], targets: [], numTable: [], ougi: {} };
  const { ctx, sandbox } = buildContext(db0);

  // import 対象テキストをテキストエリアへセットして importData を実行
  sandbox.__areaValues["data-transfer-area-modal"] = JSON.stringify(fixture);
  vm.runInContext("importData();", ctx);

  const db = sandbox.db;
  // festivals: 完全一致
  assert.deepEqual(db.festivals, fixture.festivals, "festivals の値が一致");
  // targets: 主要フィールド一致（topWidth はデフォルト補完される）
  assert.equal(db.targets.length, 1);
  assert.equal(db.targets[0].id, 20);
  assert.equal(db.targets[0].name, "被写体A");
  assert.equal(db.targets[0].lat, 34.6800);
  assert.equal(db.targets[0].lng, 135.5200);
  assert.equal(db.targets[0].height, 30);
  // tubes: 主要フィールド一致
  assert.equal(db.tubes.length, 2);
  assert.equal(db.tubes[0].id, 10);
  assert.equal(db.tubes[0].name, "第一筒場");
  assert.deepEqual(db.tubes[0].nums, ["5", "10"]);
  assert.equal(db.tubes[1].ougi, false, "明示された ougi=false は維持される");
  assert.equal(db.tubes[1].ougiAz, 45, "明示された ougiAz は維持される");
  // pins: localStorage 経由で保存され、値一致
  const savedPins = JSON.parse(sandbox.__store["hanabiPlannerPins_v1"]);
  assert.deepEqual(savedPins, fixture.pins, "pins の値が一致");
  // ougi
  assert.deepEqual(db.ougi, { height: 90 });
});

test("[P0] 欠落フィールドは後方互換デフォルトで補完される", () => {
  const fixture = makeOldExportFixture();
  const db0 = { festivals: [], tubes: [], targets: [], numTable: [], ougi: {} };
  const { ctx, sandbox } = buildContext(db0);
  sandbox.__areaValues["data-transfer-area-modal"] = JSON.stringify(fixture);
  vm.runInContext("importData();", ctx);
  const db = sandbox.db;

  // tube[0] は ougi 系欠落 → デフォルト補完
  const t0 = db.tubes[0];
  assert.equal(t0.ougi, true, "ougi 欠落 → true 補完");
  assert.equal(t0.ougiAz, 0, "ougiAz 欠落 → 0 補完");
  assert.equal(t0.kunitomo, false, "kunitomo 欠落 → false 補完");
  assert.equal(t0.kunitomoDirs, 3, "kunitomoDirs 欠落 → 3 補完");
  assert.ok(t0.kunitomoNums && typeof t0.kunitomoNums === "object" && Object.keys(t0.kunitomoNums).length === 0, "kunitomoNums 欠落 → 空オブジェクト補完");
  assert.equal(t0.enabled, true, "enabled 欠落 → true 補完");
  // target topWidth 欠落 → 0 補完
  assert.equal(db.targets[0].topWidth, 0, "topWidth 欠落 → 0 補完");
  // Phase D: numTable の riseTime/windFollowRatio は client 補完しない（server が非公開 seed で解決する）。
  // 欠落行はそのまま欠落のまま保持され、DEFAULT_NUM_TABLE（公開値のみ）にもこれらの field は存在しない。
  const row5 = db.numTable.find((r) => r.num === "5");
  assert.ok(row5, "num=5 の行が存在");
  assert.equal(row5.riseTime, undefined, "riseTime は client 補完されない（欠落のまま）");
  assert.equal(row5.windFollowRatio, undefined, "windFollowRatio は client 補完されない（欠落のまま）");
  // 公開 num/height/dia は保持される
  assert.equal(row5.height, 224, "height（公開値）は保持");
  assert.equal(row5.dia, 170, "dia（公開値）は保持");
});

test("[P0][Phase D] ユーザー明示の riseTime/windFollowRatio は import で保持される（後方互換）", () => {
  const fixture = makeOldExportFixture();
  const db0 = { festivals: [], tubes: [], targets: [], numTable: [], ougi: {} };
  const { ctx, sandbox } = buildContext(db0);
  sandbox.__areaValues["data-transfer-area-modal"] = JSON.stringify(fixture);
  vm.runInContext("importData();", ctx);
  const db = sandbox.db;
  // 旧 export に明示値がある num=10 は、その値がそのまま保持される（削除・拒否しない）
  const row10 = db.numTable.find((r) => r.num === "10");
  assert.ok(row10, "num=10 の行が存在");
  assert.equal(row10.riseTime, 8.97, "ユーザー明示 riseTime を保持");
  assert.equal(row10.windFollowRatio, 0.81, "ユーザー明示 windFollowRatio を保持");
});

test("[P0] numTable / ougi 欠落時はデフォルト一式が使われる", () => {
  const fixture = makeOldExportFixture();
  delete fixture.numTable;
  delete fixture.ougi;
  const db0 = { festivals: [], tubes: [], targets: [], numTable: [], ougi: {} };
  const { ctx, sandbox } = buildContext(db0);
  sandbox.__areaValues["data-transfer-area-modal"] = JSON.stringify(fixture);
  vm.runInContext("importData();", ctx);
  const db = sandbox.db;
  // DEFAULT_NUM_TABLE 相当（11 行）が入る
  assert.equal(db.numTable.length, 11, "numTable 欠落 → DEFAULT_NUM_TABLE(11行) で補完");
  assert.deepEqual(db.ougi, { height: 90 }, "ougi 欠落 → DEFAULT_OUGI で補完");
});

test("[P0] export→import ラウンドトリップで festivals/tubes/targets/pins が保存される", () => {
  // まず db にデータを入れて exportData でシリアライズ
  const seedDb = {
    festivals: [{ id: 1, name: "RT大会", memo: "m" }],
    tubes: [{ id: 5, festivalId: 1, name: "筒A", lat: 35.0, lng: 135.0, nums: ["10"], ougi: true, ougiAz: 10, kunitomo: false, kunitomoDirs: 3, kunitomoNums: {}, enabled: true }],
    targets: [{ id: 9, name: "T", lat: 35.1, lng: 135.1, height: 20, topWidth: 0 }],
    numTable: [{ num: "10", height: 394, dia: 320, riseTime: 8.97, windFollowRatio: 0.81 }],
    ougi: { height: 90 },
  };
  const seedPins = [{ name: "P", lat: 35.0, lng: 135.0, elev: 3 }];
  const { ctx, sandbox } = buildContext(JSON.parse(JSON.stringify(seedDb)));
  sandbox.__store["hanabiPlannerPins_v1"] = JSON.stringify(seedPins);

  vm.runInContext("exportData();", ctx);
  const exported = sandbox.__areaValues["data-transfer-area-modal"];
  assert.ok(exported && exported.length > 0, "export でテキストが生成される");
  const parsed = JSON.parse(exported);
  assert.deepEqual(parsed.festivals, seedDb.festivals);
  assert.deepEqual(parsed.tubes, seedDb.tubes);
  assert.deepEqual(parsed.targets, seedDb.targets);
  assert.deepEqual(parsed.pins, seedPins, "export に pins が含まれる");

  // その export を空 db の別コンテキストへ import して一致を確認
  const db0 = { festivals: [], tubes: [], targets: [], numTable: [], ougi: {} };
  const c2 = buildContext(db0);
  c2.sandbox.__areaValues["data-transfer-area-modal"] = exported;
  vm.runInContext("importData();", c2.ctx);
  assert.deepEqual(c2.sandbox.db.festivals, seedDb.festivals);
  assert.deepEqual(c2.sandbox.db.targets, seedDb.targets);
  assert.equal(c2.sandbox.db.tubes[0].id, 5);
  assert.deepEqual(JSON.parse(c2.sandbox.__store["hanabiPlannerPins_v1"]), seedPins);
});

test("[P0] malformed import（必須キー欠落）は拒否され db を書き換えない", () => {
  const db0 = { festivals: [{ id: 99, name: "keep", memo: "" }], tubes: [], targets: [], numTable: [], ougi: {} };
  const { ctx, sandbox } = buildContext(db0);
  // festivals/tubes/targets のいずれか欠落 → 実装は alert して return
  sandbox.__areaValues["data-transfer-area-modal"] = JSON.stringify({ festivals: [], tubes: [] }); // targets 欠落
  vm.runInContext("importData();", ctx);
  // db は元のまま（上書きされない）
  assert.deepEqual(sandbox.db.festivals, [{ id: 99, name: "keep", memo: "" }], "不正データで db が書き換わらない");
  assert.ok(sandbox.__alerts.some((a) => a.includes("正しくありません")), "形式不正の案内が出る");
});

test("[P0] JSON 破損は例外を捕捉し db を書き換えない", () => {
  const db0 = { festivals: [{ id: 7, name: "keep2", memo: "" }], tubes: [], targets: [], numTable: [], ougi: {} };
  const { ctx, sandbox } = buildContext(db0);
  sandbox.__areaValues["data-transfer-area-modal"] = "{ not valid json ";
  vm.runInContext("importData();", ctx);
  assert.deepEqual(sandbox.db.festivals, [{ id: 7, name: "keep2", memo: "" }], "破損データで db が書き換わらない");
  assert.ok(sandbox.__alerts.some((a) => a.includes("読み込みに失敗")), "読み込み失敗の案内が出る");
});
