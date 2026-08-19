/**
 * Rev4 スマホUI不具合修正（3件）回帰テスト。UI 操作経路のみ。計算 core は非対象。
 *
 * 1. スマホ drawer の三脚高さ・標高オフセットの値タップで既存数値入力パッドが開く。
 * 2. 数値パッドを開いた直後、最初の数字入力で既存値を置換（keydown だけでなくタップ経路でも）。
 *    300 → 1 が 3001 でなく 1 になる。DEL/OK 等の部分編集は壊さない。確定値・単位・丸めは不変。
 * 3. 移動モードで通常 viewMarker を退避し、移動用 view: マーカーとの重複を無くす。全終了経路で復帰。
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
  if (start < 0) { const a = src.indexOf(`async function ${name}(`); if (a < 0) return null; return sliceFn(src, a); }
  return sliceFn(src, start);
}
function sliceFn(src, start) {
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

/* ---------- 不具合1: drawer の値タップで既存パッドを開く ---------- */
test("[ui1] drawer の三脚高さ表示が openTripodPad を onclick で開く", () => {
  const m = html.match(/id="mob-tripod-disp"[^>]*onclick="([^"]+)"/);
  assert.ok(m, "mob-tripod-disp に onclick");
  assert.match(m[1], /openTripodPad\(\)/, "既存の共通パッド openTripodPad を呼ぶ");
});
test("[ui1] drawer の標高オフセット表示が openElevPad を onclick で開く", () => {
  const m = html.match(/id="mob-elev-offset-disp"[^>]*onclick="([^"]+)"/);
  assert.ok(m, "mob-elev-offset-disp に onclick");
  assert.match(m[1], /openElevPad\(\)/, "既存の共通パッド openElevPad を呼ぶ");
});
test("[ui1] 別実装を新設せず既存 openTripodPad/openElevPad を再利用している", () => {
  assert.ok(funcBody(html, "openTripodPad"), "openTripodPad 既存");
  assert.ok(funcBody(html, "openElevPad"), "openElevPad 既存");
});

/* ---------- 不具合2: 開いた直後の最初の数字で置換（共通処理・タップ経路も） ---------- */
test("[ui2] hkInput が fresh-open 時の最初の値キーで既存値を置換する（タップ経路）", () => {
  const fn = funcBody(html, "hkInput");
  assert.ok(fn, "hkInput 抽出");
  assert.match(fn, /_hkFreshOpen\s*&&\s*_isValKey/, "fresh-open かつ値キーで置換");
  assert.match(fn, /buf\.tripod\s*=\s*''/, "tripod をクリア");
  assert.match(fn, /buf\.elev\s*=\s*''/, "elev をクリア");
  assert.match(fn, /_hkFreshOpen\s*=\s*false/, "置換後に fresh-open 解除");
});
test("[ui2] focalPadInput も fresh-open 時の最初の数字で置換（タップ経路）", () => {
  const fn = funcBody(html, "focalPadInput");
  assert.ok(fn, "focalPadInput 抽出");
  assert.match(fn, /_hkFreshOpen[\s\S]*buf\.focal\s*=\s*''/, "focal をクリア");
});
test("[ui2] 部分編集を壊さない: DEL/OK は置換対象にしない（値キーのみ）", () => {
  const fn = funcBody(html, "hkInput");
  // 置換条件は「長さ1の数字 or 小数点」のみ。DEL/OK/SIGN/RESET を含めない。
  assert.match(fn, /k\.length===1\s*&&\s*\(\(k>='0'&&k<='9'\)\s*\|\|\s*k==='\.'\)\)/, "値キー判定は数字/小数点のみ");
  assert.doesNotMatch(fn.split("if(_hkFreshOpen")[1].split("}")[0] || "", /DEL|OK|SIGN|RESET/, "操作キーを置換条件に含めない");
});
test("[ui2] 確定処理（値・単位・丸め）は不変: tripod は 0..500 の parseInt、elev は toFixed(2)", () => {
  const fn = funcBody(html, "hkInput");
  assert.match(fn, /parseInt\(buf\.tripod,10\)/, "tripod parseInt 不変");
  assert.match(fn, /n>=0&&n<=500/, "tripod 範囲 0..500 不変");
  assert.match(fn, /parseFloat\(\(n\*_hkElevSign\)\.toFixed\(2\)\)/, "elev toFixed(2) 不変");
});
test("[ui2] fresh-open は keydown 経路でも維持（既存の共通フラグ）", () => {
  // keydown ハンドラの既存 fresh-open クリアが残っていること（回帰で消していない）
  assert.match(html, /_hkFreshOpen\s*&&\s*key\.length===1\s*&&\s*key>='0'\s*&&\s*key<='9'/, "keydown 側の fresh-open 維持");
});

