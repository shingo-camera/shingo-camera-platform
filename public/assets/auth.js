/* auth.js — shingo-camera Platform 認証フロント
 *
 * 役割:
 * - DEVICE_ID の生成・保存（AUTH.md 15）
 * - /api/config から SUPABASE_URL / SUPABASE_ANON_KEY を取得し Supabase 初期化
 * - 新規登録 / ログイン / ログアウト / パスワード再設定メール / 新パスワード登録
 * - セッション取得
 * - ログイン後は M_USER 同期 API (/api/account/sync) を最小呼び出し
 *
 * 前提:
 * - Supabase JS は public/assets/vendor/supabase.js (UMD, 固定版) を先に読み込み、
 *   グローバル `supabase` が存在する。
 * - Supabase プロジェクトは非対称署名鍵（JWKS 検証可能）を使用する。
 *
 * 秘密情報はフロントに置かない。SUPABASE_ANON_KEY は公開可・SERVICE_ROLE_KEY は不可。
 */

(function () {
  "use strict";

  // ---- DEVICE_ID ----
  // ブラウザ発行 UUID。認証要素ではない。localStorage に保存し使い回す。
  var DEVICE_ID_KEY = "scp_device_id";
  function getOrCreateDeviceId() {
    var id = null;
    try {
      id = localStorage.getItem(DEVICE_ID_KEY);
    } catch (e) {
      id = null;
    }
    if (!id) {
      id = (self.crypto && self.crypto.randomUUID)
        ? self.crypto.randomUUID()
        : fallbackUuid();
      try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) { /* 保存不可でも継続 */ }
    }
    return id;
  }
  function fallbackUuid() {
    // crypto.randomUUID が無い環境向けの簡易 UUID v4 生成
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ---- 設定取得 & Supabase 初期化 ----
  var _client = null;
  var _deviceId = getOrCreateDeviceId();

  async function getClient() {
    if (_client) return _client;
    var res = await fetch("/api/config", { headers: { "X-Device-Id": _deviceId } });
    if (!res.ok) throw new Error("config fetch failed");
    var body = await res.json();
    if (!body || body.result !== "OK" || !body.data) throw new Error("config invalid");
    if (!self.supabase || !self.supabase.createClient) {
      throw new Error("supabase client not loaded");
    }
    _client = self.supabase.createClient(body.data.supabaseUrl, body.data.supabaseAnonKey);
    return _client;
  }

  // ---- メッセージ表示 ----
  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
  }

  // ---- M_USER 同期（ログイン後の最小呼び出し）----
  async function syncAccount(accessToken) {
    try {
      await fetch("/api/account/sync", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + accessToken,
          "X-Device-Id": _deviceId,
        },
      });
    } catch (e) {
      // 同期失敗はログイン自体を阻害しない（最小骨格）。詳細はサーバーログ。
    }
  }

  // ---- 画面別ロジック ----

  // signup: メール+パスワードで登録 → 認証メール案内
  async function initSignup() {
    var email = document.getElementById("email");
    var password = document.getElementById("password");
    var btn = document.getElementById("submit");
    var msg = document.getElementById("msg");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      setMsg(msg, "", "");
      if (!email.value || !password.value) {
        setMsg(msg, "メールアドレスとパスワードを入力してください。", "err");
        return;
      }
      btn.disabled = true;
      try {
        var client = await getClient();
        // 目的操作→LOGIN→SIGNUP と進んだ場合、元の目的地（redirect）を失わない（§10A）。
        // メール認証後は LOGIN へ戻り、そこで redirect が再評価される。redirect なしは
        // LOGIN 側の既定で MY PAGE へ（§10B）。外部 URL は safeRedirectPath が弾く。
        var dest = safeRedirectPath();
        var redirectTo = window.location.origin + "/login/" +
          (dest ? "?redirect=" + encodeURIComponent(dest) : "");
        var r = await client.auth.signUp({
          email: email.value,
          password: password.value,
          options: { emailRedirectTo: redirectTo },
        });
        if (r.error) {
          setMsg(msg, "登録に失敗しました。入力内容をご確認ください。", "err");
        } else {
          setMsg(msg, "確認メールを送信しました。メール内のリンクから認証を完了してください。", "ok");
        }
      } catch (e) {
        setMsg(msg, "登録処理でエラーが発生しました。時間をおいて再度お試しください。", "err");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // redirect クエリの安全検証（§9）: 「/」始まり・「//」でない・URL 解決後 origin 一致のみ許可。
  // 通過した場合は正規化済みパス（pathname+search+hash）を返し、それ以外は null。
  // /login/ 自身への redirect は無限ループ防止のため無効とする。
  function safeRedirectPath() {
    try {
      var rp = new URLSearchParams(window.location.search).get("redirect");
      if (!rp || rp.charAt(0) !== "/" || rp.charAt(1) === "/") return null;
      var resolved = new URL(rp, window.location.origin);
      if (resolved.origin !== window.location.origin) return null;
      if (resolved.pathname === "/login/" || resolved.pathname === "/login") return null;
      return resolved.pathname + resolved.search + resolved.hash;
    } catch (e) { return null; }
  }

  // login: ログイン → セッション取得 → M_USER 同期
  async function initLogin() {
    var email = document.getElementById("email");
    var password = document.getElementById("password");
    var btn = document.getElementById("submit");
    var msg = document.getElementById("msg");
    var sessionBox = document.getElementById("session");
    if (!btn) return;

    // LOGIN → SIGNUP へ進んでも元の redirect を失わない（§10A）: SIGNUP リンクへ引継。
    (function () {
      var dest = safeRedirectPath();
      if (!dest) return;
      document.querySelectorAll('a[href="/signup/"]').forEach(function (a) {
        a.href = "/signup/?redirect=" + encodeURIComponent(dest);
      });
    })();

    // 既にログイン済みなら LOGIN フォームへ留めない（§8）。
    // redirect ありならその先へ、なければ MY PAGE へ（safeRedirectPath が /login/ を弾くため無限 redirect しない）。
    (async function () {
      try {
        var client = await getClient();
        var s = await client.auth.getSession();
        if (s.data && s.data.session) {
          await syncAccount(s.data.session.access_token);
          var dest = safeRedirectPath();
          window.location.href = dest || "/mypage/";
        }
      } catch (e) { /* 未ログインは正常 */ }
    })();

    btn.addEventListener("click", async function () {
      setMsg(msg, "", "");
      btn.disabled = true;
      try {
        var client = await getClient();
        var r = await client.auth.signInWithPassword({
          email: email.value,
          password: password.value,
        });
        if (r.error || !r.data || !r.data.session) {
          setMsg(msg, "ログインに失敗しました。メールアドレスとパスワードをご確認ください。", "err");
        } else {
          setMsg(msg, "ログインしました。", "ok");
          showSession(sessionBox, r.data.session);
          await syncAccount(r.data.session.access_token);
          // LOGIN は中継地点（§7）: redirect ありは元の目的地へ、なしは MY PAGE へ。
          var dest = safeRedirectPath();
          window.location.href = dest || "/mypage/";
        }
      } catch (e) {
        setMsg(msg, "ログイン処理でエラーが発生しました。", "err");
      } finally {
        btn.disabled = false;
      }
    });

    var logout = document.getElementById("logout");
    if (logout) {
      logout.addEventListener("click", async function () {
        try {
          var client = await getClient();
          await client.auth.signOut();
          setMsg(msg, "ログアウトしました。", "info");
          if (sessionBox) sessionBox.textContent = "";
        } catch (e) {
          setMsg(msg, "ログアウトに失敗しました。", "err");
        }
      });
    }

    // メール/パスワード入力欄で Enter キー押下 → ログイン実行（form 無し・type=button でも送信可能に）
    [email, password].forEach(function (el) {
      if (el) {
        el.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!btn.disabled) btn.click();
          }
        });
      }
    });
  }

  function showSession(box, session) {
    if (!box) return;
    // AUTH_USER_ID(UUID) は通常画面へ表示しない（AUTH.md 3.3）。メールのみ表示。
    var mail = session.user ? session.user.email : "";
    box.textContent = mail ? ("ログイン中: " + mail) : "ログイン中";
  }

  // forgot-password: 再設定メール送信（結果文言は存在有無を漏らさない統一文言）
  async function initForgot() {
    var email = document.getElementById("email");
    var btn = document.getElementById("submit");
    var msg = document.getElementById("msg");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      setMsg(msg, "", "");
      btn.disabled = true;
      try {
        var client = await getClient();
        var redirectTo = window.location.origin + "/reset-password/";
        await client.auth.resetPasswordForEmail(email.value, { redirectTo: redirectTo });
        // AUTH.md 11: 存在有無を推測されにくくするため結果文言を統一
        setMsg(msg, "入力されたメールアドレスが登録済みの場合、再設定メールを送信しました。", "ok");
      } catch (e) {
        // 失敗時も同一文言に寄せ、存在有無を推測させない
        setMsg(msg, "入力されたメールアドレスが登録済みの場合、再設定メールを送信しました。", "ok");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // reset-password: メールリンクから遷移。新パスワード登録。
  async function initReset() {
    var password = document.getElementById("password");
    var btn = document.getElementById("submit");
    var msg = document.getElementById("msg");
    if (!btn) return;

    // リンク経由で recovery セッションが張られる。getSession で確認。
    var ready = false;
    (async function () {
      try {
        var client = await getClient();
        var s = await client.auth.getSession();
        ready = !!(s.data && s.data.session);
        if (!ready) {
          setMsg(msg, "再設定リンクが無効か期限切れの可能性があります。再度お試しください。", "info");
        }
      } catch (e) { /* noop */ }
    })();

    btn.addEventListener("click", async function () {
      setMsg(msg, "", "");
      if (!password.value) {
        setMsg(msg, "新しいパスワードを入力してください。", "err");
        return;
      }
      btn.disabled = true;
      try {
        var client = await getClient();
        var r = await client.auth.updateUser({ password: password.value });
        if (r.error) {
          // same_password（現在と同じパスワード）は「リンク期限切れ」ではないため文言を分ける。
          var ec = r.error.code || "";
          var em = r.error.message || "";
          if (ec === "same_password" || /same_password|should be different|different from the old/i.test(em)) {
            setMsg(msg, "現在とは異なるパスワードを設定してください。", "err");
          } else {
            setMsg(msg, "パスワードの更新に失敗しました。リンクの有効期限をご確認ください。", "err");
          }
        } else {
          // パスワード変更成功後、M_USER.PASSWORD_CHANGE_DATE 更新API（WORK後続）は
          // WORK-003 範囲外。ここでは成功案内のみ。
          setMsg(msg, "パスワードを更新しました。ログイン画面からログインしてください。", "ok");
        }
      } catch (e) {
        setMsg(msg, "パスワード更新でエラーが発生しました。", "err");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---- ページ判定 ----
  function boot() {
    var page = document.body ? document.body.getAttribute("data-page") : null;
    if (page === "signup") initSignup();
    else if (page === "login") initLogin();
    else if (page === "forgot") initForgot();
    else if (page === "reset") initReset();
    // それ以外（index 等）は何もしない
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
