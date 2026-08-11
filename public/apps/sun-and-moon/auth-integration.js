/**
 * WORK-010 SUN AND MOON プラットフォーム認証統合
 *
 * 役割:
 * - Supabase セッションから access_token を取得（既存プラットフォーム画面と同一方式）。
 * - 端末ID（scp_device_id）を X-Device-Id で送る。
 * - アプリ起動時に権限確認（POST /api/apps/sun-and-moon/app-start）:
 *     未ログイン → /login/ へ誘導
 *     権限なし   → 商品詳細 /products/sun-and-moon/ へ誘導
 *     権限あり   → APP_START アクセスログが1回記録され、アプリ利用開始。
 * - 計算API呼び出しの共通ラッパ window.SMApi(name, options) を提供。
 *     /api/apps/sun-and-moon/{name} へ Authorization: Bearer + X-Device-Id を付けて送る。
 *     各計算APIではアクセスログを記録しない（サーバ側で requireProduct のみ）。
 *
 * GoTrueClient を複数生成しないよう、client は本モジュール内で1度だけ生成しキャッシュする
 * （WORK-008 と同じシングルトン方針）。
 *
 * 天体計算・UI・既存機能には手を入れない。API URL とヘッダ付与のみを担う。
 */
(function () {
  "use strict";

  var API_BASE = "/api/apps/sun-and-moon/";
  var LOGIN_URL = "/login/";
  // 権限なし時の遷移先。WORK-011 で商品詳細ページを実装したため正式な遷移先へ変更。
  // ログイン済み・権限なしユーザーを /login/ へ送るのは意味的に不適切なため使わない。
  var NO_ENTITLEMENT_URL = "/products/sun-and-moon/";

  // 端末ID（プラットフォーム共通キー。認証要素ではない）。
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

  /**
   * SUN AND MOON 計算APIを呼ぶ共通ラッパ。
   * @param {string} name  例 "chance"（先頭スラッシュ不要）。フルパス "/api/xxx" も許容。
   * @param {object} options fetch オプション（method/body 等）。headers は自動補完。
   */
  async function SMApi(name, options) {
    options = options || {};
    var path = name;
    // 旧コードの "/api/xxx" 形式を "/api/apps/sun-and-moon/xxx" に読み替える。
    if (path.indexOf("/api/") === 0) path = path.slice("/api/".length);
    if (path.indexOf("/") === 0) path = path.slice(1);
    var url = API_BASE + path;

    var token = await getToken();
    var headers = Object.assign({}, options.headers || {});
    headers["X-Device-Id"] = deviceId;
    if (token) headers["Authorization"] = "Bearer " + token;
    var opt = Object.assign({}, options, { headers: headers });
    return fetch(url, opt);
  }

  /**
   * アプリ起動時のガード。権限確認し、必要なら誘導する。
   * @returns {Promise<boolean>} 利用可なら true。
   */
  async function guardAppStart() {
    var token = await getToken();
    if (!token) {
      // 未ログイン → ログインへ（戻り先を付ける）。
      var back = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = LOGIN_URL + "?redirect=" + back;
      return false;
    }
    var res;
    try {
      res = await fetch(API_BASE + "app-start", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": deviceId, "Authorization": "Bearer " + token },
      });
    } catch (e) {
      // 通信失敗時はブロックせず、以降の各API呼び出し時の権限確認に委ねる。
      return true;
    }
    if (res.status === 401) {
      var back2 = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = LOGIN_URL + "?redirect=" + back2;
      return false;
    }
    if (res.status === 403) {
      // 権限なし（未購入/停止/期限切れ等）→ 商品詳細ページへ誘導。
      window.location.href = NO_ENTITLEMENT_URL;
      return false;
    }
    return true;
  }

  // 公開 API。
  window.SMApi = SMApi;
  window.SMAuth = { getToken: getToken, getDeviceId: function () { return deviceId; }, guardAppStart: guardAppStart };

  // 認証ゲート解除: 本体を表示する（html.sm-auth-gate を外す）。
  function revealApp() {
    try { document.documentElement.classList.remove("sm-auth-gate"); } catch (e) { /* noop */ }
  }

  // 起動ガード: 未ログイン→/login/、権限なし→/products/sun-and-moon/。権限ありなら APP_START を1回記録して本体表示。
  // 遷移する場合（false）はゲートを維持して本体を見せない（未認証フラッシュ防止）。
  // 権限あり／通信失敗（true）のみ本体を表示する（通信失敗は各API側の権限確認に委ねる既存方針）。
  function boot() {
    guardAppStart()
      .then(function (ok) {
        if (ok) revealApp();
        // ok === false のときは location 遷移中。ゲートは維持したまま。
      })
      .catch(function () {
        // 想定外エラーで永久非表示にならないよう、本体は表示して各API側の権限確認に委ねる。
        revealApp();
      });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
