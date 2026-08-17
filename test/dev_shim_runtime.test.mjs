/**
 * DEV shim レスポンス変換の実ランタイム回帰（miniflare/workerd）。
 * 実コード src/shared/dev_html.ts（バンドル）を workerd 上で実行して検証する:
 *   - HTML <head> 先頭へ resolver を inline 注入（外部ロード成否に依存しない＝fail-closed）
 *   - ルート相対 src/href を /dev 前置（外部/hash は不変）
 *   - リダイレクト(3xx) の Location を /dev 前置（Production root 脱出の封鎖）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let Miniflare;
try { ({ Miniflare } = await import("miniflare")); } catch { /* skip if unavailable */ }

const bundle = readFileSync(new URL("./_bundle/dev_html.mjs", import.meta.url), "utf8");
const RESOLVER = "window.apiBase=function(){return '/dev'};window.__RESOLVER__=true;";

function makeWorker() {
  // dev_html バンドルを取り込み、テスト用の入力に対して変換を適用する module worker
  return `
${bundle}
export default {
  async fetch(request){
    const base="/dev";
    const u=new URL(request.url);
    if(u.pathname==="/redir"){
      return finalizeDevResponse(new Response(null,{status:308,headers:{Location:"/purchase/success/"}}), base);
    }
    if(u.pathname==="/ext-redir"){
      return finalizeDevResponse(new Response(null,{status:302,headers:{Location:"https://ext.example/x"}}), base);
    }
    const html='<!doctype html><html><head><meta charset="utf-8"><script src="/assets/x.js"></scr'+'ipt></head><body><a href="/store/">s</a><a href="#h">h</a><script async src="https://cdn/a.js"></scr'+'ipt></body></html>';
    const res=new Response(html,{headers:{"content-type":"text/html; charset=utf-8"}});
    return finalizeDevResponse(transformDevHtml(res, base, ${JSON.stringify(RESOLVER)}), base);
  }
}`;
}

test("[runtime] HTML: resolver を <head> 先頭へ inline 注入し、src/href を /dev 前置（外部/hash 不変）", { skip: !Miniflare }, async () => {
  const mf = new Miniflare({ modules: true, script: makeWorker() });
  const r = await mf.dispatchFetch("https://x.example/dev/purchase/success/");
  const body = await r.text();
  assert.match(body, /<head><script>window\.apiBase=function/, "resolver が head 先頭に inline 注入");
  assert.match(body, /__RESOLVER__/, "resolver 本体が入っている");
  assert.match(body, /src="\/dev\/assets\/x\.js"/, "内部 src は /dev 前置");
  assert.match(body, /href="\/dev\/store\/"/, "内部 href は /dev 前置");
  assert.match(body, /src="https:\/\/cdn\/a\.js"/, "外部 src は不変");
  assert.match(body, /href="#h"/, "hash は不変");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  await mf.dispose();
});

test("[runtime] リダイレクト(3xx) の Location を /dev 前置（外部は不変）", { skip: !Miniflare }, async () => {
  const mf = new Miniflare({ modules: true, script: makeWorker() });
  const r = await mf.dispatchFetch("https://x.example/redir", { redirect: "manual" });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "/dev/purchase/success/", "ルート相対 Location は /dev 前置");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  const r2 = await mf.dispatchFetch("https://x.example/ext-redir", { redirect: "manual" });
  assert.equal(r2.headers.get("location"), "https://ext.example/x", "外部 Location は不変");
  await mf.dispose();
});
