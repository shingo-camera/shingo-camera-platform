/**
 * api-base.js — Platform 共通 API ベース解決（D4）
 *
 * 目的:
 *   Production では base="" のまま /api/... を呼ぶ（既存挙動と完全に同一）。
 *   DEV（/dev/ 配下で配信された画面）では /dev/api/... へ解決する。
 *
 * 方針:
 *   - /dev 判定を各画面へ散在させない。判定はこの 1 ファイルに集約する。
 *   - 自前 Platform API（"/api/..."）の呼び出しは fetch ではなく apiFetch を使う。
 *   - 外部 URL（http/https/// で始まる）や /api 以外はそのまま（base を付けない）。
 *   - このファイルは各画面の <head> で最初に読み込む（他スクリプトより前）。
 *
 * Production 不変性:
 *   location.pathname が /dev 配下でなければ apiBase()==="" となり、
 *   apiFetch("/api/x") は fetch("/api/x") と同一（URL も挙動も完全一致）。
 */
(function () {
  "use strict";

  // 冪等ガード：DEV では shim が本スクリプトを <head> 先頭へ inline 注入する。
  // 外部 /assets/api-base.js も別途ロードされ得るため、二重実行を無害化する（先勝ち）。
  if (typeof window !== "undefined" && window.apiBase) return;

  // DEV ベースパス（DEV Worker が同一 public を /dev/ 配下で配信する）。
  var DEV_BASE = "/dev";

  /**
   * 現在の画面が DEV（/dev 配下）で配信されているかに応じて API ベースを返す。
   * - Production: ""（＝従来どおり /api/...）
   * - DEV      : "/dev"（＝ /dev/api/...）
   */
  function apiBase() {
    try {
      var p = (typeof location !== "undefined" && location.pathname) || "";
      if (p === DEV_BASE || p.indexOf(DEV_BASE + "/") === 0) return DEV_BASE;
      return "";
    } catch (_e) {
      return "";
    }
  }

  /**
   * 与えられたパスへ API ベースを適用する。
   * - "/api/..." のみベースを前置する（DEV 時）。
   * - 絶対 URL（http/https/プロトコル相対 //）や "/api" 以外はそのまま返す。
   */
  function apiUrl(path) {
    if (typeof path !== "string") return path;
    // 外部 URL・プロトコル相対はそのまま
    if (/^https?:\/\//i.test(path) || path.indexOf("//") === 0) return path;
    // 自前 Platform API のみ base を適用（"/api" と "/api/..." 双方）
    if (path === "/api" || path.indexOf("/api/") === 0) {
      var b = apiBase();
      return b ? b + path : path;
    }
    return path;
  }

  /**
   * Platform 内 navigation URL（"/login/" 等）へ環境ベースを適用する。
   * - Production: そのまま（"/login/"）。DEV: "/dev/login/"。
   * - ルート相対（"/..."）のみ対象。外部 URL・プロトコル相対・相対・hash・既に /dev 済みは素通し。
   * - クエリ/ハッシュ付き（"/login/?redirect=..."）はパス部だけ前置し、後続はそのまま連結する。
   * DEV 内 navigation が Production root へ脱出しないための一元 resolver（各画面へ /dev 判定を散在させない）。
   */
  function appUrl(path) {
    if (typeof path !== "string" || path === "") return path;
    if (path[0] !== "/") return path;                       // 相対/スキーム付きは対象外
    if (path.indexOf("//") === 0) return path;              // プロトコル相対 //host は外部
    var b = apiBase();
    if (!b) return path;                                    // Production は不変
    if (path === b || path.indexOf(b + "/") === 0) return path; // 既に /dev 済み
    return b + path;                                        // ルート相対 → /dev 前置（クエリ/hash 含めて前置でOK）
  }

  /**
   * fetch の薄いラッパ。第 1 引数が "/api/..." のとき環境ベースを適用する。
   * それ以外は fetch と完全に同じ（挙動不変）。
   */
  function apiFetch(input, init) {
    if (typeof input === "string") {
      return fetch(apiUrl(input), init);
    }
    // Request オブジェクト等はそのまま（自前 API 文字列以外は変換しない）
    return fetch(input, init);
  }

  // グローバル公開（各画面/共有JSから参照）
  if (typeof window !== "undefined") {
    window.apiBase = apiBase;
    window.apiUrl = apiUrl;
    window.appUrl = appUrl;
    window.apiFetch = apiFetch;

    // DEV badge（要件15）：DEV（/dev 配下）のときだけ小さな常時表示を出す。
    //   Production（base==="")では何も表示しない。HTML を手作業で DEV 版に書き換えない（自動判定・1 箇所）。
    //   位置は右下固定・pointer-events:none で UI 操作を邪魔しない。
    try {
      if (apiBase() === DEV_BASE && typeof document !== "undefined") {
        var mount = function () {
          if (document.getElementById("dev-env-badge")) return;
          var b = document.createElement("div");
          b.id = "dev-env-badge";
          b.textContent = "DEV";
          b.setAttribute("aria-hidden", "true");
          b.style.cssText =
            "position:fixed;right:8px;bottom:8px;z-index:2147483647;pointer-events:none;" +
            "font:700 11px/1.4 system-ui,sans-serif;letter-spacing:.08em;color:#fff;" +
            "background:#b45309;opacity:.85;padding:2px 8px;border-radius:6px;" +
            "box-shadow:0 1px 4px rgba(0,0,0,.35);user-select:none;";
          (document.body || document.documentElement).appendChild(b);
        };
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", mount);
        } else {
          mount();
        }
      }
    } catch (_e) { /* badge 失敗はアプリに影響させない */ }
  }
  // テスト（Node）用にエクスポート
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { apiBase: apiBase, apiUrl: apiUrl, appUrl: appUrl, apiFetch: apiFetch, DEV_BASE: DEV_BASE };
  }
})();
