/**
 * 管理画面 共通 JS
 *
 * - Supabase セッションから access_token を取得し、Authorization ヘッダで
 *   /api/admin/* を呼ぶ。
 * - 管理判定はサーバー側（requireAdmin）。フロントは表示制御のみで、
 *   これをセキュリティ境界にしない。未認証・非管理者は API が 401/403 を返す。
 * - HTML エスケープを徹底（textContent 使用、MEMO 等も innerHTML で挿入しない）。
 */
(function () {
  "use strict";

  var _client = null;
  var _deviceId = getDeviceId();

  function getDeviceId() {
    try {
      var k = "scp_device_id";
      var v = localStorage.getItem(k);
      if (!v) {
        v = uuid();
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return uuid();
    }
  }
  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async function getClient() {
    if (_client) return _client;
    var res = await apiFetch("/api/config", { headers: { "X-Device-Id": _deviceId } });
    if (!res.ok) throw new Error("config fetch failed");
    var body = await res.json();
    if (!self.supabase || !self.supabase.createClient) {
      throw new Error("supabase library not loaded");
    }
    _client = self.supabase.createClient(body.data.supabaseUrl, body.data.supabaseAnonKey);
    return _client;
  }

  /** access_token を取得。無ければ /login へ誘導。 */
  async function getToken() {
    var client = await getClient();
    var s = await client.auth.getSession();
    var session = s && s.data ? s.data.session : null;
    if (!session) {
      location.href = appUrl("/login/");
      return null;
    }
    return session.access_token;
  }

  /** 管理 API 呼び出し。401/403 はメッセージ表示。 */
  async function apiGet(path) {
    var token = await getToken();
    if (!token) return null;
    var res = await apiFetch(path, {
      headers: { Authorization: "Bearer " + token, "X-Device-Id": _deviceId },
    });
    return handleRes(res);
  }
  async function apiPut(path, bodyObj) {
    var token = await getToken();
    if (!token) return null;
    var res = await apiFetch(path, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + token,
        "X-Device-Id": _deviceId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyObj),
    });
    return handleRes(res);
  }
  async function handleRes(res) {
    var body = null;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
    if (res.status === 403) {
      throw new Error("この操作を行う権限がありません。");
    }
    if (res.status === 401) {
      location.href = appUrl("/login/");
      throw new Error("ログインが必要です。");
    }
    if (!res.ok || !body || body.result !== "OK") {
      var msg = body && body.error && body.error.message ? body.error.message : "処理に失敗しました。";
      throw new Error(msg);
    }
    return body.data;
  }

  /** DOM ヘルパ（すべて textContent。innerHTML は使わない） */
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }
  function td(text) {
    return el("td", text === null || text === undefined ? "" : text);
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function setError(node, message) {
    clear(node);
    node.appendChild(el("div", message, "error"));
  }
  function setLoading(node) {
    clear(node);
    node.appendChild(el("div", "読み込み中...", "loading"));
  }

  /** コード値 → 表示ラベル */
  var USER_STATUS = { 0: "仮登録", 1: "有効", 2: "一時停止", 9: "退会" };
  var UP_STATUS = { 0: "利用開始前", 1: "有効", 2: "一時停止", 9: "終了" };
  var GRANT_TYPE = { 0: "購入", 1: "note移行", 2: "テスター", 3: "管理者付与", 4: "補償" };
  var PAY_STATUS = { 0: "処理中", 1: "支払済", 2: "返金済", 3: "-", 9: "-" };
  var PUR_SOURCE = { 0: "Stripe", 1: "note", 2: "管理者登録" };
  var WARN_STATUS = { 0: "未対応", 1: "確認済", 2: "ユーザー確認中", 9: "除外" };
  var ACCESS_TYPE = { 0: "アプリ起動", 1: "権限確認", 2: "定期確認" };
  var MATCH_STATUS = { 0: "未移行", 1: "移行済", 2: "要確認", 9: "無効" };

  function label(map, v) {
    return map[v] !== undefined ? map[v] : String(v);
  }

  // 公開
  self.AdminUI = {
    apiGet: apiGet,
    apiPut: apiPut,
    getToken: getToken,
    deviceId: _deviceId,
    el: el,
    td: td,
    clear: clear,
    setError: setError,
    setLoading: setLoading,
    label: label,
    maps: {
      USER_STATUS: USER_STATUS,
      UP_STATUS: UP_STATUS,
      GRANT_TYPE: GRANT_TYPE,
      PAY_STATUS: PAY_STATUS,
      PUR_SOURCE: PUR_SOURCE,
      WARN_STATUS: WARN_STATUS,
      ACCESS_TYPE: ACCESS_TYPE,
      MATCH_STATUS: MATCH_STATUS,
    },
  };
})();
