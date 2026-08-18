/**
 * HANABI プラットフォーム認証統合（WORK-010 SUN AND MOON 方式を HANABI へ写像）
 *
 * 役割:
 * - Supabase セッションから access_token を取得（既存プラットフォーム画面と同一方式）。
 * - 端末ID（scp_device_id）を X-Device-Id で送る（プラットフォーム共通キー。認証要素ではない）。
 * - アプリ起動時に権限確認（POST /api/apps/hanabi/app-start）:
 *     未ログイン → /login/ へ誘導（戻り先付き）
 *     権限なし   → 商品詳細 /products/hanabi/ へ誘導
 *     権限あり   → APP_START アクセスログが1回記録され、アプリ利用開始。
 * - Google Earth 追加機能（GEP 機能）の解放可否判定 window.HBAuth.hasEarth() を提供。
 *     GET /api/apps/hanabi/earth-entitlement を叩き HANABI_GOOGLE_EARTH の所有可否を返す。
 *     旧 HANABI の独自パスワードゲート（/.netlify/functions/check-password）を置換する。
 *
 * GoTrueClient を複数生成しないよう、client は本モジュール内で1度だけ生成しキャッシュする
 * （SUN AND MOON と同じシングルトン方針）。
 *
 * 撮影計算・地図・プレビュー・断面図・Google Earth 出力・export/import には手を入れない。
 * 本モジュールは「認証ゲート」と「Earth 機能の entitlement 判定」のみを担う。
 */