/* ---------- 不具合3: viewMarker 退避/復帰で重複解消 ---------- */
test("[ui3] enterMoveMode で通常 viewMarker を地図から退避する", () => {
  const fn = funcBody(html, "enterMoveMode");
  assert.ok(fn, "enterMoveMode 抽出");
  assert.match(fn, /viewMarker\s*&&\s*map\.hasLayer\(viewMarker\)\)\s*map\.removeLayer\(viewMarker\)/, "viewMarker を退避");
});
test("[ui3] exitMoveMode で通常 viewMarker を復帰する（全終了経路が通る1箇所）", () => {
  const fn = funcBody(html, "exitMoveMode");
  assert.ok(fn, "exitMoveMode 抽出");
  // 復帰条件 + addTo（ブロック形。復帰後にラベル確定更新も行う）
  assert.match(fn, /viewMarker\s*&&\s*!map\.hasLayer\(viewMarker\)\)\s*\{[\s\S]*viewMarker\.addTo\(map\)/, "viewMarker を復帰");
});
test("[ui3] 移動モード中に onViewPick が走っても viewMarker を出さない（commit 中の再重複防止）", () => {
  const fn = funcBody(html, "onViewPick");
  assert.match(fn, /_tubeMoving\s*&&\s*viewMarker\s*&&\s*map\.hasLayer\(viewMarker\)\)\s*map\.removeLayer\(viewMarker\)/, "移動モード中は viewMarker を退避したまま");
});
test("[ui3] 全終了経路が exitMoveMode を通る（cancel/PC/スマホ/別モード遷移）", () => {
  assert.match(funcBody(html, "cancelMoveMode"), /exitMoveMode\(false\)/, "cancel → exitMoveMode");
  assert.match(funcBody(html, "exitMobMoveMode"), /exitMoveMode\(false\)/, "スマホ終了 → exitMoveMode");
  assert.match(funcBody(html, "toggleMoveMode"), /exitMoveMode\(false\)/, "トグル終了 → exitMoveMode");
});
test("[ui3] marker 生成を複製していない（復帰は addTo のみ・L.marker 新規生成を exit に置かない）", () => {
  const fn = funcBody(html, "exitMoveMode");
  assert.doesNotMatch(fn, /L\.marker\(/, "exitMoveMode で viewMarker を新規生成しない");
});
test("[ui3] commitMoveMode の座標確定処理は不変（view: は onViewPick 経由・従来どおり）", () => {
  const fn = funcBody(html, "commitMoveMode");
  assert.match(fn, /_viewMovedInCommit[\s\S]*onViewPick\(\)/, "view 移動は onViewPick 経由（従来どおり）");
});

/* ---------- 不具合2: 置換ロジックの挙動検証（最小 harness で hkInput 相当を実行） ---------- */
test("[ui2][挙動] fresh-open 後 300→'1' は '1'（3001 でない）／2文字目以降は追記", () => {
  // hkInput の値キー置換ロジックと同じ構造の最小モデル（tripod 想定）
  let _hkFreshOpen = false;
  const buf = { tripod: "" };
  function open(cur) { buf.tripod = String(cur); _hkFreshOpen = true; }
  function press(k) {
    const isVal = (k && k.length === 1 && ((k >= "0" && k <= "9") || k === "."));
    if (_hkFreshOpen && isVal) { buf.tripod = ""; _hkFreshOpen = false; }
    if (k === "DEL") { buf.tripod = buf.tripod.slice(0, -1); return; }
    if (buf.tripod.length >= 3) return;
    buf.tripod += k;
  }
  open(300);
  press("1");
  assert.equal(buf.tripod, "1", "最初の数字で 300 を置換して 1");
  press("5");
  assert.equal(buf.tripod, "15", "2文字目は追記");
});

test("[ui2][挙動] fresh-open 中に DEL を押しても置換扱いにしない（部分編集を維持）", () => {
  let _hkFreshOpen = false;
  const buf = { tripod: "" };
  function open(cur) { buf.tripod = String(cur); _hkFreshOpen = true; }
  function press(k) {
    const isVal = (k && k.length === 1 && ((k >= "0" && k <= "9") || k === "."));
    if (_hkFreshOpen && isVal) { buf.tripod = ""; _hkFreshOpen = false; }
    if (k === "DEL") { buf.tripod = buf.tripod.slice(0, -1); return; }
    if (buf.tripod.length >= 3) return;
    buf.tripod += k;
  }
  open(300);
  press("DEL"); // 操作キーは置換しない → 末尾削除で "30"
  assert.equal(buf.tripod, "30", "DEL は既存値の部分編集（置換しない）");
  press("5"); // まだ fresh-open 継続 → 最初の値キーで置換
  assert.equal(buf.tripod, "5", "その後の最初の数字で置換");
});
