/**
 * DEV レスポンス変換（HTMLRewriter 依存のみ・stripe 等の重依存なし＝miniflare でテスト可能）。
 * index.ts の handleDevRequest から利用。Production では呼ばれない（DEV_BASE_PATH 未設定で no-op）。
 */
import { devPrefixAttr } from "./dev_prefix";

/** レスポンスへ noindex ヘッダを付与（既存 body/ヘッダは保持）。 */
export function withNoindex(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}

/**
 * DEV レスポンスの最終処理。リダイレクト(3xx)の Location がルート相対なら /dev を前置し
 * （ASSETS/route のリダイレクトで Production root へ脱出しないため）、noindex を付与する。
 */
export function finalizeDevResponse(res: Response, base: string): Response {
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("Location");
    const nl = devPrefixAttr(loc, base);
    if (loc != null && nl != null && nl !== loc) {
      const out = new Response(res.body, res);
      out.headers.set("Location", nl);
      out.headers.set("X-Robots-Tag", "noindex, nofollow");
      return out;
    }
  }
  return withNoindex(res);
}

/**
 * DEV の HTML を変換する:
 *   (1) apiBaseSrc があれば <head> 先頭へ inline 注入（URL resolver を外部ロード成否に依存させず
 *       必ず・最初に定義＝fail-closed）。
 *   (2) ルート相対 src/href/action/poster を /dev 前置（DEV が develop の資産を自己完結で読む）。
 * HTMLRewriter はランタイム global（workerd/miniflare）。
 */
export function transformDevHtml(res: Response, base: string, apiBaseSrc: string): Response {
  let rw = new HTMLRewriter();
  if (apiBaseSrc) {
    rw = rw.on("head", {
      element(e) {
        e.prepend(`<script>${apiBaseSrc}</script>`, { html: true });
      },
    });
  }
  const attr = (name: "href" | "src" | "action" | "poster") => ({
    element(e: { getAttribute(n: string): string | null; setAttribute(n: string, v: string): void }) {
      const v = devPrefixAttr(e.getAttribute(name), base);
      if (v != null) e.setAttribute(name, v);
    },
  });
  return rw
    .on("[href]", attr("href"))
    .on("[src]", attr("src"))
    .on("[action]", attr("action"))
    .on("[poster]", attr("poster"))
    .transform(res);
}
