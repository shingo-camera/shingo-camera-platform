// 販売前修正の「実ファイル検証」テスト。
// site.js / auth.js / cancel ページは IIFE・DOM 依存のため単体 import できない。
// 実装を写経したロジックテストで「本体を保証した」とは扱わず、ここでは
// 最終成果物の実ファイルに、要件を満たす実コードが存在することを直接 grep で検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const siteJs = readFileSync("public/assets/site.js", "utf8");
const authJs = readFileSync("public/assets/auth.js", "utf8");
const cancelHtml = readFileSync("public/purchase/cancel/index.html", "utf8");

/* 1. cancelCheckout: terminal のみ pending 削除・状態不明は維持 */
test("[実ファイル] site.js cancelCheckout は terminal 結果のみ clearPending する", () => {
  // cancelCheckout 関数本体を抽出
  const m = siteJs.match(/async function cancelCheckout[\s\S]*?\n  }\n/);
  assert.ok(m, "cancelCheckout 関数が存在する");
  const fn = m[0];
  // terminal 判定（cancelled/expired/already_paid）で clearPending する分岐がある
  assert.match(fn, /result === "cancelled" \|\| result === "expired" \|\| result === "already_paid"/);
  assert.match(fn, /clearPending\(\)/);
  // 状態不明時は pending を消さず notify で案内する
  assert.match(fn, /notify\(/);
  // 旧実装（無条件 clearPending→reload）の痕跡が無い
  assert.doesNotMatch(fn, /失敗しても stale 回収に委ねる/);
});

/* 2. cancel ページ: API 前に無条件削除しない・一致時のみ削除 */
test("[実ファイル] cancel ページは API 結果前に pending を無条件削除しない", () => {
  // 冒頭の無条件 removeItem が除去されている
  assert.doesNotMatch(cancelHtml, /進行中 Checkout の記録をクリア/);
  // operationId 一致時のみ削除するヘルパが存在する
  assert.match(cancelHtml, /function clearPendingIfMatches/);
  assert.match(cancelHtml, /p\.operationId === opId/);
});

test("[実ファイル] cancel ページは terminal 結果でのみ clearPendingIfMatches を呼ぶ", () => {
  // cancelled / expired / already_paid の各分岐で呼ばれている（3回）
  const calls = (cancelHtml.match(/clearPendingIfMatches\(operationId\)/g) || []).length;
  assert.equal(calls, 3, "terminal 3 分岐で削除を呼ぶ");
  // INDETERMINATE / RETRY の分岐では削除を呼ばない（該当行に clearPending が無いこと）
  const indetBlock = cancelHtml.match(/CANCEL_INDETERMINATE[\s\S]*?CANCEL_RETRY/);
  assert.ok(indetBlock);
  assert.doesNotMatch(indetBlock[0], /clearPendingIfMatches/);
});

/* 3. reset-password same_password 分岐 */
test("[実ファイル] auth.js は same_password を専用文言へ分岐する", () => {
  assert.match(authJs, /same_password/);
  assert.match(authJs, /現在とは異なるパスワードを設定してください/);
  // 従来の汎用エラー文言も残す（else 側）
  assert.match(authJs, /リンクの有効期限をご確認ください/);
});

/* 4. login redirect の origin 一致確認 */
test("[実ファイル] auth.js の redirect は共通検証（safeRedirectPath）で origin 一致を確認する", () => {
  // 検証は safeRedirectPath に共通化（§9）。login/signup 双方がこれを利用する。
  assert.match(authJs, /function safeRedirectPath/);
  assert.match(authJs, /new URL\(rp, window\.location\.origin\)/);
  assert.match(authJs, /resolved\.origin !== window\.location\.origin/);
  // /login/ 自身への redirect は無限ループ防止で弾く（§8）
  assert.match(authJs, /resolved\.pathname === "\/login\/"/);
});

/* 追加: rev5 静的レビュー修正の実ファイル検証 */
const successHtml = readFileSync("public/purchase/success/index.html", "utf8");
const cancelHtml2 = readFileSync("public/purchase/cancel/index.html", "utf8");

/* 1. success: 無条件削除しない・operationId 一致時のみ削除 */
test("[実ファイル] success は pending を無条件削除せず、operationId 一致時のみ削除する", () => {
  // 旧・無条件削除の痕跡が無い
  assert.doesNotMatch(successHtml, /進行中 Checkout の記録をクリア（成功導線/);
  // 一致削除ヘルパが存在
  assert.match(successHtml, /function clearPendingIfMatches/);
  assert.match(successHtml, /p\.operationId === opId/);
  // recover の operationId を控えて一致削除を呼ぶ
  assert.match(successHtml, /recoverOperationId = rr\.operationId/);
  assert.match(successHtml, /clearPendingIfMatches\(recoverOperationId\)/);
});

