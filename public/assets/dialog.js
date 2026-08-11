/**
 * Platform 共通ダイアログ（軽量・依存なし）
 *
 * showDialog({ title, message, primaryText, secondaryText, variant }) => Promise<boolean>
 *   - primary（続ける/削除する/新しく購入する 等）押下 → resolve(true)
 *   - secondary（キャンセル/戻る）・ESC・背景クリック → resolve(false)
 *   - variant: "info"（primary のみ, OK）| "confirm"（既定）| "danger"（危険操作）
 *
 * a11y: role=dialog / aria-modal / ESC / 背景クリックで閉じる / focus trap / 開いた時に primary へ移動。
 * 単一インスタンスを使い回す（多重オープンは前を閉じてから開く）。
 */
(function () {
  if (window.showDialog) return; // 二重定義防止

  var current = null; // { overlay, resolve, prevFocus, keyHandler }

  function close(result) {
    if (!current) return;
    var c = current;
    current = null;
    document.removeEventListener("keydown", c.keyHandler, true);
    c.overlay.classList.remove("is-open");
    // トランジション後に除去
    setTimeout(function () {
      if (c.overlay && c.overlay.parentNode) c.overlay.parentNode.removeChild(c.overlay);
      // フォーカスを元へ戻す
      if (c.prevFocus && typeof c.prevFocus.focus === "function") {
        try { c.prevFocus.focus(); } catch (e) {}
      }
    }, 160);
    c.resolve(result);
  }

  function getFocusable(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
  }

  window.showDialog = function (opts) {
    opts = opts || {};
    var variant = opts.variant || "confirm";
    var isInfo = variant === "info";
    var isDanger = variant === "danger";
    var primaryText = opts.primaryText || (isInfo ? "OK" : "続ける");
    var secondaryText = opts.secondaryText || "キャンセル";

    // 前のダイアログが開いていれば閉じる
    if (current) close(false);

    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "scp-dialog-overlay";

      var titleId = "scp-dlg-title-" + Date.now();
      var msgId = "scp-dlg-msg-" + Date.now();

      var box = document.createElement("div");
      box.className = "scp-dialog" + (isDanger ? " scp-dialog--danger" : "");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", titleId);
      box.setAttribute("aria-describedby", msgId);

      var h = document.createElement("div");
      h.className = "scp-dialog__title";
      h.id = titleId;
      h.textContent = opts.title || "";

      var m = document.createElement("div");
      m.className = "scp-dialog__message";
      m.id = msgId;
      m.textContent = opts.message || "";

      var actions = document.createElement("div");
      actions.className = "scp-dialog__actions";

      // secondary（info では出さない）を先、primary を後（右）に配置。
      var secondaryBtn = null;
      if (!isInfo) {
        secondaryBtn = document.createElement("button");
        secondaryBtn.type = "button";
        secondaryBtn.className = "scp-dialog__btn scp-dialog__btn--secondary";
        secondaryBtn.textContent = secondaryText;
        secondaryBtn.addEventListener("click", function () { close(false); });
        actions.appendChild(secondaryBtn);
      }

      var primaryBtn = document.createElement("button");
      primaryBtn.type = "button";
      primaryBtn.className =
        "scp-dialog__btn scp-dialog__btn--primary" + (isDanger ? " scp-dialog__btn--danger" : "");
      primaryBtn.textContent = primaryText;
      primaryBtn.addEventListener("click", function () { close(true); });
      actions.appendChild(primaryBtn);

      if (opts.title) box.appendChild(h);
      box.appendChild(m);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // 背景クリックで閉じる（secondary 相当）。box 内クリックは無視。
      overlay.addEventListener("mousedown", function (e) {
        if (e.target === overlay) close(false);
      });

      var keyHandler = function (e) {
        if (e.key === "Escape") {
          e.preventDefault();
          close(false);
          return;
        }
        if (e.key === "Tab") {
          // focus trap
          var f = getFocusable(box);
          if (f.length === 0) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
          }
        }
      };
      document.addEventListener("keydown", keyHandler, true);

      current = {
        overlay: overlay,
        resolve: resolve,
        prevFocus: document.activeElement,
        keyHandler: keyHandler,
      };

      // 表示アニメーション + primary へフォーカス
      requestAnimationFrame(function () {
        overlay.classList.add("is-open");
        primaryBtn.focus();
      });
    });
  };
})();
