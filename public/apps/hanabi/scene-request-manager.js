/**
 * HANABI scene-solve リクエストマネージャ（Phase A）。
 *
 * renderSim の独自計算を server（scene-solve）へ移すにあたり、連続操作（スライダー等）で
 * 通信が競合しても「古い応答が新しい状態を上書きしない」ことを保証する層。
 *
 * このファイルは純ロジック（DOM 非依存）で、ブラウザと Node テストの両方から使える。
 * index.html の _requestScene はこのマネージャを用いる。
 *
 * 設計（generation 契約）:
 *  - 契約: 「request() が受け付けた最新のユーザー状態だけが cache/state を更新できる」。
 *    これは 新 key・cache hit key・payload=null のすべてに適用する。
 *    solve を開始したかどうかは generation の正本ではない（ユーザーが最後に要求した状態が正本）。
 *  - generation（reqGen）はユーザーが要求した「現在の key」が変わるたびに増える（受付順）。
 *    現在の key と異なる request が来た時点で、それ以前の pending/inflight を stale 化し、
 *    inflight は abort、debounce は無効化する。stale な solve の resolve/reject は state/cache を変えない。
 *  - 同一 key が pending/inflight 中なら二重送信しない。
 *  - 既に最新 key の結果が cache にあれば再計算しない（ただし generation は更新し、別 key の
 *    inflight は stale 化する）。
 *  - payload=null（描画不能）も新しいユーザー状態として generation を進め、cache=null・idle にする。
 *  - debounce（連続操作の間引き）。
 *  - fail-closed: 失敗時は cache を消し error 状態にする（呼び出し側は旧計算へ fallback しない）。
 *    直近失敗 key は自動再送しない（入力 key が変われば再試行）。
 *
 * グローバル汚染を避けるため window.HBScene に factory を公開する。
 */
