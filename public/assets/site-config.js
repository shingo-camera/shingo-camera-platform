/**
 * WORK-011 公開サイト 設定集約ファイル
 *
 * 未確定情報（SNS実URL、note記事URL、Hero文言、表示価格 等）はすべてここに集約する。
 * ユーザー提供後は、このファイルの該当値を差し替えるだけで全画面へ反映される。
 *
 * 重要:
 * - 実URL・実価格・法務本文・事業者情報は推測しない。未確定のものは null のままにする。
 * - null の項目はUI側でリンク非活性・プレースホルダ表示になる（各画面/共通JSで判定）。
 */
window.SITE_CONFIG = {
  // ---- ブランド ----
  brandName: "shingo_camera",

  // ---- Hero（仮コピー。確定後に差し替え）----
  heroCopy: "撮影計画を、もっと正確に。", // 仮コピー（1行・サイズはCSS側で抑制）
  heroSub: null, // 補足説明（未確定なら null で非表示）

  // ---- SNS / 外部リンク（Footer）----
  // WORK-011 では Instagram と note のみ。X / YouTube は載せない。
  // 実URL未提供のため null。確定したらここに URL を入れるだけでリンクが有効化される。
  sns: {
    instagram: "https://www.instagram.com/shingo_camera/",
    note: "https://note.com/shingo_camera",
  },

  // ---- note 記事URL（商品ごとの詳しい説明・作例へ誘導）----
  // 役割分担: 詳しい説明書・使い方・作例は note 側。Platform は概要のみ。
  noteArticles: {
    sunAndMoon: "https://note.com/shingo_camera/n/na312aaf12877",       // SUN AND MOON PLANNER
    hanabi: "https://note.com/shingo_camera/n/n1b987c9773bb",           // HANABI PLANNER
    hanabiEarth: "https://note.com/shingo_camera/n/n1c252bd1f86a",      // HANABI Google Earth 連携
  },

  // ---- 商品の表示情報（説明書化しない。概要・代表機能・価格のみ）----
  // 注意: priceDisplay / amount は「表示専用」の参考値。実際の課金額は Stripe Price を正本とし、
  //       Webhook で amount_total を照合する（表示値と Stripe Price が乖離しても付与判定は Stripe 側）。
  products: {
    SUN_AND_MOON: {
      displayName: "SUN AND MOON PLANNER",
      // アプリ専用アイコン（実画像。SUN AND MOON 本体の apple-touch-icon と同一デザイン）
      icon: "/assets/icons/sun-and-moon.png",
      // 概要（1〜2文程度。詳細は note へ誘導）
      summary: "太陽・月が人物や建物と「いつ・どこで重なるか」を未来の予定まで自動計算し、撮影計画を立てるツール。",
      // 代表的な機能（説明書化せず要点のみ）
      features: [
        "撮影地と被写体から、太陽・月が重なるチャンスを探索",
        "満月・ピンポイントの撮影機会を計算",
        "地図上での天体位置表示・軌跡確認",
        "KMZ 出力による Google Earth 連携",
      ],
      // 価格は DB（M_PRODUCT.DISPLAY_PRICE / migration 0007）が正本。site-config には持たない。
      // アプリ起動先
      appUrl: "/apps/sun-and-moon/",
      // 商品コード（既存 API と突き合わせ）
      code: "SUN_AND_MOON",
    },
    HANABI: {
      displayName: "HANABI PLANNER",
      // アプリ専用アイコン（実画像。HANABI 本体の apple-touch-icon と同一デザイン）
      icon: "/assets/icons/hanabi.png",
      summary: "花火と人物・建物が「どこからどう見えるか」をシミュレーションし、撮影場所や構図を事前に計画するツール。",
      features: [
        "打ち上げ位置と撮影地から構図をシミュレーション",
        "Google Earth 連携で立体的に確認",
      ],
      appUrl: "/apps/hanabi/",   // Platform 統合済み（/apps/hanabi/ で静的配信・app-start で requireProduct(HANABI)）
      code: "HANABI",
    },
    HANABI_GOOGLE_EARTH: {
      displayName: "HANABI Google Earth 連携",
      // 表示は 2 行（§2: 1行目 HANABI PLANNER / 2行目 Google Earth 連携）。内部コード・displayName は不変。
      displayNameLines: ["HANABI PLANNER", "Google Earth 連携"],
      icon: "/assets/icons/hanabi-google-earth.png",
      summary: "撮影地点から花火や建物・被写体が「どこに・どう見えるのか」をGoogle Earth上で立体的に視覚化し、現地へ行く前に構図を確認できる追加機能。",
      features: [
        "Google Earth 上での立体的な構図確認",
      ],
      appUrl: null,
      // 商品マスタ(M_PRODUCT)に実在する PRODUCT_CODE。
      code: "HANABI_GOOGLE_EARTH",
      // 依存条件は M_PRODUCT_DEPENDENCY が正本（/api/products の dependencies で配信）。
      // ここに固定の依存定義（dependsOn）は持たない（二重管理を避ける）。
    },
  },

  // ---- 問い合わせ手段（未確定 → null。確定後に mailto: or 外部フォームURL を設定）----
  contact: {
    email: null,   // 例: "support@example.com"（mailto を生成）
    formUrl: null, // 外部フォームを使う場合の URL
  },

  // ---- 権限なし時の遷移先（SUN AND MOON アプリ側と一致させる）----
  noEntitlementUrl: "/products/sun-and-moon",
};