/* 2. success 未ログイン導線: login redirect に success の pathname+query を渡す */
test("[実ファイル] success 未ログイン時に login へ現在URL(session_id含む)で戻す導線を出す", () => {
  assert.match(successHtml, /location\.pathname \+ location\.search/);
  assert.match(successHtml, /\/login\/\?redirect=/);
  assert.match(successHtml, /ログインして購入状態を確認する/);
});

/* 3. cancel ページ可読性: 固定色をテーマ変数へ */
test("[実ファイル] cancel ページの固定色がテーマ変数へ置換されている", () => {
  assert.match(cancelHtml2, /\.msg \{[^}]*var\(--muted/);
  assert.match(cancelHtml2, /\.msg\.paid \{ color: var\(--ok/);
  // 旧・暗い固定色が残っていない
  assert.doesNotMatch(cancelHtml2, /#665;/);
  assert.doesNotMatch(cancelHtml2, /#2e7d43/);
});

/* 4. startMultiCheckout: 確定拒否時の pending 復元 */
test("[実ファイル] startMultiCheckout は確定拒否エラーで prevPending を復元する", () => {
  const m = siteJs.match(/async function startMultiCheckout[\s\S]*?\n  }\n/);
  assert.ok(m);
  const fn = m[0];
  // 復元ヘルパが定義され、確定拒否3分岐＋戻るで呼ばれる（計4回）
  assert.match(siteJs, /function restorePending/);
  const calls = (fn.match(/restorePending\(prevPending\)/g) || []).length;
  assert.equal(calls, 6, "戻る + RESTART_PENDING + ALREADY_IN_PROGRESS + DEPENDENCY_REQUIRED + ALREADY_PURCHASED + CHECKOUT_CREATE_FAILED");
  // ALREADY_PURCHASED は復元（旧 pending 導線を消さない。clearPending にしない）
  const ap = fn.match(/ALREADY_PURCHASED"\) \{[\s\S]*?await notify/);
  assert.ok(ap);
  assert.match(ap[0], /restorePending\(prevPending\)/);
  assert.doesNotMatch(ap[0], /clearPending\(\)/);
});

/* 5. handleRecover: 所有者確認済み Session の operationId を返す（実ソース検証） */
const purchasesTs = readFileSync("src/routes/purchases.ts", "utf8");
test("[実ソース] handleRecover は client_reference_id を operationId として返す", () => {
  // 所有者照合(session.metadata.auth_user_id)後に client_reference_id を取得している
  assert.match(purchasesTs, /session\.client_reference_id/);
  // recover の各成功レスポンスに operationId を含める
  assert.match(purchasesTs, /result: "newly_fulfilled", purchasedCodes, operationId/);
  assert.match(purchasesTs, /result: "already_fulfilled", purchasedCodes, operationId/);
});

/* 追加: rev6 静的レビュー修正の実ファイル検証 */
const successHtml3 = readFileSync("public/purchase/success/index.html", "utf8");
const siteJs3 = readFileSync("public/assets/site.js", "utf8");

/* 1. success 未ログイン: LOGIN 導線を確実に表示（product-list を display:block） */
test("[実ファイル] success 未ログイン分岐で product-list を表示状態にする", () => {
  // #product-list は初期 display:none
  assert.match(successHtml3, /id="product-list"[^>]*style="display:none;"/);
  // 未ログイン分岐で LOGIN リンク追加後に display=block へ
  const block = successHtml3.match(/ログインして購入状態を確認する[\s\S]{0,200}/);
  assert.ok(block);
  assert.match(block[0], /listEl\.style\.display = "block"/);
});

/* 2. ALREADY_PURCHASED は restorePending（旧 pending の導線を消さない） */
test("[実ファイル] startMultiCheckout の ALREADY_PURCHASED は restorePending する", () => {
  const m = siteJs3.match(/ALREADY_PURCHASED"\) \{[\s\S]*?await notify/);
  assert.ok(m);
  assert.match(m[0], /restorePending\(prevPending\)/);
  assert.doesNotMatch(m[0], /clearPending\(\)/);
});

/* 3. CHECKOUT_CREATE_FAILED(502) は terminal failure として restorePending */
test("[実ファイル] startMultiCheckout の CHECKOUT_CREATE_FAILED は restorePending する", () => {
  assert.match(siteJs3, /res\.status === 502 && code === "CHECKOUT_CREATE_FAILED"/);
  const m = siteJs3.match(/CHECKOUT_CREATE_FAILED"\) \{[\s\S]*?await notify/);
  assert.ok(m);
  assert.match(m[0], /restorePending\(prevPending\)/);
});

/* 4. 通信結果不明系は pending 維持（restore も clear もしない） */
test("[実ファイル] CHECKOUT_RETRY / 503汎用 / RATE(429) は pending を維持する", () => {
  // CHECKOUT_RETRY 分岐に restore/clear が無い
  const retry = siteJs3.match(/CHECKOUT_RETRY"\) \{[\s\S]*?await notify[^;]*;/);
  assert.ok(retry);
  assert.doesNotMatch(retry[0], /restorePending|clearPending/);
  // 429 分岐に restore/clear が無い
  const rate = siteJs3.match(/res\.status === 429\) \{[\s\S]*?await notify[^;]*;/);
  assert.ok(rate);
  assert.doesNotMatch(rate[0], /restorePending|clearPending/);
});

/* 追加: STORE 進行中バナーのダークテーマ可読性（実ファイル検証） */
const siteCss = readFileSync("public/assets/site.css", "utf8");
test("[実ファイル] .store-pending / .btn-ghost がテーマ変数へ寄せられている", () => {
  // 旧・明るい固定色や暗いグレー文字が残っていない
  assert.doesNotMatch(siteCss, /#fff7e6/);
  assert.doesNotMatch(siteCss, /#f0c36d/);
  assert.doesNotMatch(siteCss, /border: 1px solid #bbb/);
  assert.doesNotMatch(siteCss, /color: #555/);
  // store-pending がテーマ変数（背景/枠/本文）を使う
  assert.match(siteCss, /\.store-pending \{[^}]*background: var\(--bg-2\)/);
  assert.match(siteCss, /\.store-pending \{[^}]*border: 1px solid var\(--line\)/);
  assert.match(siteCss, /\.store-pending p \{ color: var\(--text\)/);
  // btn-ghost がテーマ変数を使い、hover でも文字色を保つ
  assert.match(siteCss, /\.btn\.btn-ghost \{[^}]*color: var\(--text-2\)/);
  assert.match(siteCss, /\.btn\.btn-ghost:hover \{[^}]*color: var\(--text\)/);
});

/* 追加: WORK-011 継続対応（項目1〜6）の実ファイル検証 */
const siteJsW = readFileSync("public/assets/site.js", "utf8");
const siteCssW = readFileSync("public/assets/site.css", "utf8");
const indexHtmlW = readFileSync("public/index.html", "utf8");
const migrationHtmlW = readFileSync("public/migration/note/index.html", "utf8");
const dialogCssW = readFileSync("public/assets/dialog.css", "utf8");

/* 項目1: 未ログインでも STORE 商品を表示（early return 廃止） */
test("[実ファイル] initStore は未ログインでも商品を表示し、購入操作時にログイン誘導", () => {
  const m = siteJsW.match(/async function initStore[\s\S]*?\n  }\n/);
  assert.ok(m);
  const fn = m[0];
  // 旧: 未ログイン early return（商品非表示）が無い
  assert.doesNotMatch(fn, /商品の購入にはログインが必要です。/);
  // 未ログインでも rows を描画（storeSelectRow 呼び出し）
  assert.match(fn, /storeSelectRow\(m, !!grantedSet\[m\.code\], !!token\)/);
  // 購入ボタン押下時、未ログインならログインへ誘導
  assert.match(fn, /if \(!token\)[\s\S]*?\/login\/\?redirect=/);
});

/* 項目4: 購入済み表示の明確化＋利用する導線 */
test("[実ファイル] storeSelectRow は購入済みバッジ＋利用する導線を出す", () => {
  assert.match(siteJsW, /badge badge-owned/);
  assert.match(siteJsW, /class="btn btn-sm sr-use"/);
  assert.match(siteCssW, /\.badge\.badge-owned/);
});

/* 項目3: ダイアログメッセージの折り返し改善 */
test("[実ファイル] ダイアログメッセージが禁則強化され、restart メッセージが文節改行されている", () => {
  assert.match(dialogCssW, /line-break: strict/);
  // 2行目を分割（「新しく購入を進めると、」の直後で改行）
  assert.match(siteJsW, /新しく購入を進めると、\\n以前の購入画面は利用できなくなります。/);
});

/* 項目5: pending 表示の正本を active-checkout API に */
test("[実ファイル] STORE pending の正本が active-checkout API（localStorage は補助）", () => {
  assert.match(siteJsW, /\/api\/purchases\/active-checkout/);
  // resumable が無ければ localStorage を clear
  assert.match(siteJsW, /if \(!resumable\) \{[\s\S]*?clearPending\(\)/);
  // 再開時 expired 判明の通知（仕様5）
  assert.match(siteJsW, /CHECKOUT_EXPIRED" \|\| code === "OPERATION_CLOSED"/);
  assert.match(siteJsW, /前回の購入手続きは有効期限が切れたため終了しました/);
});

/* 項目6: 月の傾きを右へ回転 */
test("[実ファイル] トップの月イラストが 30 度右へ回転（§24: 15 度より明確に右）", () => {
  assert.match(indexHtmlW, /class="h-moon-art" transform="translate\(-10\.5,0\) rotate\(30\)"/);
  assert.doesNotMatch(indexHtmlW, /rotate\(15\)/);
});

/* 項目2: note 移行の未ログイン導線 */
test("[実ファイル] note 移行は常時ログイン案内を出さず、移行実行時に LOGIN へ誘導する（§14/§26）", () => {
  // 常時案内（setLoginPrompt / 固定文言）は削除済み
  assert.doesNotMatch(migrationHtmlW, /setLoginPrompt/);
  assert.doesNotMatch(migrationHtmlW, /移行・確認にはログインが必要です/);
  // 「移行する」押下時の LOGIN 誘導（redirect 付き）は存在する
  assert.match(migrationHtmlW, /\/login\/\?redirect=/);
  assert.match(migrationHtmlW, /migration\/note/);
});

/* 追加: 3点補正（active-checkout の整合性）の実ソース／実ファイル検証 */
const purchasesTs3 = readFileSync("src/routes/purchases.ts", "utf8");
const siteJs3b = readFileSync("public/assets/site.js", "utf8");

/* 補正1: completed を fulfillment へ収束（二重実装しない・既存 fulfillCheckoutSession 再利用） */
test("[実ソース] active-checkout は completed を fulfillCheckoutSession に収束させる", () => {
  const m = purchasesTs3.match(/export async function handleActiveCheckout[\s\S]*?\n}\n/);
  assert.ok(m);
  const fn = m[0];
  // completed 分岐で既存 fulfillment を呼ぶ
  assert.match(fn, /r === "completed"/);
  assert.match(fn, /fulfillCheckoutSession\(env, att\.STRIPE_SESSION_ID, "recovery"\)/);
  // not_paid/invalid/inconsistent 等は推測で終端化しない（安全側コメント）
  assert.match(fn, /推測で終端化せず安全側/);
});
test("[実ソース] settle は Stripe complete を completed として区別する（already_paid に丸めない）", () => {
  assert.match(purchasesTs3, /if \(session\.status === "complete"\) return "completed"/);
});

/* 補正2: 通信失敗と「pendingなし確認」を区別（acConfirmed でのみ clear） */
test("[実ファイル] active-checkout 取得成功時のみ pending を整合し、通信失敗では消さない", () => {
  const fn = siteJs3b.match(/async function initStore[\s\S]*?\n  }\n/)[0];
  assert.match(fn, /var acConfirmed = false/);
  // 200 + result OK のときだけ acConfirmed=true
  assert.match(fn, /acBody\.result === "OK"[\s\S]*?acConfirmed = true/);
  // clearPending は acConfirmed のときのみ
  assert.match(fn, /if \(acConfirmed\) \{[\s\S]*?clearPending\(\)/);
});

/* 補正3: 古い open を安全終了できなければ resumable を確定しない */
test("[実ソース] active-checkout は古い open を終了できない場合 resumable を確定しない", () => {
  const fn = purchasesTs3.match(/export async function handleActiveCheckout[\s\S]*?\n}\n/)[0];
  assert.match(fn, /allOldSettled/);
  // cancelled/expired/not_created 以外は終了できていない扱い
  assert.match(fn, /r !== "cancelled" && r !== "expired" && r !== "not_created"/);
  // 確定できなければ状態確認中を返す（UI だけ隠さない）
  assert.match(fn, /ACTIVE_CHECKOUT_PENDING/);
});

/* ============ WORK-011 導線最終改修（HOME/MY PAGE/ヘッダー/SIGNUP等）の実ファイル検証 ============ */
import { existsSync } from "node:fs";
const siteJsN = readFileSync("public/assets/site.js", "utf8");
const authJsN = readFileSync("public/assets/auth.js", "utf8");
const siteCssN = readFileSync("public/assets/site.css", "utf8");
const indexHtmlN = readFileSync("public/index.html", "utf8");
const configN = readFileSync("public/assets/site-config.js", "utf8");

/* §2: 旧 /home/ 完全廃止・/mypage/ 新設 */
test("[実ファイル] 旧 public/home/ は存在せず public/mypage/ が存在する", () => {
  assert.equal(existsSync("public/home/index.html"), false);
  assert.equal(existsSync("public/mypage/index.html"), true);
  const my = readFileSync("public/mypage/index.html", "utf8");
  assert.match(my, /data-page="mypage"/);
  assert.match(my, /MY PAGE/);
});
test("[実ファイル] 意図しない /home/ 参照が残っていない（§3）", () => {
  assert.doesNotMatch(siteJsN, /"\/home\/"/);
  assert.doesNotMatch(authJsN, /"\/home\/"/);
});

/* §4/§5: ヘッダー最終仕様 + ADMIN */
test("[実ファイル] ヘッダーは HOME/STORE/(MY PAGE)/(ADMIN)/SUPPORT + LOGIN/LOGOUT", () => {
  assert.match(siteJsN, /<a href="\/">HOME<\/a>/);
  assert.match(siteJsN, /<a href="\/mypage\/">MY PAGE<\/a>/);
  assert.match(siteJsN, /isAdminUser \? '<a href="\/admin\/">ADMIN<\/a>' : ''/);
  // ADMIN 判定は既存 admin API の 200/403（新判定を作らない）
  assert.match(siteJsN, /\/api\/admin\/dashboard/);
});

/* §6: スマホハンバーガー */
test("[実ファイル] ハンバーガーメニュー（aria/ESC/外クリック/リサイズ復帰）", () => {
  assert.match(siteJsN, /nav-toggle/);
  assert.match(siteJsN, /aria-expanded/);
  assert.match(siteJsN, /aria-controls/);
  assert.match(siteJsN, /key === "Escape"/);
  assert.match(siteJsN, /window\.addEventListener\("resize"/);
  assert.match(siteCssN, /\.nav-toggle \{ display: none/);
  assert.match(siteCssN, /\.site-nav\.open \{ display: flex/);
});

/* §7/§8: LOGIN は中継地点 */
test("[実ファイル] LOGIN redirect なしは /mypage/ へ、ログイン済みは即遷移", () => {
  assert.match(authJsN, /dest \|\| "\/mypage\/"/);
  // ログイン済み分岐でも dest || /mypage/ へ遷移（フォームに留めない）
  const m = authJsN.match(/既にログイン済みなら LOGIN フォームへ留めない[\s\S]*?\}\)\(\);/);
  assert.ok(m);
  assert.match(m[0], /window\.location\.href = dest \|\| "\/mypage\/"/);
});

/* §10: SIGNUP redirect 引継 */
test("[実ファイル] SIGNUP は redirect を emailRedirectTo=/login/?redirect= へ引継ぐ", () => {
  assert.match(authJsN, /var dest = safeRedirectPath\(\)/);
  assert.match(authJsN, /"\/login\/" \+\s*\(dest \? "\?redirect=" \+ encodeURIComponent\(dest\) : ""\)/);
  // LOGIN 画面の SIGNUP リンクにも引継
  assert.match(authJsN, /a\[href="\/signup\/"\]/);
});

/* §12/§26: STORE 常時ログイン案内の削除 */
test("[実ファイル] STORE の閲覧自由・要ログイン案内は削除済み", () => {
  assert.doesNotMatch(siteJsN, /商品の閲覧は自由です/);
});

/* §15/§16: HOME 3商品（左SAM・右上HANABI・右下EARTH） */
test("[実ファイル] HOME は 3 商品構成（EARTH は右カラム下）", () => {
  assert.match(indexHtmlN, /tool-inner-3/);
  assert.match(indexHtmlN, /tool-col-left[\s\S]*?SUN_AND_MOON/);
  const right = indexHtmlN.match(/tool-col-right[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
  assert.ok(right);
  // 右カラム内で HANABI が先、EARTH が後（上下関係）
  const h = right[0].indexOf('data-app-icon="HANABI"');
  const e = right[0].indexOf('data-app-icon="HANABI_GOOGLE_EARTH"');
  assert.ok(h >= 0 && e > h, "HANABI が上、EARTH が下");
  assert.match(siteCssN, /\.tool-col-right \{ display: flex; flex-direction: column/);
});

/* §16/§25: EARTH 商品定義（正式名・新アイコン） */
test("[実ファイル] EARTH は正式名と専用アイコンを持つ", () => {
  assert.match(configN, /displayName: "HANABI Google Earth 連携"/);
  assert.match(configN, /hanabi-google-earth\.png/);
  assert.equal(existsSync("public/assets/icons/hanabi-google-earth.png"), true);
});

/* §17/§18/§19: カード CTA（所有状態出し分け・別タブ・EARTH 起動導線なし） */
test("[実ファイル] HOME カード CTA は granted+appUrl で「利用する」（別タブ）、EARTH は起動導線を作らない", () => {
  const fn = siteJsN.match(/function productLinksHtml[\s\S]*?\n  \}/)[0];
  assert.match(fn, /granted && meta\.appUrl/);
  assert.match(fn, /target="_blank" rel="noopener noreferrer">利用する/);
  // granted でも appUrl 無しは所有バッジのみ（EARTH: 架空 appUrl を作らない）
  assert.match(fn, /badge badge-owned/);
  // EARTH に appUrl が設定されていない（site-config）
  const earth = configN.match(/HANABI_GOOGLE_EARTH: \{[\s\S]*?\n    \}/)[0];
  assert.match(earth, /appUrl: null/);
});
test("[実ファイル] MY PAGE/STORE の「利用する」も別タブ（§19）", () => {
  const owned = siteJsN.match(/function ownedCard[\s\S]*?\n  \}/)[0];
  assert.match(owned, /target="_blank" rel="noopener noreferrer">利用する/);
  const store = siteJsN.match(/function storeSelectRow[\s\S]*?\n  \}/)[0];
  assert.match(store, /target="_blank" rel="noopener noreferrer">利用する/);
});

/* §11: MY PAGE 未購入は STORE へ */
test("[実ファイル] MY PAGE の未購入カードは STORE へ誘導する", () => {
  const avail = siteJsN.match(/function availableCard[\s\S]*?\n  \}/)[0];
  assert.match(avail, /href="\/store\/">STORE で購入/);
});

/* §17: note リンクは URL 未設定なら出さない共通関数 */
test("[実ファイル] noteLinkHtml は URL 未設定で空を返す（壊れたリンクを出さない）", () => {
  assert.match(siteJsN, /function noteLinkHtml/);
  const fn = siteJsN.match(/function noteLinkHtml[\s\S]*?\n  \}/)[0];
  assert.match(fn, /if \(!u\) return ""/);
});

/* §23: LOGOUT → HOME */
test("[実ファイル] LOGOUT は HOME `/` へ遷移する", () => {
  const lo = siteJsN.match(/async function logout[\s\S]*?\n  \}/)[0];
  assert.match(lo, /window\.location\.href = "\/"/);
});

/* ============ rev10 実機確認による UI 追加修正の実ファイル検証 ============ */
const siteCssR = readFileSync("public/assets/site.css", "utf8");
const siteJsR = readFileSync("public/assets/site.js", "utf8");
const indexHtmlR = readFileSync("public/index.html", "utf8");
const configR = readFileSync("public/assets/site-config.js", "utf8");

/* §1: 左 SAM カードを右列全高へ stretch しない */
test("[実ファイル] HOME 左カードは右列2段の高さへ引き伸ばされない（§1）", () => {
  assert.match(siteCssR, /\.tool-inner-3 \{ grid-template-columns: 1fr 1fr; align-items: start; \}/);
  // 旧 stretch 指定が残っていない
  assert.doesNotMatch(siteCssR, /\.tool-inner-3 \{[^}]*align-items: stretch/);
  assert.doesNotMatch(siteCssR, /\.tool-col-left \.product-card \{ flex: 1 1 auto; \}/);
});

/* §2: EARTH 表示名は 2 行（HOME/STORE/MY PAGE 統一） */
test("[実ファイル] EARTH の表示名は 2 行（HANABI PLANNER / Google Earth 連携）", () => {
  assert.match(configR, /displayNameLines: \["HANABI PLANNER", "Google Earth 連携"\]/);
  assert.match(siteJsR, /function productDisplayNameHtml/);
  // STORE 行・MY PAGE カードが 2 行対応ヘルパを使用
  assert.match(siteJsR, /'<h3>' \+ productDisplayNameHtml\(meta\) \+ '<\/h3>'/);
  assert.match(siteJsR, /'<div><h3>' \+ nameHtml \+ '<\/h3><p>'/);
  // HOME 静的カードも 2 行
  assert.match(indexHtmlR, /HANABI PLANNER<br>Google Earth 連携/);
});

/* §3: アイコンは端を切らない（contain）＋トリム済みアセット */
test("[実ファイル] 商品アイコンは端を切らずに表示（object-fit: contain）", () => {
  // 全画面 product-card の pc-icon に統一（§1/§13）。app-icon は互換維持。
  assert.match(siteCssR, /\.pc-icon img \{[^}]*object-fit: contain/);
  assert.match(siteCssR, /\.app-icon img \{[^}]*object-fit: contain/);
});

/* §4/§5: STORE 商品の境界明確化＋アイコン 52px 統一 */
test("[実ファイル] STORE/MY PAGE の商品カードは HOME 基準の product-card（§1〜§3）", () => {
  const js = readFileSync("public/assets/site.js", "utf8");
  const css = readFileSync("public/assets/site.css", "utf8");
  // storeSelectRow / launchCardHtml が product-card + theme + pc-icon 構造を生成
  const store = js.match(/function storeSelectRow[\s\S]*?\n  \}/)[0];
  assert.match(store, /product-card ' \+ productThemeClass\(meta\.code\) \+ ' store-card/);
  assert.match(store, /pc-icon/);
  const lc = js.match(/function launchCardHtml[\s\S]*?\n  \}/)[0];
  assert.match(lc, /product-card ' \+ productThemeClass\(code\) \+ ' launch-card/);
  assert.match(lc, /pc-icon/);
  // アイコンは HOME 基準の pc-icon 72px（STORE/MY PAGE を小さくしない §13）
  assert.match(css, /\.product-card \.pc-icon \{\s*\n?\s*width: 72px; height: 72px/);
  // 旧 store-row / 旧 launch-card 独自定義は撤去済み
  assert.doesNotMatch(css, /\.store-row \{/);
  assert.doesNotMatch(css, /\.launch-card \{\n  border: 1px solid/);
});

/* §6: CTA デザイン統一（Primary=btn / Secondary=btn secondary / note=sr-note） */
test("[実ファイル] HOME/STORE/MY PAGE の CTA が統一体系（§6）", () => {
  const fn = siteJsR.match(/function productLinksHtml[\s\S]*?\n  \}/)[0];
  // HOME: Primary/Secondary が btn 体系、note は noteLinkHtml 共通
  assert.match(fn, /class="btn btn-sm" href.*利用する/);
  assert.match(fn, /class="btn btn-sm secondary" href="\/store\/">STORE で見る/);
  assert.match(fn, /noteLinkHtml\(code\)/);
  // 旧 pc-link 主導線が廃止されている
  assert.doesNotMatch(fn, /pc-link app/);
  // MY PAGE: Secondary も btn secondary
  const avail = siteJsR.match(/function availableCard[\s\S]*?\n  \}/)[0];
  assert.match(avail, /btn btn-sm secondary/);
});

/* §8: ADMIN 全 5 ページに共通ヘッダー */
test("[実ファイル] ADMIN 5 ページに Platform 共通ヘッダーが組み込まれている（§8）", () => {
  const pages = [
    "public/admin/index.html",
    "public/admin/users/index.html",
    "public/admin/warnings/index.html",
    "public/admin/note/index.html",
    "public/admin/products/index.html",
  ];
  for (const p of pages) {
    const h = readFileSync(p, "utf8");
    assert.match(h, /id="site-header"/, p);
    assert.match(h, /\/assets\/site\.js/, p);
    assert.match(h, /\/assets\/site-config\.js/, p);
    // admin 固有ナビ（2 階層の下段）は維持
    assert.match(h, /admin-header/, p);
  }
  // admin.css に共通ヘッダー組込みの調整がある
  const ac = readFileSync("public/admin/assets/admin.css", "utf8");
  assert.match(ac, /body::before \{ content: none; \}/);
});

/* ============ rev12: 商品UI統一（HOME基準）・note URL・ラベル統一の実ファイル検証 ============ */
const configZ = readFileSync("public/assets/site-config.js", "utf8");
const siteJsZ = readFileSync("public/assets/site.js", "utf8");
const siteCssZ = readFileSync("public/assets/site.css", "utf8");
const supportZ = readFileSync("public/support/index.html", "utf8");

/* §7/§8: note URL は site-config が正本 */
test("[実ファイル] noteArticles: HANABI/Earth は正式URL・SUN AND MOON は null（§7/§8）", () => {
  assert.match(configZ, /hanabi: "https:\/\/note\.com\/shingo_camera\/n\/n1b987c9773bb"/);
  assert.match(configZ, /hanabiEarth: "https:\/\/note\.com\/shingo_camera\/n\/n1c252bd1f86a"/);
  assert.match(configZ, /sunAndMoon: null/);
});
test("[実ファイル] note URL がHTML/JSへハードコード重複していない（§8）", () => {
  // site-config 以外に note.com の記事URLを直書きしない
  assert.doesNotMatch(siteJsZ, /note\.com\/shingo_camera\/n\//);
  assert.doesNotMatch(supportZ, /note\.com\/shingo_camera\/n\//);
});

/* §11: SUPPORT 使い方 → note 案内（data-note-link 解決） */
test("[実ファイル] SUPPORT は HANABI/Earth の note 案内＋SAM は準備中でリンクなし（§11）", () => {
  assert.match(supportZ, /data-note-link="hanabi"/);
  assert.match(supportZ, /data-note-link="hanabiEarth"/);
  assert.match(supportZ, /SUN AND MOON PLANNER の使い方記事は現在準備中です/);
  // 汎用解決: href 設定・URL null は段落ごと非表示
  assert.match(siteJsZ, /querySelectorAll\("\[data-note-link\]"\)/);
  assert.match(siteJsZ, /a\.closest\("p"\)/);
});

/* §10: セクションラベルのゴールド統一 */
test("[実ファイル] .section-head .kicker が HOME TOOL と同じゴールド系（§10）", () => {
  const m = siteCssZ.match(/\.section-head \.kicker \{[\s\S]*?\}/)[0];
  assert.match(m, /color: var\(--sam\)/);
  assert.doesNotMatch(m, /color: var\(--text-3\)/);
});

/* §12: hover は product-card で共通・disabled は抑制 */
test("[実ファイル] 商品カード hover は product-card 共通・is-disabled は抑制（§12）", () => {
  assert.match(siteCssZ, /\.product-card:hover \{ border-color: var\(--accent-line\); transform: translateY\(-2px\)/);
  assert.match(siteCssZ, /\.product-card\.is-disabled:hover \{ border-color: var\(--line\); transform: none/);
  // STORE/MY PAGE 専用の別 hover を作っていない
  assert.doesNotMatch(siteCssZ, /\.store-card:hover/);
  assert.doesNotMatch(siteCssZ, /\.launch-card:hover/);
});

/* §6: 新 Earth アイコン（正方形・縮小のみ） */
test("[実ファイル] Earth アイコンは 256x256 の正方形アセット（§6）", async () => {
  const { execSync } = await import("node:child_process");
  const out = execSync(
    `python3 -c "from PIL import Image;i=Image.open('public/assets/icons/hanabi-google-earth.png');print(i.size==(256,256))"`,
  ).toString().trim();
  assert.equal(out, "True");
});

/* §9: CTA 3 分類が共通クラス */
test("[実ファイル] CTA: Primary/Secondary/Information が共通クラス（§9）", () => {
  // STORE 購入済みの利用する（Primary）
  assert.match(siteJsZ, /btn btn-sm sr-use/);
  // MY PAGE の STORE で購入（Secondary）
  assert.match(siteJsZ, /btn btn-sm secondary" href="\/store\/">STORE で購入/);
  // note（Information）は noteLinkHtml 共通（sr-note）
  assert.match(siteJsZ, /class="sr-note"/);
});

/* ============ rev14: 商品説明文の確定・統一（§1〜§6）の実ファイル検証 ============ */
const configD = readFileSync("public/assets/site-config.js", "utf8");
const siteJsD = readFileSync("public/assets/site.js", "utf8");
const indexHtmlD = readFileSync("public/index.html", "utf8");

const DESC_SAM = "太陽・月が人物や建物と「いつ・どこで重なるか」を未来の予定まで自動計算し、撮影計画を立てるツール。";
const DESC_HANABI = "花火と人物・建物が「どこからどう見えるか」をシミュレーションし、撮影場所や構図を事前に計画するツール。";
const DESC_EARTH = "撮影地点から花火や建物・被写体が「どこに・どう見えるのか」をGoogle Earth上で立体的に視覚化し、現地へ行く前に構図を確認できる追加機能。";

/* §1/§3: 確定文が site-config の summary（正本）に完全一致で存在 */
test("[実ファイル] 確定した3商品の説明文が site-config summary に完全一致（§1/§3）", () => {
  assert.ok(configD.includes(DESC_SAM));
  assert.ok(configD.includes(DESC_HANABI));
  assert.ok(configD.includes(DESC_EARTH));
});

/* §2: 3画面が同一正本を参照（HOME=data-product-desc、STORE/MY PAGE=meta.summary） */
test("[実ファイル] HOME/STORE/MY PAGE が同じ summary 正本から説明文を取得（§2/§3）", () => {
  // HOME: 静的文を廃止し data-product-desc で3商品を参照
  assert.match(indexHtmlD, /<p data-product-desc="SUN_AND_MOON"><\/p>/);
  assert.match(indexHtmlD, /<p data-product-desc="HANABI"><\/p>/);
  assert.match(indexHtmlD, /<p data-product-desc="HANABI_GOOGLE_EARTH"><\/p>/);
  // 解決処理が summary を埋める
  assert.match(siteJsD, /querySelectorAll\("\[data-product-desc\]"\)/);
  assert.match(siteJsD, /meta\.summary/);
  // STORE / MY PAGE のカードは meta.summary を表示（既存構造）
  const store = siteJsD.match(/function storeSelectRow[\s\S]*?\n  \}/)[0];
  assert.match(store, /esc\(meta\.summary \|\| ""\)/);
  const lc = siteJsD.match(/function launchCardHtml[\s\S]*?\n  \}/)[0];
  assert.match(lc, /esc\(summary \|\| ""\)/);
  // 説明文のハードコードが HOME に残っていない
  assert.doesNotMatch(indexHtmlD, /撮影計画を、正確に立てるためのツール/);
});

/* §4: note 案内文が description に混入していない */
test("[実ファイル] 商品説明に note 案内文が含まれない（§4）", () => {
  assert.doesNotMatch(configD, /詳しい紹介・使い方は note/);
  assert.doesNotMatch(indexHtmlD, /詳しい紹介・使い方は note/);
});

/* §5/§6: STORE の Earth のみ常時依存文・動的同義警告なし */
test("[実ファイル] 依存条件は STORE カード限定の常時表示で、二重表示しない（§5/§6）", () => {
  // depNoticeHtml は dependsOn がある商品のみ・storeSelectRow だけが使用
  assert.match(siteJsD, /function depNoticeHtml/);
  assert.match(siteJsD, /ご利用には ' \+ esc\(depName\) \+ ' が必要です。/);
  const store = siteJsD.match(/function storeSelectRow[\s\S]*?\n  \}/)[0];
  assert.match(store, /depNoticeHtml\(meta\)/);
  const lc = siteJsD.match(/function launchCardHtml[\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(lc, /depNoticeHtml/);
  assert.doesNotMatch(indexHtmlD, /ご利用には/);
  // 旧・動的 dep-note（同義警告の二重表示源）は廃止
  assert.doesNotMatch(siteJsD, /dep-note/);
});
