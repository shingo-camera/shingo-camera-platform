// テスト対象の純関数を、Cloudflare Workers 依存を含まない形でバンドルする。
// purchases.ts は ../index（Env 型のみ）や stripe 等を import するが、
// テスト対象の parseProductCodes / parseStatusProductCodes / computeAllGranted は
// それらに依存しない純関数のため、esbuild で該当 export のみを取り出してバンドルできる。
//
// esbuild が無い環境では、依存を明示してスキップメッセージを出す（テストは失敗させない）。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const outDir = resolve(__dirname, "_bundle");
mkdirSync(outDir, { recursive: true });

// 純関数のみ re-export するエントリ
const entry = resolve(outDir, "_entry.ts");
writeFileSync(
  entry,
  `export { parseProductCodes, parseStatusProductCodes, computeAllGranted, resolveBaseUrl, settleAttemptViaStripe } from "../../src/routes/purchases";
export {
  precheckMultiCheckout, isProductAvailable, checkProductDependencies, assertNoDependencyCycle, DependencyConfigError, getAllProductDependencyGroups, SALE_TYPE_ONE_TIME, SALE_TYPE_SUBSCRIPTION,
} from "../../src/shared/purchase";
export { DependencyRequiredError } from "../../src/shared/errors";
export {
  validateOperationId, buildCartKey, buildIdempotencyKey,
  createAttemptWithLocks, attemptHoldsAllLocks, findActiveAttemptHoldingAnyProduct, findActiveAttemptsHoldingAnyProduct, getActiveAttemptsForUser,
  getAttemptByOperationId, getAttemptItems, buildPriceIdToCodeMapFromAttempt,
  updateAttemptStatus, releaseLocksForAttempt, cancelAttempt, expireAttempt, markAttemptPaid,
  markCreateAttempted, markAttemptPaidWithSession, isCreateResultIndeterminate, isLockConflictError,
  rebuildCreateParams, detectDuplicatePaidProductIds, recordPaymentEvent, buildPreparedItems,
  ATTEMPT_STATUS, PAYMENT_EVENT_TYPE,
} from "../../src/shared/checkout_attempt";
export { classifyCreateError } from "../../src/shared/stripe";
export { computeSessionIdHash } from "../../src/shared/session_hash";
export {
  recordAppStartAccess, recordEntitlementAccess, recordPeriodicAccess, AccessLogSettingError,
} from "../../src/shared/entitlement";
export { ACCESS_TYPE, writeAccessLog } from "../../src/shared/logs";
export { verifyLineItemsAndResolve, epochToJstIso, reconcileAttemptForSession } from "../../src/shared/stripe_fulfill";
export { isResetAllowedEnv, classifyActiveAttemptForReset, deletePurchaseStateForUser } from "../../src/routes/admin_test";
`,
);

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  // esbuild 不在時: node の型ストリップ（--experimental-strip-types）で代替できないため、
  // 明示的に案内して終了（テスト自体は import 失敗で分かる）。
  console.error("[test] esbuild not found. Run `npm install` first (esbuild is a devDependency).");
  process.exit(1);
}

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: resolve(outDir, "purchase_logic.mjs"),
  // Env 型のみの import は型消去されるため外部依存は発生しないが、保険で外部化
  external: ["stripe", "jose"],
  logLevel: "silent",
});

console.log("[test] built test/_bundle/purchase_logic.mjs");

// SUPPORT 問い合わせの検証純関数（依存なし）をバンドル
const supportEntry = resolve(outDir, "_support_entry.ts");
writeFileSync(
  supportEntry,
  `export { validateSupportInput, buildAdminMailText, buildAdminMailSubject, buildAckMailText, buildAckMailSubject, SUPPORT_CATEGORIES, SUPPORT_LIMITS } from "../../src/shared/support_validate";\n`,
);
await esbuild.build({
  entryPoints: [supportEntry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: resolve(outDir, "support_validate.mjs"),
  logLevel: "silent",
});

console.log("[test] built test/_bundle/support_validate.mjs");

// DEV shim 純関数（依存なし）をバンドル（test/dev_env.test.mjs 用）
const devEntry = resolve(outDir, "_dev_prefix_entry.ts");
writeFileSync(
  devEntry,
  `export { stripDevPrefix, devPrefixAttr } from "../../src/shared/dev_prefix";\n`,
);
await esbuild.build({
  entryPoints: [devEntry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: resolve(outDir, "dev_prefix.mjs"),
  logLevel: "silent",
});
console.log("[test] built test/_bundle/dev_prefix.mjs");

// DEV Access 認証境界（dev_access.ts）をバンドル（jose は external）
const devAccessEntry = resolve(outDir, "_dev_access_entry.ts");
writeFileSync(
  devAccessEntry,
  `export { isDevWebhookExempt, devAccessIssuer, verifyDevAccessEmail, resolveDevAccessEmail } from "../../src/shared/dev_access";\n`,
);
await esbuild.build({
  entryPoints: [devAccessEntry],
  bundle: true, format: "esm", platform: "node",
  external: ["jose"],
  outfile: resolve(outDir, "dev_access.mjs"),
  logLevel: "silent",
});
console.log("[test] built test/_bundle/dev_access.mjs");

// DEV レスポンス変換（dev_html.ts）をバンドル（HTMLRewriter はランタイム global＝external 不要）
const devHtmlEntry = resolve(outDir, "_dev_html_entry.ts");
writeFileSync(
  devHtmlEntry,
  `export { withNoindex, finalizeDevResponse, transformDevHtml } from "../../src/shared/dev_html";\n`,
);
await esbuild.build({
  entryPoints: [devHtmlEntry],
  bundle: true, format: "esm", platform: "neutral",
  outfile: resolve(outDir, "dev_html.mjs"),
  logLevel: "silent",
});
console.log("[test] built test/_bundle/dev_html.mjs");
