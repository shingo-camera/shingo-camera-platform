// ============================================================
// functions/api/pinpoint.js
// POST /api/pinpoint
// 📍 ピンポイント登録地点検索（MOVE_THR=30m）のサーバ実装。
// クライアント searchPinChances(pin) の計算を仕様不変で移植。
// 天体計算は functions/api/_astro.js を再利用（コピーしない）。
// 対象(target)はクライアントの resolveTargetT() で解決済みを受け取る。
// chance.js / /api/chance には一切依存しない独立実装。
// ============================================================
import { searchCore } from './_search.js';
import { moonAge, jst } from './_astro.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jresp(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
function jerr(msg, status){ return jresp({ error: msg }, status); }

// searchPinChances(pin) の完全移植。閾値・刻み・月/太陽条件・戻り値項目は不変。
// 差異は入力元のみ（today=startDate、pin/target=引数、t解決はクライアント側）。
function pinpointSearch(startDate, days, mode, pin, target){
  const bodyModes = mode === 'moon' ? [false] : mode === 'sun' ? [true] : [false, true];
  const { results } = searchCore(
    { sLat: pin.lat, sLng: pin.lng, sElev: pin.elev, t: target, dateStr: startDate,
      dayOffset: 0, dayCount: days, bodyModes, step: 60 * 1000 },
    {
      azThr: distM => Math.atan2(30, distM) * 180 / Math.PI,
      buildResult: (fd, ds, isSun, ctx) => {
        const moveM = ctx.distM * Math.tan(fd.azDiff * Math.PI / 180);
        if(moveM > 30) return null; // MOVE_THR=30m
        const age = isSun ? null : moonAge(new Date(ds + 'T03:00:00Z'));
        return { date: ds, time: jst(fd.dt), azDiff: fd.azDiff,
          alt: fd.alt, baseAlt: ctx.baseAlt, topAlt: ctx.topAlt, distM: ctx.distM, age, ts: fd.dt,
          angDiam: fd.angDiam, isSun, tAz: ctx.tAz, targetAngDiam: ctx.targetAngDiam,
          pLat: ctx.sLat, pLng: ctx.sLng, pElev: ctx.sElev };
      }
    }
  );
  return results;
}

const MAX_PINS = 10; // 暫定上限（性能実測後に変更予定）

function validatePinEntry(e){
  const okNum = v => typeof v === 'number' && isFinite(v);
  const pin = e && e.pin, target = e && e.target;
  if(!pin || !okNum(pin.lat) || !okNum(pin.lng) || !okNum(pin.elev)) return { ok: false };
  if(pin.lat < -90 || pin.lat > 90 || pin.lng < -180 || pin.lng > 180) return { ok: false };
  if(!target || !okNum(target.lat) || !okNum(target.lng) || !okNum(target.elev) || !okNum(target.h)) return { ok: false };
  if(target.lat < -90 || target.lat > 90 || target.lng < -180 || target.lng > 180) return { ok: false };
  return { ok: true, pin, target, pinId: (e.pinId != null ? e.pinId : null) };
}

export async function onRequest(context){
  const { request } = context;
  if(request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if(request.method !== 'POST')    return jerr('method not allowed', 405);

  let body;
  try { body = await request.json(); }
  catch(e){ return jerr('invalid input', 400); }

  const { startDate, days, body: bodyMode, pinId, pin, target, pins } = body || {};
  const okNum = v => typeof v === 'number' && isFinite(v);

  // API全体の検証（不正なら400）
  if(!startDate || typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return jerr('invalid input', 400);
  const nDays = (days == null) ? 365 : days;
  if(!Number.isInteger(nDays) || nDays < 1 || nDays > 366) return jerr('invalid input', 400);
  const mode = (bodyMode === 'moon' || bodyMode === 'sun') ? bodyMode : 'both';

  // ---- 複数Pin形式（pins配列）----
  if(Array.isArray(pins)){
    if(pins.length > MAX_PINS) return jerr('too many pins', 400);
    const t0 = Date.now();
    const out = [];
    for(const e of pins){ // 逐次（入力順を維持）
      const v = validatePinEntry(e);
      if(!v.ok){ out.push({ pinId: (e && e.pinId != null ? e.pinId : null), status: 'invalid', matches: [] }); continue; }
      try {
        const results = pinpointSearch(startDate, nDays, mode, v.pin, v.target);
        out.push({ pinId: v.pinId, status: 'ok', matches: results });
      } catch(err){
        console.error('[pinpoint] pin failed', (err && (err.stack || err.message)) || String(err));
        out.push({ pinId: v.pinId, status: 'error', matches: [] });
      }
    }
    return jresp({ results: out, meta: { processedPins: out.length, elapsedMs: Date.now() - t0 } }, 200);
  }

  // ---- 単一Pin形式（現行互換・完全維持）----
  if(!pin || !okNum(pin.lat) || !okNum(pin.lng) || !okNum(pin.elev)) return jerr('invalid input', 400);
  if(pin.lat < -90 || pin.lat > 90 || pin.lng < -180 || pin.lng > 180) return jerr('invalid input', 400);
  if(!target || !okNum(target.lat) || !okNum(target.lng) || !okNum(target.elev) || !okNum(target.h)) return jerr('invalid input', 400);
  if(target.lat < -90 || target.lat > 90 || target.lng < -180 || target.lng > 180) return jerr('invalid input', 400);

  try {
    const results = pinpointSearch(startDate, nDays, mode, pin, target);
    return jresp({ pinId: (pinId != null ? pinId : null), results }, 200);
  } catch(e){
    console.error('[pinpoint] search failed', (e && (e.stack || e.message)) || String(e));
    return jerr('internal error', 500);
  }
}
