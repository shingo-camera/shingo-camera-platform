// ============================================================
// functions/api/prefecture.js
// GET /api/prefecture?lat=..&lng=..
//   -> {prefecture, prefectureCode, source, distanceM}
// 都道府県判定の共通API。判定本体は _geo.js。既存POST系APIとは異なり、
// 静的参照でCache APIと相性が良いため、この endpoint のみ GET を採用。
// 成功=生payload（ok無し）、エラー=既存規約準拠の {error} + ステータス。
// ============================================================
import { getPrefectureInfo } from './_geo.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status, extraHeaders){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

export async function onRequest(context){
  const { request } = context;

  if(request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if(request.method !== 'GET')     return json({ error: 'method not allowed' }, 405);

  // --- 入力取得・検証 ---
  const url = new URL(request.url);
  const latRaw = url.searchParams.get('lat');
  const lngRaw = url.searchParams.get('lng');
  if(latRaw == null || lngRaw == null) return json({ error: 'invalid input' }, 400);
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if(!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: 'invalid input' }, 400); // NaN/Infinity/非数を拒否
  if(lat < -90 || lat > 90 || lng < -180 || lng > 180) return json({ error: 'invalid input' }, 400);

  // --- 5桁正規化（判定にもキャッシュキーにも同じ値を使い挙動を決定的に）---
  const lat5 = Math.round(lat * 1e5) / 1e5;
  const lng5 = Math.round(lng * 1e5) / 1e5;
  const cacheUrl = `${url.origin}/api/prefecture?lat=${lat5.toFixed(5)}&lng=${lng5.toFixed(5)}`;
  const cacheKey = new Request(cacheUrl, { method: 'GET' });

  // --- Cache API 参照 ---
  let cache = null;
  try { cache = (typeof caches !== 'undefined') ? caches.default : null; } catch(e){ cache = null; }
  if(cache){
    try {
      const hit = await cache.match(cacheKey);
      if(hit) return hit; // 成功結果のみ格納しているためそのまま返せる
    } catch(e){ /* 参照失敗は無視して本計算へ */ }
  }

  // --- 判定 ---
  let info;
  try {
    info = await getPrefectureInfo(lat5, lng5);
  } catch(e){
    // 内部詳細はログのみ。クライアントへは正規化メッセージ。
    console.error('[prefecture] lookup failed', (e && (e.stack || e.message)) || String(e));
    const isGeo = e && /geojson/i.test(String(e.message || e));
    return json({ error: isGeo ? 'geojson unavailable' : 'prefecture lookup failed' }, 500);
  }

  // --- 成功レスポンス（30日キャッシュ）---
  const res = json(info, 200, { 'Cache-Control': 'public, max-age=2592000' });

  // 成功のみ非同期put。書込失敗でAPI本体は失敗させない。
  if(cache){
    const put = Promise.resolve()
      .then(() => cache.put(cacheKey, res.clone()))
      .catch(e => console.error('[prefecture] cache put failed', String(e)));
    if(typeof context.waitUntil === 'function') context.waitUntil(put);
  }
  return res;
}
