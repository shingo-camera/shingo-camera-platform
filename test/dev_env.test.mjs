/**
 * 正式 DEV 環境（Phase 2）の回帰・characterization。
 * - D4 API base wrapper：Production base=""（既存 URL/挙動 完全不変）／DEV base="/dev"。
 * - D2/D3 shim 純粋関数：stripDevPrefix / devPrefixAttr。
 * - Production no-op：DEV_BASE_PATH 未設定なら shim 無効（既存 routing 不変）は index.ts の
 *   handleDevRequest が env.DEV_BASE_PATH で早期 return する設計（本ファイルでは pure 関数と wrapper を固定）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// ---- api-base.js を browser 相当 sandbox で評価して window.* を取り出す ----
function loadApiBase(pathname) {
  const src = readFileSync(new URL("../public/assets/api-base.js", import.meta.url), "utf8");
  const sandbox = { window: {}, document: undefined, location: { pathname }, module: { exports: {} } };
  vm.runInNewContext(src, sandbox);
  return sandbox.window;
}

test("[D4] Production では apiBase=\"\"・apiUrl が既存 /api/... と完全一致（挙動不変）", () => {
  for (const p of ["/", "/store/", "/mypage/", "/login/", "/apps/sun-and-moon/", "/admin/users/"]) {
    const w = loadApiBase(p);
    assert.equal(w.apiBase(), "", `apiBase(${p})=""`);
    assert.equal(w.apiUrl("/api/config"), "/api/config", "URL 不変");
    assert.equal(w.apiUrl("/api/purchases/checkout"), "/api/purchases/checkout", "URL 不変");
    assert.equal(w.apiUrl("/api/apps/sun-and-moon/chance"), "/api/apps/sun-and-moon/chance", "URL 不変");
  }
});

test("[D4] DEV（/dev 配下）では apiBase=\"/dev\"・/api→/dev/api へ解決", () => {
  for (const p of ["/dev", "/dev/", "/dev/store/", "/dev/apps/sun-and-moon/"]) {
    const w = loadApiBase(p);
    assert.equal(w.apiBase(), "/dev", `apiBase(${p})="/dev"`);
    assert.equal(w.apiUrl("/api/config"), "/dev/api/config");
    assert.equal(w.apiUrl("/api/apps/sun-and-moon/chance"), "/dev/api/apps/sun-and-moon/chance");
  }
});

test("[D4] apiUrl は外部 URL・非 /api・既 /dev を変換しない", () => {
  const w = loadApiBase("/dev/store/");
  assert.equal(w.apiUrl("https://x.example/api/y"), "https://x.example/api/y", "外部 http は不変");
  assert.equal(w.apiUrl("//cdn/api/y"), "//cdn/api/y", "プロトコル相対は不変");
  assert.equal(w.apiUrl("/assets/site.js"), "/assets/site.js", "/api 以外は不変");
  assert.equal(w.apiUrl("/dev/api/z"), "/dev/api/z", "既に /dev 済みは二重付与しない");
});

// ---- shim 純粋関数（bundle 経由で export を取得。build-test-bundle が index.ts を束ねる） ----
import { stripDevPrefix, devPrefixAttr } from "./_bundle/dev_prefix.mjs";

test("[D2] stripDevPrefix：/dev を除去（/dev→/、配下外は null）", () => {
  assert.equal(stripDevPrefix("/dev", "/dev"), "/");
  assert.equal(stripDevPrefix("/dev/", "/dev"), "/");
  assert.equal(stripDevPrefix("/dev/api/config", "/dev"), "/api/config");
  assert.equal(stripDevPrefix("/dev/apps/sun-and-moon/", "/dev"), "/apps/sun-and-moon/");
  assert.equal(stripDevPrefix("/api/config", "/dev"), null, "配下外は null");
  assert.equal(stripDevPrefix("/develop/x", "/dev"), null, "/develop は /dev 配下でない");
});

test("[D2] devPrefixAttr：ルート相対のみ /dev 前置（外部/既済/hash/相対は不変）", () => {
  assert.equal(devPrefixAttr("/assets/site.js", "/dev"), "/dev/assets/site.js");
  assert.equal(devPrefixAttr("/apps/sun-and-moon/", "/dev"), "/dev/apps/sun-and-moon/");
  assert.equal(devPrefixAttr("https://x/y", "/dev"), "https://x/y", "外部不変");
  assert.equal(devPrefixAttr("//cdn/y", "/dev"), "//cdn/y", "プロトコル相対不変");
  assert.equal(devPrefixAttr("/dev/assets/x", "/dev"), "/dev/assets/x", "既済は二重付与しない");
  assert.equal(devPrefixAttr("./rel.js", "/dev"), "./rel.js", "相対不変");
  assert.equal(devPrefixAttr("#frag", "/dev"), "#frag", "hash 不変");
  assert.equal(devPrefixAttr("", "/dev"), "", "空は不変");
  assert.equal(devPrefixAttr(null, "/dev"), null, "null は不変");
});

// ============================================================================
// P0-3/P0-4/P0-5：appUrl（Platform navigation resolver）helper 直接テスト
// ============================================================================
test("[D3/appUrl] Production では appUrl が Platform パスを不変で返す", () => {
  for (const p of ["/", "/store/", "/mypage/", "/login/", "/apps/sun-and-moon/", "/products/sun-and-moon/", "/admin/"]) {
    const w = loadApiBase("/store/");
    assert.equal(w.appUrl(p), p, `appUrl(${p}) 不変`);
  }
});
test("[D3/appUrl] DEV では appUrl が /dev を前置（外部/既済は不変）", () => {
  const w = loadApiBase("/dev/apps/sun-and-moon/");
  assert.equal(w.appUrl("/login/"), "/dev/login/");
  assert.equal(w.appUrl("/store/"), "/dev/store/");
  assert.equal(w.appUrl("/mypage/"), "/dev/mypage/");
  assert.equal(w.appUrl("/apps/sun-and-moon/"), "/dev/apps/sun-and-moon/");
  assert.equal(w.appUrl("/products/sun-and-moon/"), "/dev/products/sun-and-moon/");
  assert.equal(w.appUrl("/"), "/dev/");
  assert.equal(w.appUrl("/dev/store/"), "/dev/store/", "既済は二重付与しない");
  assert.equal(w.appUrl("https://x/login/"), "https://x/login/", "外部不変");
});
test("[D4/SUNMOON] DEV で SUNMOON 自前 API が /dev/api/apps/... へ解決", () => {
  const w = loadApiBase("/dev/apps/sun-and-moon/");
  // SMApi は API_BASE("/api/apps/sun-and-moon/")+path を apiFetch(=apiUrl) 経由で叩く
  assert.equal(w.apiUrl("/api/apps/sun-and-moon/chance"), "/dev/api/apps/sun-and-moon/chance");
  assert.equal(w.apiUrl("/api/apps/sun-and-moon/app-start"), "/dev/api/apps/sun-and-moon/app-start");
  assert.equal(w.apiUrl("/api/apps/sun-and-moon/heartbeat"), "/dev/api/apps/sun-and-moon/heartbeat");
});

// ============================================================================
// アプリ起動導線（「利用する」CTA）：商品設定 appUrl を resolver 経由で /dev 前置
//   site.js の launchHref(meta) は appUrl(meta.appUrl) 相当。ここでは基盤 appUrl の解決を検証し、
//   下の P0-6 静的監査で「生 meta.appUrl を href に入れていない」ことを固定する。
// ============================================================================
test("[launch] 商品 appUrl を resolver 経由にすると DEV=/dev 前置・Production 不変（HOME/STORE/MYPAGE/success 共通）", () => {
  // 商品設定の起動先（正本・ルート相対）
  const APP_PATH = "/apps/sun-and-moon/";
  // Production（/store/ 等に居る）: 不変
  const wp = loadApiBase("/store/");
  assert.equal(wp.appUrl(APP_PATH), "/apps/sun-and-moon/", "Production は /dev を付けない");
  // DEV: どのページ（store/mypage/success/apps）から開いても /dev/apps/sun-and-moon/
  for (const from of ["/dev/store/", "/dev/mypage/", "/dev/purchase/success/", "/dev/apps/sun-and-moon/"]) {
    const wd = loadApiBase(from);
    assert.equal(wd.appUrl(APP_PATH), "/dev/apps/sun-and-moon/", `${from} からの起動が /dev を保つ`);
  }
  // 将来アプリが外部 URL を正本にした場合は不変（appUrl は外部を変換しない＝二重脱出も /dev 誤付与もしない）
  const wd2 = loadApiBase("/dev/mypage/");
  assert.equal(wd2.appUrl("https://ext.example/app/"), "https://ext.example/app/", "外部 URL は不変");
});
test("[launch] site.js の起動導線は launchHref 経由で、生 meta.appUrl を href に入れない（HOME/STORE/MYPAGE）", () => {
  const siteJs = readFileSync(new URL("../public/assets/site.js", import.meta.url), "utf8");
  // launchHref ヘルパが appUrl リゾルバを通す定義になっている
  assert.match(siteJs, /function launchHref\(meta\)\s*\{[\s\S]*appUrl\(meta\.appUrl\)/, "launchHref が appUrl(meta.appUrl) を返す");
  // 3 導線（STORE launch card / MYPAGE ownedCard / STORE select row）が launchHref を使う
  const uses = (siteJs.match(/launchHref\(meta\)/g) || []).length;
  assert.ok(uses >= 3, `launchHref 使用が 3 箇所以上（実際 ${uses}）`);
  // 生 meta.appUrl を href に直接入れる旧パターンが残っていない
  assert.doesNotMatch(siteJs, /esc\(meta\.appUrl\)/, "生 meta.appUrl を esc して href 化していない");
  assert.doesNotMatch(siteJs, /href="[^"]*'\s*\+\s*meta\.appUrl/, "生 meta.appUrl を href に連結していない");
});

// ============================================================================
// P0-6：Platform 全体 静的監査（自前 API/navigation が resolver を通らず残っていないこと）
// ============================================================================
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = dir + "/" + e;
    if (statSync(p).isDirectory()) { if (e === "vendor") continue; out.push(...walk(p)); }
    else if (/\.(js|html)$/.test(e)) out.push(p);
  }
  return out;
}
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const files = walk(publicDir).filter((f) => !f.endsWith("/assets/api-base.js"));
function read(f) { return readFileSync(f, "utf8"); }
// HTML は <script>…</script> の中身だけ（静的 markup の href/src は HTMLRewriter 管轄なので監査対象外）。
// .js はファイル全体が JS。
function scriptContent(f) {
  const s = read(f);
  if (f.endsWith(".js")) return s;
  let out = "";
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(s))) out += m[1] + "\n";
  return out;
}

test("[P0-6①] 自前 Platform API を素の fetch で叩く箇所が残っていない（apiFetch へ統一）", () => {
  const offenders = [];
  for (const f of files) {
    const s = scriptContent(f);
    if (/[^a-zA-Z]fetch\(\s*["'`]\/api\b/.test(" " + s)) offenders.push(f + " : fetch(\"/api...)");
    if (/[^a-zA-Z]fetch\(\s*API_BASE\b/.test(" " + s)) offenders.push(f + " : fetch(API_BASE...)");
  }
  assert.deepEqual(offenders, [], "素の自前API fetch が残存: " + offenders.join(", "));
});

test("[P0-6⑤/②] JS navigation・要素href/action が appUrl を通らず絶対 Platform パスへ向かう箇所が無い", () => {
  const offenders = [];
  for (const f of files) {
    const s = scriptContent(f); // <script> 内 JS のみ（静的 markup は HTMLRewriter 管轄）
    if (/location\.(href|assign|replace)\s*[=(]\s*["'`]\/[a-z]/.test(s)) offenders.push(f + " : location.* raw");
    const m = s.match(/(?<!location)\.(href|action)\s*=\s*["'`]\/[a-z]/g);
    if (m) offenders.push(f + " : .href/.action raw (" + m.length + ")");
    // JS 文字列内で生成する <a ... href="/..."（HTMLRewriter 対象外）
    if (/["'`][^"'`]*<a\b[^>]*href=\\?["']\/[a-z]/.test(s)) offenders.push(f + " : generated <a href raw");
  }
  assert.deepEqual(offenders, [], "Production root へ脱出し得る navigation: " + offenders.join(" | "));
});

test("[P0-4] auth-integration.js が SMApi/app-start/heartbeat=apiFetch・redirect=appUrl", () => {
  const s = read(publicDir + "/apps/sun-and-moon/auth-integration.js");
  assert.match(s, /apiFetch\(url, opt\)/, "SMApi は apiFetch");
  assert.match(s, /apiFetch\(API_BASE \+ "app-start"/, "app-start は apiFetch");
  assert.match(s, /apiFetch\(API_BASE \+ "heartbeat"/, "heartbeat は apiFetch");
  assert.match(s, /appUrl\(LOGIN_URL\)/, "login redirect は appUrl");
  assert.match(s, /appUrl\(NO_ENTITLEMENT_URL\)/, "no-entitlement redirect は appUrl");
});

test("[P0-5] admin.js が apiGet/apiPut=apiFetch・login redirect=appUrl", () => {
  const s = read(publicDir + "/admin/assets/admin.js");
  assert.match(s, /apiFetch\(path,/, "apiGet/apiPut は apiFetch");
  assert.match(s, /location\.href = appUrl\("\/login\/"\)/, "非認証 redirect は appUrl");
  assert.doesNotMatch(s, /[^a-zA-Z]fetch\(path,/, "素の fetch(path) が残っていない");
});
