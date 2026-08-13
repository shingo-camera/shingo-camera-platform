/**
 * WORK-011 公開サイト 共通JS
 *
 * 役割:
 * - Header / Footer を共通描画（ログイン状態でナビ出し分け）。
 * - Supabase セッションでログイン状態を判定（既存プラットフォームと同一方式）。
 * - /home ランチャー（保有商品/購入可能/note移行導線）を既存APIから描画。
 * - 商品詳細の購入導線（未ログイン→login / 未購入→checkout / 購入済→アプリ）。
 *
 * 新しい認証方式・新APIは作らない。既存 /api/config・/api/account/products・
 * /api/entitlements・/api/purchases/checkout・/api/migrations/note/status を利用する。
 *
 * 未確定情報(URL/価格/本文)は SITE_CONFIG から読む。null はリンク非活性/プレースホルダ表示。
 */
(function () {
  "use strict";
  var CFG = window.SITE_CONFIG || {};

  // DB（/api/products）由来の販売情報キャッシュ（全画面で共有）。
  // 価格・販売可否の正本は DB。site-config は静的表示情報（説明/features/アイコン）のみ。
  // { code: { purchaseEnabled, saleType, displayPrice, billingInterval } }
  var saleInfoByCode = {};
  var saleInfoLoaded = false;   // /api/products の取得に成功したか
  async function loadSaleInfo() {
    try {
      var res = await fetch("/api/products");
      if (!res.ok) { saleInfoLoaded = false; return; }
      var body = await res.json();
      ((body.data && body.data.products) || []).forEach(function (p) {
        saleInfoByCode[p.code] = {
          name: p.name,
          purchaseEnabled: (p.purchaseEnabled === true),
          saleType: p.saleType,
          displayPrice: p.displayPrice,
          billingInterval: p.billingInterval,
          dependencies: Array.isArray(p.dependencies) ? p.dependencies : [],
        };
      });
      saleInfoLoaded = true;
    } catch (e) {
      saleInfoLoaded = false; // 取得失敗 → 安全側（価格・購入可否を推測しない）
    }
  }

  // 商品コード → 表示名（PRODUCT_NAME）。取得できない場合は null（ユーザー向けUIに商品コードを出さない）。
  function productName(code) {
    var s = saleInfoByCode[code];
    return (s && s.name) ? s.name : null;
  }

  // DEPENDENCY_REQUIRED の details から利用者向け文言を組み立てる。
  // 固定文言・特定商品のハードコードにしない。M_PRODUCT_DEPENDENCY の構造に沿って生成する:
  // - グループ内候補（requiresAnyOf）が複数 → ANY_OF（「A または B のいずれか」）
  // - グループが複数 → ALL_OF（すべて必要）。グループごとに satisfyMode を個別表現する:
  //     ENTITLEMENT_OR_CART = 既所有または同時選択で充足 / ENTITLEMENT_ONLY = 事前購入必須（同時カート不可）
  // - PRODUCT_NAME が1つでも取得できない場合は、商品コードを露出させず全体を汎用文言へフォールバック。
  // 商品名は PRODUCT_NAME（productName）を使い、商品コードや固定文字列はユーザー向けに出さない。
  function dependencyMessage(details) {
    var GENERIC = "この商品を購入するには、前提となる商品が必要です。選び直してください。";
    if (!details || !details.productCode || !Array.isArray(details.missingGroups) || details.missingGroups.length === 0) {
      return GENERIC;
    }
    var target = productName(details.productCode);
    if (!target) return GENERIC; // 対象商品名が取れない → コードを出さず汎用へ

    // 1グループを「候補を または で連結 ＋（複数候補なら）のいずれか」の句にする。
    // 候補名が1つでも取れなければ null（→呼出側で汎用フォールバック）。
    function groupPhrase(g) {
      var cands = (g && Array.isArray(g.requiresAnyOf)) ? g.requiresAnyOf : [];
      if (cands.length === 0) return null;
      var names = [];
      for (var i = 0; i < cands.length; i++) {
        var nm = productName(cands[i]);
        if (!nm) return null; // 名前不明の候補がある → 汎用へ倒す（コード露出を避ける）
        names.push(nm);
      }
      // ANY_OF: 候補が複数なら「A または B のいずれか」、単一ならその名前のみ。
      return names.length >= 2 ? (names.join(" または ") + " のいずれか") : names[0];
    }

    // ALL_OF: 複数句を「A、およびB」で連結する共通ヘルパー。
    function joinAll(list) {
      return list.length >= 2
        ? (list.slice(0, -1).join("、") + "、および" + list[list.length - 1])
        : list[0];
    }

    // グループを satisfyMode 別に句へ変換する。1つでも句が作れなければ汎用へ（コード露出回避）。
    var orCartPhrases = []; // ENTITLEMENT_OR_CART（同時選択可）
    var onlyPhrases = [];   // ENTITLEMENT_ONLY（事前購入必須）
    for (var i = 0; i < details.missingGroups.length; i++) {
      var g = details.missingGroups[i];
      var phrase = groupPhrase(g);
      if (!phrase) return GENERIC;
      if (g && g.satisfyMode === "ENTITLEMENT_ONLY") {
        onlyPhrases.push(phrase);
      } else {
        // details.satisfyMode はサーバーが DB CHECK 済みの既知値のみ返すため OR_CART として扱う。
        orCartPhrases.push(phrase);
      }
    }

    var sentences = [];
    if (orCartPhrases.length > 0) {
      var orNeeded = joinAll(orCartPhrases);
      sentences.push(orNeeded + "が必要です。すでに購入済みでない場合は、" + orNeeded + "も一緒に選択してください。");
    }
    if (onlyPhrases.length > 0) {
      var onlyNeeded = joinAll(onlyPhrases);
      // OR_CART の文が先にある場合は「また、」で接続して事前購入必須を続ける。
      var prefix = orCartPhrases.length > 0 ? "また、" : "";
      sentences.push(prefix + onlyNeeded + "を事前に購入している必要があります。");
    }
    if (sentences.length === 0) return GENERIC;

    return target + "を購入するには、" + sentences.join("");
  }

  // Store カード常時表示用の簡潔な依存案内。dependencies（M_PRODUCT_DEPENDENCY 由来のグループ）から
  // 「ご購入には ◯◯ が必要です。」相当の文を作る。M_PRODUCT_DEPENDENCY は購入可否の依存条件であり
  // 利用可否の条件ではない（isProductAvailable は依存を見ない）ため、「ご利用には」ではなく「ご購入には」とする。
  // ANY_OF は「A または B のいずれか」、複数グループ ALL_OF は「A、およびB」で連結。satisfyMode の差は
  // 常時表示では簡潔さ優先で出さない（購入導線で precheck の dependencyMessage が正確に案内する。事実と矛盾しない）。
  // PRODUCT_NAME が1つでも取れない／依存情報が無い場合は空文字（依存案内を出さない・コード非露出）。
  function dependencyNotice(depGroups) {
    if (!Array.isArray(depGroups) || depGroups.length === 0) return "";
    var groups = [];
    for (var i = 0; i < depGroups.length; i++) {
      var cands = (depGroups[i] && Array.isArray(depGroups[i].requiresAnyOf)) ? depGroups[i].requiresAnyOf : [];
      if (cands.length === 0) return "";
      var names = [];
      for (var j = 0; j < cands.length; j++) {
        var nm = productName(cands[j]);
        if (!nm) return ""; // 名前不明 → 依存案内を出さない（コード露出回避）
        names.push(nm);
      }
      groups.push(names.length >= 2 ? (names.join(" または ") + " のいずれか") : names[0]);
    }
    var needed = groups.length >= 2
      ? (groups.slice(0, -1).join("、") + "、および" + groups[groups.length - 1])
      : groups[0];
    return "ご購入には " + needed + "が必要です。";
  }

  // ---- 端末ID（プラットフォーム共通キー）----
  var deviceId = (function () {
    try {
      var k = "scp_device_id", v = localStorage.getItem(k);
      if (!v) { v = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : String(Date.now()); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return String(Date.now()); }
  })();

  // ---- Supabase client シングルトン（GoTrueClient 多重生成防止）----
  var clientPromise = null;
  function getClient() {
    if (clientPromise) return clientPromise;
    clientPromise = (async function () {
      var res = await fetch("/api/config", { headers: { "X-Device-Id": deviceId } });
      if (!res.ok) return null;
      var body = await res.json();
      if (!self.supabase || !self.supabase.createClient) return null;
      return self.supabase.createClient(body.data.supabaseUrl, body.data.supabaseAnonKey);
    })();
    return clientPromise;
  }
  async function getToken() {
    var client = await getClient();
    if (!client) return null;
    var s = await client.auth.getSession();
    return (s && s.data && s.data.session) ? s.data.session.access_token : null;
  }
  async function logout() {
    var client = await getClient();
    if (client) { try { await client.auth.signOut(); } catch (e) { /* noop */ } }
    isAdminUser = false;
    // LOGOUT 後は HOME へ（§23）。MY PAGE / ADMIN 等のログイン表示に留まらない。
    window.location.href = "/";
  }
  function authHeaders(token) {
    var h = { "X-Device-Id": deviceId };
    if (token) h["Authorization"] = "Bearer " + token;
    return h;
  }

  // ---- Header ----
  // 注: /account 画面は本WORKの実装範囲外のため、ログイン後ナビに ACCOUNT を含めない
  //     （存在しない画面への404リンクを作らない）。/account 実装時に追加する。
  // ADMIN nav 表示判定（UI のみ。セキュリティ境界はサーバーの requireAdmin が正本）。
  // 既存 GET /api/admin/dashboard の 200/403 で判定し、新しい管理者判定は作らない。
  var isAdminUser = false;
  async function checkAdmin(token) {
    if (!token) { isAdminUser = false; return; }
    try {
      var res = await fetch("/api/admin/dashboard", { headers: authHeaders(token) });
      isAdminUser = res.ok;
    } catch (e) { isAdminUser = false; }
  }

  function renderHeader(loggedIn) {
    var el = document.getElementById("site-header");
    if (!el) return;
    var brand = CFG.brandName || "shingo_camera";
    // ヘッダー最終仕様（§4）: HOME / STORE / (MY PAGE) / (ADMIN) / SUPPORT / LOGIN or LOGOUT
    var links = loggedIn
      ? ('<a href="/">HOME</a><a href="/store/">STORE</a><a href="/mypage/">MY PAGE</a>' +
         (isAdminUser ? '<a href="/admin/">ADMIN</a>' : '') +
         '<a href="/support/">SUPPORT</a><a href="#" id="nav-logout">LOGOUT</a>')
      : '<a href="/">HOME</a><a href="/store/">STORE</a><a href="/support/">SUPPORT</a><a href="/login/" class="btn-login">LOGIN</a>';
    el.innerHTML =
      '<div class="container inner">' +
      '<a class="site-brand" href="/">' + esc(brand) + '<span class="brand-labo">LABO</span></a>' +
      '<button class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="site-nav-menu" aria-label="メニューを開く">&#9776;</button>' +
      '<nav class="site-nav" id="site-nav-menu">' + links + '</nav>' +
      '</div>';
    var lo = document.getElementById("nav-logout");
    if (lo) lo.addEventListener("click", function (e) { e.preventDefault(); logout(); });
    initMobileNav(el);
  }

  // スマホ用ハンバーガーメニュー（§6）。購入 dialog とは独立の軽量トグル。
  function initMobileNav(headerEl) {
    var toggle = headerEl.querySelector("#nav-toggle");
    var nav = headerEl.querySelector("#site-nav-menu");
    if (!toggle || !nav) return;
    function setOpen(open) {
      nav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "メニューを閉じる" : "メニューを開く");
    }
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(!nav.classList.contains("open"));
    });
    // ESC で閉じる
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) setOpen(false);
    });
    // メニュー外クリックで閉じる
    document.addEventListener("click", function (e) {
      if (nav.classList.contains("open") && !nav.contains(e.target) && e.target !== toggle) setOpen(false);
    });
    // メニュー内リンククリックで閉じる
    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") setOpen(false);
    });
    // PC 幅へ戻ったら状態リセット
    window.addEventListener("resize", function () {
      if (window.innerWidth > 720 && nav.classList.contains("open")) setOpen(false);
    });
  }

  // ---- Footer（細く静かに。Instagram / note のみ）----
  function renderFooter() {
    var el = document.getElementById("site-footer");
    if (!el) return;
    var sns = CFG.sns || {};
    // PC 1行構成: 左=コピーライト / 右=リンク群。ブランド名の重複表示はしない。
    el.innerHTML =
      '<div class="container inner">' +
      '<div class="copyright">© ' + new Date().getFullYear() + ' ' + esc(CFG.brandName || "shingo_camera") + '</div>' +
      '<div class="f-links">' +
        snsLink("Instagram", sns.instagram) +
        snsLink("note", sns.note) +
        '<a href="/terms/">利用規約</a>' +
        '<a href="/privacy/">プライバシー</a>' +
        '<a href="/commercial-transactions/">特商法</a>' +
        '<a href="/support/">お問い合わせ</a>' +
      '</div>' +
      '</div>';
  }
  function snsLink(label, url) {
    if (url) return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + label + '</a>';
    // URL 未確定 → 非活性（架空URLを入れない）
    return '<span class="disabled-link" title="準備中">' + label + '（準備中）</span>';
  }

  // ---- note 誘導リンク（記事URL未確定なら非活性）----
  function noteArticleLink(key, label) {
    var arts = CFG.noteArticles || {};
    var url = arts[key];
    if (url) return '<a class="btn secondary" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + '</a>';
    return '<span class="btn secondary disabled" title="準備中">' + esc(label) + '（準備中）</span>';
  }

  // ---- PLANNER SERIES カードの2導線（APP を開く / 紹介・使い方を見る(note)）----
  // 購入導線は持たない（購入は STORE に集約）。APP はアプリ起動、NOTE は記事誘導。
  // HOME 商品カードの granted 状態（boot がログイン時に /api/account/products から取得）。
  var homeGranted = {};

  function productLinksHtml(code) {
    var meta = productMeta(code) || {};
    var granted = !!homeGranted[code];

    // 主導線（§18）:
    //   購入済み + appUrl あり → 「利用する」（別タブ §19）
    //   購入済み + appUrl なし（EARTH / HANABI 現状）→ 所有バッジのみ（起動導線を作らない）
    //   未購入 / 未ログイン → STORE へ（未ログインは購入済みか判定できないため断定しない）
    // CTA デザイン統一（§6）: Primary=利用する(.btn) / Secondary=STORE で見る(.btn.secondary) /
    // note=詳しく見る(.sr-note テキストリンク)。HOME/STORE/MY PAGE で同一体系。
    var mainHtml;
    if (granted && meta.appUrl) {
      mainHtml = '<a class="btn btn-sm" href="' + esc(meta.appUrl) + '" target="_blank" rel="noopener noreferrer">利用する</a>';
    } else if (granted) {
      mainHtml = '<span class="badge badge-owned">購入済み</span>';
    } else {
      mainHtml = '<a class="btn btn-sm secondary" href="/store/">STORE で見る</a>';
    }
    return mainHtml + noteLinkHtml(code);
  }

  // ---- /home ランチャー ----
  async function initMypage() {
    var token = await getToken();
    if (!token) { window.location.href = "/login/?redirect=" + encodeURIComponent("/mypage/"); return; }

    var ownedEl = document.getElementById("owned-products");
    var availEl = document.getElementById("available-products");
    var noteEl = document.getElementById("note-migration");

    // 商品権限一覧（granted/available）
    var products = [];
    try {
      var res = await fetch("/api/account/products", { headers: authHeaders(token) });
      if (res.status === 401) { window.location.href = "/login/?redirect=" + encodeURIComponent("/mypage/"); return; }
      if (res.ok) { var body = await res.json(); products = (body.data && body.data.products) || []; }
    } catch (e) { /* 表示は空で継続 */ }

    var owned = [], avail = [];
    products.forEach(function (p) { (p.available ? owned : avail).push(p); });

    // 利用可能（保有）
    if (ownedEl) {
      if (owned.length === 0) {
        ownedEl.innerHTML = '<p class="launcher-empty">利用可能な商品はまだありません。</p>';
      } else {
        ownedEl.innerHTML = owned.map(function (p) { return ownedCard(p); }).join("");
      }
    }
    // 購入可能（未保有）
    if (availEl) {
      if (avail.length === 0) {
        availEl.innerHTML = '<p class="launcher-empty">現在購入可能な商品はありません。</p>';
      } else {
        availEl.innerHTML = avail.map(function (p) { return availableCard(p); }).join("");
      }
    }

    // note 移行導線（既存HANABI購入者）
    if (noteEl) {
      try {
        var mres = await fetch("/api/migrations/note/status", { headers: authHeaders(token) });
        if (mres.ok) {
          // note 購入者向けの権限復元入口は STORE 内に集約。ここでは STORE へ誘導するのみ。
          noteEl.innerHTML =
            '<h2>note で購入された方</h2>' +
            '<p class="text-muted">note で購入した HANABI PLANNER の移行・権限の復元は STORE から行えます。</p>' +
            '<a class="btn secondary" href="/store/">STORE を見る</a>';
          noteEl.classList.remove("hidden");
        }
      } catch (e) { /* 導線は任意表示 */ }
    }
  }

  function ownedCard(p) {
    var meta = productMeta(p.code);
    var appUrl = meta && meta.appUrl ? meta.appUrl : null;
    var action = appUrl
      ? '<a class="btn btn-sm" href="' + esc(appUrl) + '" target="_blank" rel="noopener noreferrer">利用する</a>'
      : '<span class="btn disabled">準備中</span>';
    return launchCardHtml(meta, p, action);
  }
  function availableCard(p) {
    var meta = productMeta(p.code);
    // 販売可否の正本は DB（/api/account/products の purchaseEnabled + saleType）。
    // purchaseEnabled===true かつ saleType==='ONE_TIME' の商品だけ購入導線を出す。
    // SUBSCRIPTION は実決済未対応のため購入不可。取得できない場合も安全側（準備中）。
    var onSale = (p.purchaseEnabled === true && p.saleType === "ONE_TIME");
    var action = onSale
      ? '<a class="btn btn-sm secondary" href="/store/">STORE で購入</a>'
      : '<span class="badge">' + esc((meta && meta.badge) || "準備中") + '</span>';
    return launchCardHtml(meta, p, action);
  }
  function launchCardHtml(meta, p, actionHtml) {
    var name = meta ? meta.displayName : p.name;
    var nameHtml = meta ? productDisplayNameHtml(meta) : esc(p.name);
    var summary = meta ? meta.summary : "";
    var icon = meta && meta.icon;
    var code = (meta && meta.code) || p.code;
    var iconHtml = icon
      ? '<img src="' + esc(icon) + '" alt="' + esc(name) + '" />'
      : '<span class="icon-fallback">ICON</span>';
    // HOME の商品カードを正本としたカード構造（§1/§3）。
    return '<div class="product-card ' + productThemeClass(code) + ' launch-card">' +
      '<div class="pc-body">' +
        '<div class="pc-icon">' + iconHtml + '</div>' +
        '<div><h3>' + nameHtml + '</h3><p>' + esc(summary || "") + '</p></div>' +
      '</div>' +
      '<div class="pc-cta pc-links">' + actionHtml + noteLinkHtml(code) + '</div>' +
    '</div>';
  }

  function productMeta(code) {
    return (CFG.products && CFG.products[code]) || null;
  }

  // ---- 商品詳細（SUN AND MOON）購入導線 ----
  async function initSunAndMoonDetail() {
    var btnWrap = document.getElementById("sam-action");
    if (!btnWrap) return;
    var token = await getToken();

    // Products は「何ができるか」。購入は STORE に集約。
    if (!token) {
      btnWrap.innerHTML = '<a class="btn" href="/store/">STORE で購入する</a>' +
        '<a class="btn secondary mt-16" href="/apps/sun-and-moon/">アプリを開く</a>';
      return;
    }
    // 権限確認
    var granted = false;
    try {
      var res = await fetch("/api/entitlements/SUN_AND_MOON", { headers: authHeaders(token) });
      granted = res.ok;
    } catch (e) { granted = false; }

    if (granted) {
      btnWrap.innerHTML = '<a class="btn" href="/apps/sun-and-moon/">アプリを開く</a>';
    } else {
      // 未購入 → STORE へ誘導（購入導線は STORE に集約）
      btnWrap.innerHTML = '<a class="btn" href="/store/">STORE で購入する</a>';
    }
  }

  // ---- 進行中 Checkout の記録（localStorage・operationId 保持）----
  var PENDING_KEY = "shingo_pending_checkout";
  function getPending() {
    try { var v = localStorage.getItem(PENDING_KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function setPending(operationId, codes) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ operationId: operationId, codes: codes })); } catch (e) {}
  }
  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
  }
  // 新 attempt が作成されていないことがサーバーレスポンスから確定した場合に、送信前の
  // pending（prevPending）へ復元する。prevPending が無ければ clear。これにより、まだ
  // attempt が存在しない新 operationId を pending に残さない。
  function restorePending(prevPending) {
    if (prevPending && prevPending.operationId) {
      setPending(prevPending.operationId, prevPending.codes);
    } else {
      clearPending();
    }
  }
  function newOperationId() {
    return (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : null;
  }

  // ---- Checkout 開始（複数商品・operationId）----
  // codes: 選択された PRODUCT_CODE 配列。operationId は購入操作ごとに 1 回生成し、
  // 同一操作の再送では同じ値を使う（HTTP 再送収束）。UI 表示は正本にせず、
  // 可否はサーバー(checkout API)が最終判定する。
  // Stripe Checkout 遷移前の購入条件確認モーダル（client-side のみ・決済処理は変更しない）。
  // 確認で true、キャンセルで false を返す。金額は site-config の表示用 amount/priceDisplay を
  // 使う（実課金額の正本は Stripe Price のまま。ここは利用者向け表示専用）。
  // 購入確認モーダル用: DB DISPLAY_PRICE を金額の正本として引く。
  // saleInfoByCode（/api/products 由来）に無ければ 0（＝金額不明・安全側）。site-config の amount は使わない。
  function priceOf(code) {
    var s = saleInfoByCode[code];
    return (s && typeof s.displayPrice === "number") ? s.displayPrice : 0;
  }

  function showPurchaseConfirm(codes) {
    return new Promise(function (resolve) {
      var items = codes.map(function (c) {
        var m = productMeta(c) || {};
        var amt = priceOf(c); // DB DISPLAY_PRICE が正本
        var name = (m.displayName || m.name || c);
        return { name: name, amount: amt };
      });
      var total = items.reduce(function (s, it) { return s + it.amount; }, 0);

      var ov = document.createElement("div");
      ov.className = "pconf-overlay";
      var rows = items.map(function (it) {
        return '<div class="pconf-row"><span>' + esc(it.name) + '</span>' +
          '<span>¥' + it.amount.toLocaleString() + '</span></div>';
      }).join("");

      ov.innerHTML =
        '<div class="pconf" role="dialog" aria-modal="true" aria-labelledby="pconf-title">' +
          '<h2 id="pconf-title" class="pconf-title">購入内容の確認</h2>' +
          '<div class="pconf-items">' + rows +
            '<div class="pconf-row pconf-total"><span>合計（税込）</span>' +
            '<span>¥' + total.toLocaleString() + '</span></div>' +
          '</div>' +
          '<p class="pconf-note">デジタル商品のため、購入者都合による返品・キャンセルは原則お受けしていません。</p>' +
          '<div class="pconf-actions">' +
            '<button type="button" class="btn secondary" id="pconf-cancel">戻る</button>' +
            '<button type="button" class="btn btn-primary" id="pconf-proceed">Stripeで購入手続きへ</button>' +
          '</div>' +
        '</div>';

      function close(result) {
        document.removeEventListener("keydown", onKey);
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        resolve(result);
      }
      function onKey(e) { if (e.key === "Escape") close(false); }

      document.body.appendChild(ov);
      document.addEventListener("keydown", onKey);
      ov.addEventListener("click", function (e) { if (e.target === ov) close(false); });
      ov.querySelector("#pconf-cancel").addEventListener("click", function () { close(false); });
      ov.querySelector("#pconf-proceed").addEventListener("click", function () { close(true); });
    });
  }

  async function startMultiCheckout(codes, btn, operationId, restart) {
    if (!codes || codes.length === 0) return;
    var opId = operationId || newOperationId();
    if (!opId) { await notify("お使いのブラウザでは購入手続きを開始できません。"); return; }

    if (btn) { btn.disabled = true; btn.textContent = "処理中…"; }
    var token = await getToken();
    if (!token) { window.location.href = "/login/?redirect=" + encodeURIComponent("/store/"); return; }

    // 送信前の pending を退避（RESTART_CONFIRM で「戻る」を選んだ場合に復元し、
    // まだ attempt が作られていない新 operationId を pending に残さないため）。
    var prevPending = getPending();
    setPending(opId, codes);
    try {
      var payload = { productCodes: codes, operationId: opId };
      if (restart) payload.restart = true;
      var res = await fetch("/api/purchases/checkout", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(token)),
        body: JSON.stringify(payload),
      });
      var body = null;
      try { body = await res.json(); } catch (e) {}

      if (res.ok && body && body.data) {
        if (body.data.checkoutUrl) { window.location.href = body.data.checkoutUrl; return; }
        if (body.data.alreadyPaid) {
          clearPending();
          await notify("この商品は購入済みです。");
          location.reload();
          return;
        }
      }

      // エラー分類に応じた案内（サーバーが正本）
      var code = body && body.error && body.error.code;
      if (res.status === 409 && code === "CHECKOUT_RESTART_CONFIRM") {
        // 以前の未完了 Checkout が残っている → 再開始確認（共通ダイアログ）
        if (btn) { btn.disabled = false; btn.textContent = "選択した商品を購入"; }
        var proceed = window.showDialog
          ? await showDialog({
              title: "以前の購入手続きが残っています",
              message:
                "以前開始した購入手続きが残っています。\n新しく購入を進めると、\n以前の購入画面は利用できなくなります。\n新しく購入を進めますか？",
              primaryText: "新しく購入する",
              secondaryText: "戻る",
              variant: "confirm",
            })
          : confirm("以前開始した購入手続きが残っています。新しく購入を進めますか？");
        if (proceed) {
          // 同じ operationId で restart 実行（旧 Session を expire 後に新規作成）
          await startMultiCheckout(codes, btn, opId, true);
        } else {
          // 「戻る」→ 旧購入手続きは何も変更しない。まだ attempt が存在しない新 operationId を
          // pending に残さず、送信前の状態（旧 pending or なし）へ復元する。
          restorePending(prevPending);
        }
        return;
      } else if (res.status === 503 && code === "CHECKOUT_RESTART_PENDING") {
        // 旧手続きが状態不明で新規は作られていない（新 attempt 未作成が確定）→ 復元。
        restorePending(prevPending);
        await notify("以前の購入手続きの状態を確認しています。しばらくしてから、もう一度お試しください。");
      } else if (res.status === 409 && (code === "CHECKOUT_EXPIRED" || code === "OPERATION_CLOSED")) {
        // 「購入手続きを再開」を押した時点で、対象 Session が既に expired／終了していた。
        // サーバー側で EXPIRED 同期・lock 解放は実施済み。pending を消し、明示的に通知する（仕様5）。
        clearPending();
        await notify("前回の購入手続きは有効期限が切れたため終了しました。\nもう一度購入手続きを開始してください。");
        reInitCurrentPage(); // STORE を再取得してバナーを消す（サーバーは resumable=null になる）
      } else if (res.status === 409 && code === "ALREADY_IN_PROGRESS") {
        // lock 競合で作成が rollback（新 attempt 未作成が確定）→ 復元。
        restorePending(prevPending);
        await notify("同じ商品の購入手続きが進行中です。少し待ってから、もう一度お試しください。");
      } else if (res.status === 409 && code === "OPERATION_MISMATCH") {
        clearPending();
        await notify("購入内容が変わりました。もう一度選び直してください。");
      } else if (res.status === 409 && code === "DEPENDENCY_REQUIRED") {
        // precheck 拒否（create 前・新 attempt 未作成が確定）→ 復元。
        restorePending(prevPending);
        await notify(dependencyMessage(body && body.error && body.error.details));
      } else if (res.status === 409 && code === "ALREADY_PURCHASED") {
        // precheck 拒否（新 attempt 未作成が確定）。旧 pending の導線を消さないよう prevPending へ復元。
        restorePending(prevPending);
        await notify("選択した商品の中に購入済みのものがあります。選び直してください。");
      } else if (res.status === 429) {
        await notify("混み合っています。少し待って再度お試しください。");
      } else if (res.status === 503 && code === "CHECKOUT_RETRY") {
        await notify("通信が不安定です。もう一度お試しください。");
      } else if (res.status === 503) {
        await notify("購入処理を確認しています。しばらくしてからご確認ください。");
      } else if (res.status === 403 && code === "AUTH_EMAIL_REQUIRED") {
        await notify("購入手続きに必要なメール情報を確認できませんでした。再度ログインしてお試しください。");
      } else if (res.status === 502 && code === "CHECKOUT_CREATE_FAILED") {
        // Stripe create の確定失敗（サーバーで cancelAttempt 済み・Session 未作成が確定）。
        // 新 Checkout は存在しない terminal failure → 旧 pending の導線を消さず prevPending へ復元。
        restorePending(prevPending);
        await notify("購入手続きを開始できませんでした。時間をおいて再度お試しください。");
      } else {
        await notify("購入手続きを開始できませんでした。時間をおいて再度お試しください。");
      }
    } catch (e) {
      await notify("通信エラーが発生しました。");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "選択した商品を購入"; }
    }
  }

  // 通知（共通ダイアログがあれば info、無ければ alert フォールバック）
  async function notify(message) {
    if (window.showDialog) {
      await showDialog({ title: "購入手続き", message: message, variant: "info" });
    } else {
      alert(message);
    }
  }

  // 進行中 attempt の再開（同じ operationId で checkout 再送 → 既存 Checkout URL / 成立確認）
  async function resumeCheckout(pending, btn) {
    if (!pending || !pending.operationId) return;
    await startMultiCheckout(pending.codes || [], btn, pending.operationId);
  }

  // 進行中 attempt のキャンセル（operationId ベース。sessionId は送らない）
  async function cancelCheckout(pending, btn) {
    if (!pending || !pending.operationId) return;
    if (btn) { btn.disabled = true; btn.textContent = "取消中…"; }
    var token = await getToken();
    if (!token) { window.location.href = "/login/?redirect=" + encodeURIComponent("/store/"); return; }
    try {
      var res = await fetch("/api/purchases/cancel", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(token)),
        body: JSON.stringify({ operationId: pending.operationId }),
      });
      var body = null;
      try { body = await res.json(); } catch (e) {}
      var result = body && body.data && body.data.result;
      // terminal（終着が確認できた）場合のみ pending を消す。
      if (res.ok && (result === "cancelled" || result === "expired" || result === "already_paid")) {
        clearPending();
        location.reload();
        return;
      }
      // 状態不明（CANCEL_INDETERMINATE / CANCEL_RETRY）・その他失敗 → pending 維持・再開導線を残す。
      if (btn) { btn.disabled = false; btn.textContent = "取り消す"; }
      await notify("購入手続きの状態を確認しています。しばらくしてから、もう一度お試しください。");
    } catch (e) {
      // 通信失敗 → pending 維持。
      if (btn) { btn.disabled = false; btn.textContent = "取り消す"; }
      await notify("通信エラーが発生しました。もう一度お試しください。");
    }
  }

  // ---- STORE（複数選択・合計・1 回 Checkout）----
  async function initStore() {
    var wrap = document.getElementById("store-products");
    if (!wrap) return;
    var token = await getToken();

    var products = (CFG.products && Object.keys(CFG.products).map(function (k) { return CFG.products[k]; })) || [];
    // 発売中・準備中を問わず全商品カードを表示する（準備中商品もカードは出す）。順序は既存のまま。
    var storeProducts = products;

    // 販売状態の正本は DB（M_PRODUCT）。/api/products（公開）から取得し、code で商品にマージする。
    // 販売可否は DB で purchaseEnabled===true かつ saleType==='ONE_TIME' と確認できた商品だけ購入可能表示。
    // 取得に失敗した場合や DB に該当が無い商品は、購入可能と推測せず安全側（準備中）へ倒す。
    await loadSaleInfo();
    var saleLoadFailed = !saleInfoLoaded;
    storeProducts.forEach(function (m) {
      var s = saleInfoByCode[m.code];
      if (s) {
        // DB で確認できた販売情報で上書き（これが正本）。
        m.purchaseEnabled = (s.purchaseEnabled === true);
        m.saleType = s.saleType;
        m.displayPrice = s.displayPrice;
        m.billingInterval = s.billingInterval;
      } else {
        // DB で確認できない商品は購入可能にしない（安全側）。
        m.purchaseEnabled = false;
        m.saleUnknown = true; // 販売状態を確認できなかった（読込失敗 or 該当なし）
      }
    });

    // 購入済み判定（ログイン時のみ）
    var grantedSet = {};
    if (token) {
      try {
        var res = await fetch("/api/account/products", { headers: authHeaders(token) });
        if (res.ok) {
          var body = await res.json();
          ((body.data && body.data.products) || []).forEach(function (p) { if (p.granted) grantedSet[p.code] = true; });
        }
      } catch (e) { /* 判定不能時は未購入扱い */ }
    }

    // 進行中バナーの正本はサーバー側の active checkout（AUTH_USER_ID 基準・Stripe 状態確認済み）。
    // localStorage は補助（別端末では空でもサーバーから復元できる）。ログイン時のみ問い合わせる。
    var resumable = null;
    var acConfirmed = false; // サーバーが正常応答し「再開可能状態」を確定できたか
    if (token) {
      try {
        var acRes = await fetch("/api/purchases/active-checkout", { headers: authHeaders(token) });
        if (acRes.ok) {
          var acBody = await acRes.json();
          if (acBody && acBody.result === "OK" && acBody.data) {
            resumable = acBody.data.resumable || null;
            acConfirmed = true; // 200 + 正常 JSON のときのみ確定
          }
        }
        // 5xx（ACTIVE_CHECKOUT_PENDING 等）や非 OK はサーバー状態を確定できていない → acConfirmed=false
      } catch (e) {
        // 通信失敗 / JSON 取得失敗 → 確定できない。localStorage は勝手に削除しない。
      }
    }
    // サーバーで「再開可能な手続きが無い」ことを確定できたときのみ、古い localStorage を消す。
    // 通信失敗・5xx・JSON 失敗では補助情報を保持する（誤削除で再開導線を失わないため）。
    if (acConfirmed) {
      if (!resumable) {
        clearPending();
      } else {
        setPending(resumable.operationId, resumable.productCodes || []);
      }
    }
    var pending = resumable
      ? { operationId: resumable.operationId, codes: resumable.productCodes || [] }
      : null;
    var pendingHtml = "";
    if (token && pending && pending.operationId) {
      pendingHtml =
        '<div class="store-pending" role="status">' +
        '<p>購入手続き中の商品があります。</p>' +
        '<div class="sp-actions">' +
        '<button class="btn" id="resume-checkout">購入手続きを再開</button> ' +
        '<button class="btn btn-ghost" id="cancel-checkout">取り消す</button>' +
        '</div></div>';
    }

    // STORE は誰でも閲覧可能（未ログインでも商品を表示し、購入操作時のみログインへ誘導）。

    var rows = storeProducts.map(function (m) { return storeSelectRow(m, !!grantedSet[m.code], !!token); }).join("");
    wrap.innerHTML =
      pendingHtml +
      '<div class="store-select-list">' + (rows || '<p class="launcher-empty">現在購入可能な商品はありません。</p>') + '</div>' +
      '<div class="store-summary">' +
        '<div class="ss-total">合計: <span id="store-total">¥0</span></div>' +
        '<button class="btn" id="store-buy" disabled>選択した商品を購入</button>' +
        '<p class="store-agree">購入手続きを進めることで、<a href="/terms/" target="_blank" rel="noopener">利用規約</a>に同意したものとします。</p>' +
      '</div>';

    // 進行中バナーのイベント
    if (pending && pending.operationId) {
      var rb = document.getElementById("resume-checkout");
      var cb = document.getElementById("cancel-checkout");
      if (rb) rb.addEventListener("click", function () { resumeCheckout(pending, rb); });
      if (cb) cb.addEventListener("click", function () { cancelCheckout(pending, cb); });
    }

    var buyBtn = document.getElementById("store-buy");
    var totalEl = document.getElementById("store-total");
    var boxes = Array.prototype.slice.call(wrap.querySelectorAll("input[data-select]"));

    function selectedCodes() {
      return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute("data-select"); });
    }
    // storeProducts（DB 情報マージ済み）を code で引く lookup。
    var metaByCode = {};
    storeProducts.forEach(function (m) { metaByCode[m.code] = m; });
    function amountOf(code) {
      var m = metaByCode[code];
      // DB DISPLAY_PRICE が金額の正本。無ければ 0（site-config の amount は使わない）。
      return (m && typeof m.displayPrice === "number") ? m.displayPrice : 0;
    }
    function refresh() {
      // 依存条件は STORE カード内に常時表示（sr-dep §5/§6）。動的な同義警告は重複するため出さない。
      // 依存充足の最終判定はサーバー（precheck / dependency check）が行う（不変）。
      var codes = selectedCodes();
      var total = codes.reduce(function (s, c) { return s + amountOf(c); }, 0);
      if (totalEl) totalEl.textContent = "¥" + total.toLocaleString();
      if (buyBtn) buyBtn.disabled = codes.length === 0;
    }

    boxes.forEach(function (b) { b.addEventListener("change", refresh); });
    if (buyBtn) {
      buyBtn.addEventListener("click", async function () {
        var codes = selectedCodes();
        if (codes.length === 0) return;
        // 未ログインで購入操作 → ログインへ誘導し、成功後 STORE へ戻す（購入時のみ認証必須）。
        if (!token) {
          window.location.href = "/login/?redirect=" + encodeURIComponent("/store/");
          return;
        }
        // 保険: 購入不可（準備中・非対応販売方式）商品が万一混ざっていたら購入へ進めない。
        // 最終判定はサーバー（precheckMultiCheckout が M_PRODUCT を正本に判定）が行う。
        // ここでは DB で purchaseEnabled===true かつ saleType==='ONE_TIME' の商品のみ許可。
        var hasNotOnSale = codes.some(function (c) {
          var m = metaByCode[c];
          return !(m && m.purchaseEnabled === true && m.saleType === "ONE_TIME");
        });
        if (hasNotOnSale) {
          await notify("選択された商品の中に、現在購入できない商品が含まれています。");
          return;
        }
        // 依存条件の事前チェック（Stripe Checkout を作らない）。
        // 依存 NG（DEPENDENCY_REQUIRED）なら、購入内容確認モーダルを出す前に停止して案内する。
        // 依存判定の正本はサーバー（M_PRODUCT_DEPENDENCY）。ここでは HANABI 等の固有条件を持たず、
        // 自動で本体商品を選択しない（ユーザーに選び直させる）。
        // このチェックは UX 改善であり、購入実行時の依存チェック（handleCheckout）を代替しない。
        if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = "確認中…"; }
        var depOk = false;
        try {
          var depRes = await fetch("/api/purchases/precheck-dependency", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(token)),
            body: JSON.stringify({ productCodes: codes }),
          });
          if (depRes.ok) {
            depOk = true;
          } else {
            var depBody = null;
            try { depBody = await depRes.json(); } catch (e) {}
            var depCode = depBody && depBody.error && depBody.error.code;
            if (depRes.status === 409 && depCode === "DEPENDENCY_REQUIRED") {
              await notify(dependencyMessage(depBody && depBody.error && depBody.error.details));
            } else if (depRes.status === 401) {
              window.location.href = "/login/?redirect=" + encodeURIComponent("/store/");
              return;
            } else {
              // その他は購入内容確認モーダルへ進める（最終判定はサーバーの checkout が行う）。
              depOk = true;
            }
          }
        } catch (e) {
          // 通信失敗時は事前チェックをスキップし、従来どおり最終判定をサーバーに委ねる。
          depOk = true;
        } finally {
          if (buyBtn) { buyBtn.disabled = codes.length === 0; buyBtn.textContent = "選択した商品を購入"; }
        }
        if (!depOk) return;
        // Stripe Checkout へ遷移する前に、購入条件・法務条件の確認ステップを挟む。
        // 確認された場合のみ既存 startMultiCheckout を呼ぶ（キャンセル時は checkout API を呼ばない）。
        var proceed = await showPurchaseConfirm(codes);
        if (!proceed) return;
        startMultiCheckout(codes, buyBtn, null);
      });
    }
    refresh();
  }

  // 選択行（購入済みは選択不可・購入済み表示）
  // STORE 固有の利用条件表示（§5）: 依存商品がある場合のみ「ご購入には ◯◯ が必要です。」
  // M_PRODUCT_DEPENDENCY は購入可否の依存（利用可否ではない）。正本は /api/products の dependencies。
  // 正本は M_PRODUCT_DEPENDENCY（/api/products の dependencies）。site-config の固定 dependsOn は使わない。
  // 商品 description には含めず、HOME / MY PAGE では表示しない。
  function depNoticeHtml(meta) {
    if (!meta) return "";
    // dependencies は /api/products 由来（saleInfoByCode 経由でも meta 直下でも可）。
    var info = saleInfoByCode[meta.code];
    var groups = (info && Array.isArray(info.dependencies)) ? info.dependencies
      : (Array.isArray(meta.dependencies) ? meta.dependencies : []);
    var text = dependencyNotice(groups);
    if (!text) return ""; // 依存なし・名前不明 → 依存案内を出さない（コード非露出）
    return '<p class="sr-dep muted-note">' + esc(text) + '</p>';
  }

  // 表示価格文字列を生成する（DB の displayPrice / saleType / billingInterval が正本）。
  // ONE_TIME: "¥13,000" / SUBSCRIPTION+MONTH: "¥980 / 月" / +YEAR: "¥xxx / 年"。
  // DB 値が無い場合は site-config の静的表示（priceDisplay）にフォールバックする。
  function formatDisplayPrice(meta) {
    if (typeof meta.displayPrice === "number") {
      var base = "¥" + meta.displayPrice.toLocaleString();
      if (meta.saleType === "SUBSCRIPTION") {
        var unit = meta.billingInterval === "YEAR" ? "年"
          : meta.billingInterval === "MONTH" ? "月"
          : null;
        return unit ? (base + " / " + unit) : base;
      }
      return base;
    }
    // DB から価格を取得できない場合は、site-config の古い静的価格を使わず安全側表示にする。
    return "価格情報を取得できません";
  }

  function storeSelectRow(meta, granted, loggedIn) {
    var iconHtml = meta.icon ? '<img src="' + esc(meta.icon) + '" alt="" />' : '<span class="icon-fallback">ICON</span>';
    var price = formatDisplayPrice(meta);
    // 販売可否の正本は DB（/api/products）の purchaseEnabled + saleType。
    // 購入可能にするのは purchaseEnabled===true かつ saleType==='ONE_TIME' の商品のみ。
    // SUBSCRIPTION は実決済未対応のため購入不可（準備中）。取得失敗も安全側（準備中）。
    var onSale = (meta.purchaseEnabled === true && meta.saleType === "ONE_TIME");
    var cta;
    if (granted) {
      // 購入済み: バッジ＋（APP があれば）利用する導線。再購入させない。
      // （既存購入者は販売停止の影響を受けず、利用権はそのまま表示する）
      var useHtml = meta.appUrl
        ? '<a class="btn btn-sm sr-use" href="' + esc(meta.appUrl) + '" target="_blank" rel="noopener noreferrer">利用する</a>'
        : '';
      cta = '<span class="badge badge-owned">購入済み</span>' + useHtml;
    } else if (!onSale) {
      // 未発売（準備中）: 選択チェックボックスを出さない＝購入対象として選べない。
      // DB で purchaseEnabled=true と確認できない限りここに入る（取得失敗も安全側で準備中）。
      cta = '<span class="badge badge-soon">準備中</span>';
    } else {
      // 未購入かつ販売中: 選択チェックボックス（未ログインでも表示。購入操作時にログイン誘導）。
      cta =
        '<label class="store-check">' +
          '<input type="checkbox" data-select="' + esc(meta.code) + '" /> 選択' +
        '</label>';
    }
    // HOME の商品カードを正本としたカード構造（§1/§2）。theme で hover/アクセントも共通化。
    return '<div class="product-card ' + productThemeClass(meta.code) + ' store-card' + (granted ? " is-owned" : "") + (!onSale && !granted ? " is-soon" : "") + '">' +
      '<div class="pc-body">' +
        '<div class="pc-icon">' + iconHtml + '</div>' +
        '<div>' +
          '<h3>' + productDisplayNameHtml(meta) + '</h3>' +
          '<p>' + esc(meta.summary || "") + '</p>' +
          depNoticeHtml(meta) +
          '<div class="sr-price">' + price + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pc-cta pc-links">' + cta + noteLinkHtml(meta.code) + '</div>' +
    '</div>';
  }


  // 商品コード → HOME カードのテーマクラス（§1: 同じ商品はどの画面でも同じカード）
  function productThemeClass(code) {
    return code === "SUN_AND_MOON" ? "theme-sam" : "theme-hanabi";
  }

  // 商品表示名 HTML（displayNameLines があれば 2 行表示 §2。各行 esc 済み）
  function productDisplayNameHtml(meta) {
    if (meta && meta.displayNameLines && meta.displayNameLines.length) {
      return meta.displayNameLines.map(esc).join("<br>");
    }
    return esc(meta ? meta.displayName : "");
  }

  // note リンク（URL 未設定なら何も出さない = 壊れたリンクを表示しない）
  function noteLinkHtml(code) {
    var u = productNoteUrl(code);
    if (!u) return "";
    return '<a class="sr-note" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">詳しく見る（note）</a>';
  }

  // 商品コード → note 紹介記事 URL（未設定なら null）
  function productNoteUrl(code) {
    var key = code === "SUN_AND_MOON" ? "sunAndMoon" : (code === "HANABI" ? "hanabi" : (code === "HANABI_GOOGLE_EARTH" ? "hanabiEarth" : null));
    return key && CFG.noteArticles ? (CFG.noteArticles[key] || null) : null;
  }

  // ---- ユーティリティ ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- アプリアイコンの描画（実画像があれば表示。なければ枠のみ・架空生成しない）----
  function applyAppIcons() {
    document.querySelectorAll("[data-app-icon]").forEach(function (el) {
      var code = el.getAttribute("data-app-icon");
      var meta = productMeta(code);
      var icon = meta && meta.icon;
      if (icon) {
        el.innerHTML = '<img src="' + esc(icon) + '" alt="' + esc(meta.displayName || code) + '" />';
      } else {
        // 実アイコン未配置 → 表示位置のみ（架空アイコンを描かない）
        el.innerHTML = '<span class="icon-fallback">ICON</span>';
      }
    });
  }

  // ---- Hero / 価格 / note導線 のプレースホルダ適用 ----
  function applyConfigPlaceholders() {
    // Hero
    var heroH = document.getElementById("hero-copy");
    if (heroH && CFG.heroCopy) heroH.textContent = CFG.heroCopy;
    var heroP = document.getElementById("hero-sub");
    if (heroP) { if (CFG.heroSub) heroP.textContent = CFG.heroSub; else heroP.classList.add("hidden"); }

    // SUN AND MOON 価格
    var priceEl = document.getElementById("sam-price");
    if (priceEl) {
      // 価格の正本は DB（/api/products の DISPLAY_PRICE）。site-config の静的価格は使わない。
      // 取得できない場合は古い価格を出さず安全側表示にする。
      priceEl.textContent = "価格を読み込み中…";
      loadSaleInfo().then(function () {
        var s = saleInfoByCode["SUN_AND_MOON"];
        if (s && typeof s.displayPrice === "number") {
          priceEl.textContent = formatDisplayPrice({
            displayPrice: s.displayPrice,
            saleType: s.saleType,
            billingInterval: s.billingInterval,
          });
        } else {
          priceEl.innerHTML = '価格情報を取得できません <span class="muted-note">（時間をおいて再度お試しください）</span>';
        }
      });
    }
    // note 誘導（SUN AND MOON 詳細）
    var noteWrap = document.getElementById("sam-note-link");
    if (noteWrap) noteWrap.innerHTML = noteArticleLink("sunAndMoon", "詳しい使い方・作例を見る（note）");

    // トップ PLANNER SERIES カードの2導線（APP / NOTE）。購入は STORE へ分離。
    document.querySelectorAll("[data-product-links]").forEach(function (el) {
      el.innerHTML = productLinksHtml(el.getAttribute("data-product-links"));
    });

    // 旧: 行形式の HANABI note 導線（詳細ページ等で使用）
    // 商品説明文の解決（§2/§3: HOME/STORE/MY PAGE は site-config の summary を唯一の正本とする）
    document.querySelectorAll("[data-product-desc]").forEach(function (el) {
      var meta = productMeta(el.getAttribute("data-product-desc"));
      el.textContent = (meta && meta.summary) || "";
    });

    // note 記事リンクの汎用解決（§8: URL は site-config を正本にし、HTML へハードコードしない）。
    // data-note-link="hanabi|hanabiEarth|sunAndMoon" の <a> に href を設定。URL 未設定（null）の
    // 場合は、無効リンクを出さないため最も近い段落（p）ごと非表示にする。
    document.querySelectorAll("[data-note-link]").forEach(function (a) {
      var key = a.getAttribute("data-note-link");
      var url = CFG.noteArticles ? CFG.noteArticles[key] : null;
      if (url) {
        a.href = url;
      } else {
        var p = a.closest("p");
        if (p) p.style.display = "none"; else a.style.display = "none";
      }
    });

    document.querySelectorAll("[data-note-hanabi]").forEach(function (el) {
      el.innerHTML = noteArticleLink("hanabi", "詳細を見る（note）");
    });

    // 問い合わせ手段
    var contactWrap = document.getElementById("contact-method");
    if (contactWrap) {
      var c = CFG.contact || {};
      if (c.email) contactWrap.innerHTML = '<a class="btn" href="mailto:' + esc(c.email) + '">メールで問い合わせる</a>';
      else if (c.formUrl) contactWrap.innerHTML = '<a class="btn" href="' + esc(c.formUrl) + '" target="_blank" rel="noopener">お問い合わせフォーム</a>';
      else contactWrap.innerHTML = '<div class="placeholder">お問い合わせ手段は準備中です。確定後に掲載します。</div>';
    }
  }

  // ---- Hero イントロ演出（初回数秒のみ・ループ無し。約2.2秒で静止）----
  function initHeroIntro() {
    var scene = document.querySelector(".hero-scene");
    if (!scene) return;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // reduce時はアニメーションを開始しない → CSS 側で最初から完成形（太陽/月は最終位置に配置）
    if (reduce) return;
    // CSS アニメーション（軌道描画・地上部・花火・テキスト）を開始
    document.documentElement.classList.add("hero-intro");
    // Hero SVG の preserveAspectRatio を切替:
    // 幅/高さ >= viewBox比(1440/600) なら meet（高さ基準・シーン全体が必ず収まる）、
    // それ未満（縦長・モバイル）は slice（高さが収まり左右のみクロップ）。
    // どちらも上下は切れないため、太陽・月・軌道・地上部が欠けない。
    function updateHeroAspect() {
      var hero = document.querySelector(".hero");
      var svg = document.querySelector(".hero-scene");
      if (!hero || !svg) return;
      var ratio = hero.clientWidth / Math.max(1, hero.clientHeight);
      svg.setAttribute("preserveAspectRatio", ratio >= 1440 / 512 ? "xMidYMid meet" : "xMidYMid slice");
    }
    updateHeroAspect();
    window.addEventListener("resize", updateHeroAspect);

    // 太陽・月の軌道移動（SVG SMIL animateMotion）を開始。begin="indefinite" を beginElement() で発火。
    try {
      var sun = scene.querySelector(".h-sun-motion");
      var moon = scene.querySelector(".h-moon-motion");
      // SMIL 未対応ブラウザでは beginElement が無い → その場合は最終位置へ静的配置してフォールバック
      if (sun && typeof sun.beginElement === "function") {
        setTimeout(function () { try { sun.beginElement(); } catch (e) {} }, 300);
        setTimeout(function () { try { moon && moon.beginElement(); } catch (e) {} }, 400);
      } else {
        scene.querySelector(".h-sun") && (scene.querySelector(".h-sun").setAttribute("transform", "translate(700,177)"));
        scene.querySelector(".h-moon") && (scene.querySelector(".h-moon").setAttribute("transform", "translate(1007,257)"));
      }
    } catch (e) { /* フォールバック不要時は無視 */ }
  }

  // ---- reveal アニメーション（IntersectionObserver。重いライブラリ不使用）----
  function initReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // reduce-motion / IO非対応時は隠さず即表示（js-reveal を付けない）
    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("in"); });
      return;
    }
    // JS が動くときだけ隠す（フォールバック安全）
    document.documentElement.classList.add("js-reveal");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -5% 0px" });
    els.forEach(function (el) { io.observe(el); });
    // 保険: 何らかの理由で発火しなくても 1.6s 後に全て表示（永久非表示を防ぐ）
    setTimeout(function () { els.forEach(function (el) { el.classList.add("in"); }); }, 1600);
  }

  // ---- boot ----
  // ログイン状態に依存するページ本体を再初期化する（ログイン/ログアウト直後の更新に使用）。
  function reInitCurrentPage() {
    var page = document.body ? document.body.getAttribute("data-page") : null;
    if (page === "mypage") initMypage();
    else if (page === "product-sun-and-moon") initSunAndMoonDetail();
    else if (page === "store") initStore();
  }

  async function boot() {
    var token = null;
    try { token = await getToken(); } catch (e) { token = null; }
    // admin 判定と granted 取得を並行実行（granted は HOME カード CTA の出し分けに使用）
    await Promise.all([
      checkAdmin(token),
      (async function () {
        homeGranted = {};
        if (!token) return;
        try {
          var res = await fetch("/api/account/products", { headers: authHeaders(token) });
          if (res.ok) {
            var body = await res.json();
            ((body.data && body.data.products) || []).forEach(function (p) {
              if (p.granted) homeGranted[p.code] = true;
            });
          }
        } catch (e) { /* 取得不能時は未購入表示（STORE 導線） */ }
      })(),
    ]);
    renderHeader(!!token);
    renderFooter();
    applyAppIcons();
    applyConfigPlaceholders();
    initHeroIntro();
    initReveal();

    // 認証状態の変化を購読し、再読込なしでヘッダー（と本体）を更新する。
    try {
      var client = await getClient();
      if (client && client.auth && client.auth.onAuthStateChange) {
        client.auth.onAuthStateChange(function (event, session) {
          var t = session && session.access_token ? session.access_token : null;
          checkAdmin(t).then(function () { renderHeader(!!session); });
          if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
            reInitCurrentPage();
          }
        });
      }
    } catch (e) { /* noop */ }

    reInitCurrentPage();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 外部公開（必要時）
  window.SiteAuth = { getToken: getToken, logout: logout };
})();