(function () {
  "use strict";

  var API_BASE = "/api/apps/hanabi/";
  var LOGIN_URL = "/login/";
  // 権限なし時の遷移先（HANABI 本体の商品詳細）。
  var NO_ENTITLEMENT_URL = "/products/hanabi/";

  // 端末ID（プラットフォーム共通キー。認証要素ではない。SUN AND MOON と同一キーを共有）。
  var deviceId = (function () {
    try {
      var k = "scp_device_id", v = localStorage.getItem(k);
      if (!v) {
        v = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : String(Date.now());
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return String(Date.now());
    }
  })();

  // Supabase client を1度だけ生成してキャッシュ（複数 GoTrueClient 生成を防ぐ）。
  var clientPromise = null;
  function getClient() {
    if (clientPromise) return clientPromise;
    clientPromise = (async function () {
      var res = await apiFetch("/api/config", { headers: { "X-Device-Id": deviceId } });
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

  /**
   * アプリ起動時のガード。HANABI 本体の権限を確認し、必要なら誘導する。
   * @returns {Promise<boolean>} 利用可なら true。
   */
  async function guardAppStart() {
    var token = await getToken();
    if (!token) {
      // 未ログイン → ログインへ（戻り先を付ける）。
      var back = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = appUrl(LOGIN_URL) + "?redirect=" + back;
      return false;
    }
    var res;
    try {
      res = await apiFetch(API_BASE + "app-start", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": deviceId, "Authorization": "Bearer " + token },
      });
    } catch (e) {
      // fail-closed（§18）: 権限確認の通信に失敗した状態で本体を利用可能にしない。
      // 旧 client 計算への fallback もしない（中核計算はサーバ保護のため client 単独では成立しない）。
      return "ERROR";
    }
    if (res.status === 401) {
      var back2 = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = appUrl(LOGIN_URL) + "?redirect=" + back2;
      return false;
    }
    if (res.status === 403) {
      // 権限なし（未購入/停止/期限切れ等）→ 商品詳細ページへ誘導。
      window.location.href = appUrl(NO_ENTITLEMENT_URL);
      return false;
    }
    if (!res.ok) {
      // 5xx 等の想定外応答も fail-closed（本体を見せない）。
      return "ERROR";
    }
    // 管理者フラグの受け取り（表示制御用）。判定正本はサーバー（app-start の isAdmin）。
    try {
      var body = await res.json();
      if (body && body.data && body.data.isAdmin === true) {
        window.HB_IS_ADMIN = true;
        document.documentElement.classList.add("hb-admin");
      }
    } catch (e) { /* 非管理者扱いのまま */ }
    return true;
  }

  /**
   * Google Earth 追加機能（GEP 機能）の解放可否を返す。
   * サーバーの GET /api/apps/hanabi/earth-entitlement（HANABI_GOOGLE_EARTH 判定）を叩く。
   * @returns {Promise<boolean>} 追加機能を所有していれば true。
   *   - 未購入(200 hasEarth:false) / 未ログイン(401) / 通信失敗 → false（機能を出さない・安全側）。
   */
  async function hasEarth() {
    var token = await getToken();
    if (!token) return false;
    try {
      var res = await apiFetch(API_BASE + "earth-entitlement", {
        method: "GET",
        headers: { "X-Device-Id": deviceId, "Authorization": "Bearer " + token },
      });
      if (!res.ok) return false; // 401/403/404 等は機能なし扱い（安全側）。
      var body = await res.json();
      return !!(body && body.data && body.data.hasEarth === true);
    } catch (e) {
      return false; // 通信失敗時も機能を出さない（安全側）。
    }
  }

  // 公開 API。
  window.HBAuth = {
    getToken: getToken,
    getDeviceId: function () { return deviceId; },
    guardAppStart: guardAppStart,
    hasEarth: hasEarth,
    noEntitlementUrl: NO_ENTITLEMENT_URL,
    apiBase: API_BASE,
    // 中核計算 API 呼び出し（HANABI 本体 entitlement で保護）。
    // fail-closed: 認証不能・通信失敗・非 2xx・不正 JSON は例外を投げる（呼出側で旧計算へ fallback しない）。
    sceneSolve: function (payload, signal) { return callCompute("scene-solve", payload, signal); },
    terrainSolve: function (payload, signal) { return callCompute("terrain-solve", payload, signal); },
  };

  // 計算 API 共通呼び出し。成功時は data を返す。失敗時は Error を throw（fail-closed）。
  async function callCompute(name, payload, signal) {
    var token = await getToken();
    if (!token) {
      var err = new Error("AUTH_REQUIRED");
      err.code = "AUTH_REQUIRED";
      throw err;
    }
    var res = await apiFetch(API_BASE + name, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceId, "Authorization": "Bearer " + token },
      body: JSON.stringify(payload),
      signal: signal,
    });
    if (!res.ok) {
      var e = new Error("API_" + res.status);
      e.status = res.status;
      // 401/403 は権限・認証の問題。呼出側が案内できるよう code を付す。
      e.code = res.status === 401 ? "UNAUTHENTICATED" : res.status === 403 ? "FORBIDDEN" : "API_ERROR";
      throw e;
    }
    var body = await res.json();
    if (!body || body.data === undefined) {
      throw new Error("MALFORMED_RESPONSE");
    }
    return body.data;
  }

  // 認証ゲート解除: 本体を表示する（html.hb-auth-gate を外す）。
  function revealApp() {
    try { document.documentElement.classList.remove("hb-auth-gate"); } catch (e) { /* noop */ }
  }

  // fail-closed 時のエラー表示（本体は見せない）。再試行・ログインへの導線のみ提供。
  function showAuthError() {
    try {
      if (document.getElementById("hb-auth-error")) return;
      var ov = document.createElement("div");
      ov.id = "hb-auth-error";
      ov.setAttribute(
        "style",
        "position:fixed;inset:0;z-index:100000;background:#060810;color:#e8eaf0;" +
          "display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;" +
          "font-family:sans-serif;text-align:center;padding:24px;",
      );
      var msg = document.createElement("div");
      msg.setAttribute("style", "font-size:14px;line-height:1.7;color:#c8d0e0;max-width:320px;");
      msg.textContent =
        "権限の確認に失敗しました。ネットワーク状態を確認して再度お試しください。";
      var retry = document.createElement("button");
      retry.textContent = "再試行";
      retry.setAttribute(
        "style",
        "padding:10px 22px;font-size:14px;background:#e8874a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:700;",
      );
      retry.onclick = function () { window.location.reload(); };
      var login = document.createElement("a");
      login.textContent = "ログインし直す";
      login.href = appUrl(LOGIN_URL) + "?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
      login.setAttribute("style", "font-size:12px;color:#7eb8e8;text-decoration:underline;");
      ov.appendChild(msg);
      ov.appendChild(retry);
      ov.appendChild(login);
      document.body.appendChild(ov);
    } catch (e) { /* noop（ゲートは維持されるため本体は見えない） */ }
  }

  // 起動ガード: 未ログイン→/login/、権限なし→/products/hanabi/、権限あり→本体表示。
  // fail-closed（§18）: 通信失敗・想定外エラー・権限確認不能では本体を表示しない。
  // ゲート（hb-auth-gate）を維持したままエラー表示のみ行う（旧 client 計算へ fallback しない）。
  function boot() {
    guardAppStart()
      .then(function (ok) {
        if (ok === true) {
          revealApp();
        } else if (ok === "ERROR") {
          // 権限確認に失敗 → 本体を見せずエラー表示（fail-closed）。
          showAuthError();
        }
        // ok === false のときは location 遷移中。ゲートは維持したまま。
      })
      .catch(function () {
        // 想定外エラーでも本体は表示しない（fail-closed）。エラー表示のみ。
        showAuthError();
      });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