(function () {
  "use strict";

  /**
   * @param {object} opts
   *   - solve(payload, signal) => Promise<result>   : API 呼び出し（HBAuth.sceneSolve）
   *   - onState(state)                              : 'idle'|'loading'|'ok'|'error' 通知（描画トリガ）
   *   - debounceMs                                  : debounce ミリ秒（既定 90）
   *   - now()                                       : テスト用時刻源（省略時 Date.now）
   *   - setTimeoutFn / clearTimeoutFn               : テスト用タイマ（省略時 global）
   */
  function createSceneManager(opts) {
    var solve = opts.solve;
    var onState = opts.onState || function () {};
    var debounceMs = opts.debounceMs == null ? 90 : opts.debounceMs;
    var _setTimeout = opts.setTimeoutFn || (typeof setTimeout !== "undefined" ? setTimeout : null);
    var _clearTimeout = opts.clearTimeoutFn || (typeof clearTimeout !== "undefined" ? clearTimeout : null);

    var NULL_KEY = "\u0000__null__"; // payload=null を表す内部センチネル key
    var cache = null; // { key, result } 現在 key の最新結果（contract 用・従来どおり）
    // 短期 LRU: server-authoritative な scene 結果を key 別に少数だけ保持する。
    //   A→B→A のような操作で A を server 再計算せず再利用するための cache。
    //   key は camera を除いた全 authoritative 入力の JSON なので、同一 key の結果は byte 一致
    //   （Golden Master 不変）。古い state の誤利用は起きない（完全一致 key のみ hit）。
    //   容量を絞り（既定 8）メモリ過剰を避ける。fail-closed: 失敗結果は入れない。
    var LRU_MAX = opts.lruMax == null ? 8 : opts.lruMax;
    var lruKeys = []; // 新しいものほど末尾（MRU）
    var lruMap = {}; // key -> result
    function lruGet(key) {
      if (!Object.prototype.hasOwnProperty.call(lruMap, key)) return null;
      // 参照されたら MRU へ
      var i = lruKeys.indexOf(key);
      if (i >= 0) { lruKeys.splice(i, 1); lruKeys.push(key); }
      return lruMap[key];
    }
    function lruPut(key, result) {
      if (Object.prototype.hasOwnProperty.call(lruMap, key)) {
        var j = lruKeys.indexOf(key);
        if (j >= 0) lruKeys.splice(j, 1);
      }
      lruKeys.push(key);
      lruMap[key] = result;
      while (lruKeys.length > LRU_MAX) {
        var evict = lruKeys.shift();
        delete lruMap[evict];
      }
    }
    var reqGen = 0; // ユーザーが要求した「現在の状態」の generation（正本）。currentKey が変わるたびに増える。
    var currentKey = null; // 最新 request が要求した key（NULL_KEY = 描画不能）。generation の対象。
    var pendingKey = null; // debounce 中の key
    var inflightKey = null; // solve 実行中の key
    var lastFailedKey = null; // 直近で失敗した key（同一 key の自動再送を防ぐ）
    var state = "idle";
    var debounceTimer = null;
    var abort = null;

    function getCache() {
      return cache;
    }
    function getState() {
      return state;
    }
    // 現在 key に一致する cache 結果を返す（無ければ短期 LRU も見る）。
    // renderSim は resultFor(現在key) で描画するため、LRU に有れば即描画（server 不要）。
    function resultFor(key) {
      if (cache && cache.key === key) return cache.result;
      return lruGet(key);
    }

    function setState(s) {
      state = s;
      onState(s);
    }

    // 進行中の generation（debounce timer / inflight solve）を無効化する。
    // reqGen は呼び出し側で既に更新済み（stale 判定で古い solve は捨てられる）。
    // ここでは timer 停止と abort、pending/inflight のクリアを行う。
    function invalidateInflight() {
      if (debounceTimer != null && _clearTimeout) {
        _clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (abort) {
        try {
          abort.abort();
        } catch (e) {
          /* noop */
        }
        abort = null;
      }
      pendingKey = null;
      inflightKey = null;
    }

    /**
     * 再計算要求。payload と key を渡す。
     *
     * 契約: request() が受け付けた「最新のユーザー状態」だけが cache/state を更新できる。
     * currentKey（payload=null は NULL_KEY）が変わるたびに generation を進め、
     * それ以前の pending/inflight を stale 化・abort する。これは 新 key・cache hit key・
     * payload=null のすべてに適用する（solve 開始有無は正本ではない）。
     */
    function request(payload, key) {
      var incomingKey = payload ? key : NULL_KEY;

      // 「現在のユーザー状態 key」が変わったら generation を進め、以前の inflight を無効化。
      // これにより stale な solve の resolve/reject は state/cache を変えられなくなる。
      if (incomingKey !== currentKey) {
        currentKey = incomingKey;
        reqGen++;
        invalidateInflight();
        // 別 key へ移ったので直近失敗記録はクリア（別 key の失敗を引きずらない）。
        lastFailedKey = null;
      }

      // payload=null（描画不能）: cache クリア・idle。以前の inflight は上で無効化済み。
      if (!payload) {
        cache = null;
        setState("idle");
        return;
      }

      // cache が最新 key: 再計算不要。以前の別 key inflight は上で無効化済み（B を stale 化）。
      if (cache && cache.key === key) {
        setState("ok");
        return;
      }

      // 短期 LRU に同一 key の authoritative 結果があれば server 再計算せず再利用（A→B→A の A 等）。
      // 完全一致 key のみ hit するため結果は byte 一致（Golden Master 不変）。
      var reused = lruGet(key);
      if (reused != null) {
        cache = { key: key, result: reused };
        setState("ok");
        return;
      }

      // 同一 key が既に pending（debounce 中）または inflight（計算中）→ 二重送信しない。
      if (pendingKey === key || inflightKey === key) {
        return;
      }

      // 直近で失敗した key と同一 → 自動再送しない（無限 retry 防止）。error 状態は維持。
      if (lastFailedKey === key) {
        return;
      }

      // 新しい計算が必要。この request の generation を固定して debounce → solve。
      var myGen = reqGen;
      pendingKey = key;
      setState("loading");

      debounceTimer = _setTimeout(function () {
        debounceTimer = null;
        // debounce 発火時、まだこの generation が最新であることを確認（後続 request で越されていたら破棄）。
        if (myGen !== reqGen) return;
        inflightKey = key;
        abort = typeof AbortController !== "undefined" ? new AbortController() : null;
        var signal = abort ? abort.signal : undefined;

        Promise.resolve()
          .then(function () {
            return solve(payload, signal);
          })
          .then(function (result) {
            // stale discard: 自分より新しい generation が受け付けられていたら破棄（cache/state 不変）。
            if (myGen !== reqGen) return;
            inflightKey = null;
            pendingKey = null;
            lastFailedKey = null; // 成功したので失敗記録をクリア
            cache = { key: key, result: result };
            lruPut(key, result); // 短期 LRU に格納（A→B→A の再利用用）
            setState("ok");
          })
          .catch(function () {
            if (myGen !== reqGen) return; // stale なエラーも無視（cache/state 不変）
            inflightKey = null;
            pendingKey = null;
            // fail-closed: 旧計算へ fallback しない。cache を消し error に。
            // 同一 key の自動再送を防ぐため lastFailedKey を記録（入力 key が変われば再試行可）。
            lastFailedKey = key;
            cache = null;
            setState("error");
          });
      }, debounceMs);
    }

    return {
      request: request,
      getCache: getCache,
      getState: getState,
      resultFor: resultFor,
      // テスト用（内部状態の確認）
      _debug: function () {
        return { reqGen: reqGen, currentKey: currentKey, pendingKey: pendingKey, inflightKey: inflightKey, lastFailedKey: lastFailedKey, state: state };
      },
    };
  }

  var api = { createSceneManager: createSceneManager };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.HBScene = api;
  }
})();
