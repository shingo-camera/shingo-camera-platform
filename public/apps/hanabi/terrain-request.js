/**
 * HANABI terrain リクエストマネージャ（Phase C1）。
 *
 * terrain（前地形/後地形）を server（terrain-solve）へ移すにあたり、取得中に撮影地点・筒場・焦点等が
 * 変わった場合に古い terrain 結果を最新画面へ反映しないための最小限の generation/abort を提供する。
 *
 * 注意: Phase A の scene-request-manager は再設計しない。これは terrain 専用の独立系統。
 * 純ロジック（DOM 非依存）で、ブラウザと Node テストの両方から使える（window.HBTerrain に公開）。
 *
 * 契約:
 *  - request(mode, payload) 受付ごとに generation を進め、それ以前の inflight solve を stale 化・abort。
 *  - 最新 generation の応答のみ onResult へ渡す（stale は破棄）。
 *  - fail-closed: solve 失敗時は onError（呼び出し側は旧 client 計算へ fallback しない）。
 */
(function () {
  "use strict";

  function createTerrainManager(opts) {
    var solve = opts.solve; // (mode, payload, signal) => Promise<result>
    var onStart = opts.onStart || function () {};
    var onResult = opts.onResult || function () {};
    var onError = opts.onError || function () {};

    var gen = 0;
    var abort = null;

    function request(mode, payload) {
      var myGen = ++gen;
      // 進行中の古い取得を中断（generation でも破棄するが、通信も止める）。
      if (abort) {
        try { abort.abort(); } catch (e) { /* noop */ }
        abort = null;
      }
      abort = typeof AbortController !== "undefined" ? new AbortController() : null;
      var signal = abort ? abort.signal : undefined;

      onStart(mode, myGen);

      Promise.resolve()
        .then(function () { return solve(mode, payload, signal); })
        .then(function (result) {
          if (myGen !== gen) return; // stale 破棄（新しい request が来ている）
          abort = null;
          onResult(mode, result);
        })
        .catch(function (err) {
          if (myGen !== gen) return; // stale なエラーも無視
          abort = null;
          onError(mode, err); // fail-closed（旧計算へ fallback しない）
        });
    }

    // 明示的な無効化（視点/筒場変更時など。既存 terrain 結果を捨てる用途）。
    function invalidate() {
      gen++;
      if (abort) { try { abort.abort(); } catch (e) { /* noop */ } abort = null; }
    }

    return {
      request: request,
      invalidate: invalidate,
      _debug: function () { return { gen: gen }; },
    };
  }

  var api = { createTerrainManager: createTerrainManager };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.HBTerrain = api;
})();
