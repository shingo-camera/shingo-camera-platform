/**
 * Phase D: public asset 秘匿監査。
 * public/apps/hanabi/ を読んでも HANABI の商品価値を構成する独自計算式・内部係数・内部 seed を
 * 再現できない状態であることを自動で固定する。
 *
 * 一般的な公開データ（num/height/dia、hav/brng/destPoint 等の一般地理計算）は禁止しない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "../public/apps/hanabi");
const files = readdirSync(publicDir).filter((f) => f.endsWith(".html") || f.endsWith(".js"));
const allSrc = files.map((f) => readFileSync(join(publicDir, f), "utf8")).join("\n");

test("[secrecy] public に function elAng の定義が無い", () => {
  assert.ok(!/function\s+elAng\s*\(/.test(allSrc), "elAng 定義が残っていない");
});

test("[secrecy] public に function calcWindOffset の定義が無い", () => {
  assert.ok(!/function\s+calcWindOffset\s*\(/.test(allSrc), "calcWindOffset 定義が残っていない");
});

test("[secrecy] public に WIND_ALT_FACTOR が無い", () => {
  assert.ok(!/WIND_ALT_FACTOR/.test(allSrc), "WIND_ALT_FACTOR が残っていない");
  assert.ok(!/10\s*\/\s*7/.test(allSrc), "10/7 係数が残っていない");
});

test("[secrecy] server 内部 wind seed 値が public default に埋め込まれていない", () => {
  // NUM_TABLE_SEED の代表的な windFollowRatio/riseTime 値が public に無い
  const seedVals = ["0.78", "0.86", "windFollowRatio:0", "windFollowRatio: 0", "riseTime:4.29", "riseTime: 4.29", "riseTime:8.97"];
  for (const v of seedVals) {
    assert.ok(!allSrc.includes(v), `内部 seed 値 "${v}" が public に無い`);
  }
});

test("[secrecy] elAng 独自式（曲率+屈折の内部係数）が public に無い", () => {
  assert.ok(!/k\s*=\s*0\.13/.test(allSrc), "屈折係数 k=0.13 が無い");
  assert.ok(!/terrRefr/.test(allSrc), "terrRefr 変数が無い");
  // curv=d**2/(2*R) 形の曲率式
  assert.ok(!/curv\s*=\s*d\s*\*\*\s*2/.test(allSrc), "曲率式が無い");
});

test("[secrecy] kunitomo 独自放物線式が public に無い", () => {
  assert.ok(!/Math\.sin\(theta\)\s*\*\s*Math\.sin\(theta\)/.test(allSrc), "h=H·sin²θ が無い");
  assert.ok(!/Math\.sin\(theta\)\s*\*\s*Math\.cos\(theta\)\s*\*\s*2/.test(allSrc), "dBase 式が無い");
  assert.ok(!/1\.65/.test(allSrc), "1.65 補正が無い");
});

test("[secrecy] wind 内部モデル説明コメントが public に無い", () => {
  const phrases = ["見せない内部", "自由落下", "Cd=0.44", "620kg", "時定数", "追従率", "上空風"];
  for (const p of phrases) {
    assert.ok(!allSrc.includes(p), `内部モデル説明 "${p}" が無い`);
  }
});

test("[secrecy] 内部パラメータ名・非公開説明コメントが public に再混入していない", () => {
  // riseTime / windFollowRatio という内部パラメータ名は、実行コード（scene payload の property access）
  // 以外＝コメント/説明文字列としては public に残さない。
  // scene payload の property access は許容（互換に必要）: "riseTime: r.riseTime" のような実行コードを除外して監査。
  const withoutPayloadAccess = allSrc
    .replace(/riseTime:\s*r\.riseTime/g, "")
    .replace(/windFollowRatio:\s*r\.windFollowRatio/g, "");
  assert.ok(!/riseTime/.test(withoutPayloadAccess), "riseTime がコメント等に残っていない（scene payload の実行コードを除く）");
  assert.ok(!/windFollowRatio/.test(withoutPayloadAccess), "windFollowRatio がコメント等に残っていない（scene payload の実行コードを除く）");
  // 「非公開内部パラメータ」「見せない内部パラメータ」等の内部実装説明フレーズが無い
  const descPhrases = ["非公開内部パラメータ", "見せない内部パラメータ", "内部パラメータ名", "非公開 seed"];
  for (const p of descPhrases) {
    assert.ok(!allSrc.includes(p), `内部実装説明 "${p}" が public に無い`);
  }
});

test("[secrecy] terrain 独自 sampling 戦略・係数が public に無い", () => {
  // Phase C1 で server 化済み。sampling 戦略・独自定数が public に無い
  assert.ok(!/ridgeSteps/.test(allSrc), "ridge sampling 戦略が無い");
  assert.ok(!/nAzimuths/.test(allSrc), "nAzimuths が無い");
  assert.ok(!/fujiSteps/.test(allSrc), "fuji sampling が無い");
});

test("[secrecy] 一般公開データ（num/height/dia）と一般地理計算は許容（過剰禁止でない）", () => {
  // 公開値・一般計算は存在してよい（誤って全削除していないことの確認）
  assert.ok(/DEFAULT_NUM_TABLE/.test(allSrc), "公開号数テーブルは存在する");
  assert.ok(/height:\s*394|height:394/.test(allSrc), "公開 height 値は存在する");
  assert.ok(/function\s+destPoint|function\s+hav|function\s+brng/.test(allSrc), "一般地理計算は client に維持");
});

test("[secrecy] public に test fixture を置いていない", () => {
  const fixtureNames = files.filter((f) => /fixture|\.test\./.test(f));
  assert.equal(fixtureNames.length, 0, `public に fixture/test を置かない: ${fixtureNames.join(",")}`);
});
