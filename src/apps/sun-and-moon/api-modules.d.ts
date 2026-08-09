/**
 * SUN AND MOON 計算API（.js）の型宣言。
 *
 * 計算ロジックは sun-and-moon.zip の Pages Functions を無改変で移植した .js ファイル
 * （src/apps/sun-and-moon/api/*.js）。TypeScript から import するための最小型を宣言する。
 *
 * 各 .js は Pages Functions 形式の onRequest(context) をエクスポートする。
 * context は { request: Request; waitUntil?: (p: Promise<unknown>) => void } を最低限満たせばよい
 * （計算APIは context.request のみ使用、prefecture のみ context.waitUntil を使用）。
 *
 * 計算結果の同一性を守るため、これらの .js は改変しない。
 */
declare module "*/api/chance.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/events.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/fans.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/fullmoon.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/hello.js" {
  export function onRequest(context: SunMoonApiContext): Response;
}
declare module "*/api/instant.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/kmzastro.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/mooncalendar.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/pinpoint.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/prefecture.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/trajectory.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}
declare module "*/api/weatherbody.js" {
  export function onRequest(context: SunMoonApiContext): Promise<Response>;
}

interface SunMoonApiContext {
  request: Request;
  waitUntil?: (promise: Promise<unknown>) => void;
}
