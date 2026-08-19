/**
 * Rev4 §21: iPhone AR センサー許可拒否後の復旧 UX。
 *
 * iOS Safari は一度 DeviceOrientation/DeviceMotion 許可を「許可しない」にすると、同一ページ表示中は
 * requestPermission() が即 'denied' を返し再ダイアログを出さない（WebKit 仕様）。確実に有効な復旧は
 * 「ページ再読み込み → もう一度 AR → 許可」。設定手順は推測で書かない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, "../public/apps/hanabi/index.html"), "utf8");

function funcBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

test("[ar][§21] denied 時に復旧案内（再読み込み→AR→許可）を出す", () => {
  const help = funcBody(html, "_showArSensorDeniedHelp");
  assert.ok(help, "_showArSensorDeniedHelp 抽出");
  assert.match(help, /再読み込み/, "再読み込みを案内");
  assert.match(help, /もう一度.*AR|AR.*タップ/, "もう一度 AR を案内");
  assert.match(help, /許可/, "許可を選ぶ案内");
  assert.match(help, /location\.reload\(\)/, "再読み込みを実行できる");
});

test("[ar][§21] 復旧案内は推測の設定手順を書かない（Settings パスを断定しない）", () => {
  const help = funcBody(html, "_showArSensorDeniedHelp");
  // 端末差のある「設定 > Safari > モーションと画面の向き」等の固定手順を断定的に書かない
  assert.doesNotMatch(help, /設定\s*[>＞].*Safari/, "Settings 固定パスを書かない");
});

test("[ar][§21] onArCameraBtn は denied を検知して help を出し、granted のみ継続", () => {
  const fn = funcBody(html, "onArCameraBtn");
  assert.ok(fn, "onArCameraBtn 抽出");
  assert.match(fn, /requestPermission\(\)/, "requestPermission を呼ぶ");
  assert.match(fn, /res\s*!==\s*'granted'[\s\S]*_showArSensorDeniedHelp\(\)/, "denied は help を出す");
  // 単純 alert のみで終わらせない（旧: alert('方向センサーの許可が必要です')）
  assert.doesNotMatch(fn, /alert\('方向センサーの許可が必要です'\)/, "旧 alert のみの経路を残さない");
});

test("[ar][§21] DeviceMotion 側の許可も granted 時に要求する", () => {
  const fn = funcBody(html, "onArCameraBtn");
  assert.match(fn, /DeviceMotionEvent[\s\S]*requestPermission/, "DeviceMotion.requestPermission も扱う");
});
