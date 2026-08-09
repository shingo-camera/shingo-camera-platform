// ============================================================
// functions/api/chance.js
// チャンス検索・ピンポイントチャンスの統合サーバAPI
// mode で分岐（'chance' / 'pinpoint'）。期間は365日で統一。
// 天体計算は _astro.js（共通モジュール）を使用し、ブラウザから秘匿。
// ============================================================
import { searchCore } from './_search.js';
import { moonAge, jst } from './_astro.js';

// 共通探索エンジン
// params:
//   sLat,sLng,sElev … 撮影地
//   t = {lat,lng,elev,h} … 被写体
//   dateStr … 起点日 YYYY-MM-DD
//   mode … 'chance' | 'pinpoint'
//   sunsetMode … chanceモードで太陽を探索するか（true=太陽 / false=月）
function search(params){
  const { sLat, sLng, sElev, t, dateStr, mode, sunsetMode, bodyFilter, dayOffset, dayCount } = params;
  const isPin = (mode === 'pinpoint');
  // 探索刻み：chanceは1分、pinpointは2分（既存挙動を不変に維持）。
  const step = isPin ? 2 * 60 * 1000 : 60 * 1000;
  let bodyModes;
  if(isPin){
    if(bodyFilter === 'moon') bodyModes = [false];
    else if(bodyFilter === 'sun') bodyModes = [true];
    else bodyModes = [false, true];
  } else {
    bodyModes = [ !!sunsetMode ];
  }
  const strategy = {
    azThr: distM => isPin ? (Math.atan2(30, distM) * 180 / Math.PI) : 2.5,
    buildResult: (fd, ds, isSun, ctx) => {
      const age = isSun ? null : moonAge(new Date(ds + 'T03:00:00Z'));
      if(isPin){
        const moveM = ctx.distM * Math.tan(fd.azDiff * Math.PI / 180);
        if(moveM > 30) return null; // MOVE_THR=30m
        return { date: ds, time: jst(fd.dt), azDiff: fd.azDiff,
          alt: fd.alt, baseAlt: ctx.baseAlt, topAlt: ctx.topAlt, distM: ctx.distM, age, ts: fd.dt.getTime(),
          angDiam: fd.angDiam, isSun, tAz: ctx.tAz, targetAngDiam: ctx.targetAngDiam,
          pLat: ctx.sLat, pLng: ctx.sLng, pElev: ctx.sElev };
      } else {
        return { date: ds, time: jst(fd.dt), azDiff: fd.azDiff,
          alt: fd.alt, baseAlt: ctx.baseAlt, topAlt: ctx.topAlt, distM: ctx.distM, age, ts: fd.dt.getTime(),
          angDiam: fd.angDiam };
      }
    }
  };
  return searchCore(
    { sLat, sLng, sElev, t, dateStr, dayOffset, dayCount, bodyModes, step },
    strategy);
}

export async function onRequest(context){
  const { request } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if(request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if(request.method !== 'POST')    return new Response('POST only', { status:405, headers: cors });
  try{
    const body = await request.json();
    const { sLat, sLng, sElev, t, dateStr, mode, sunsetMode, bodyFilter, dayOffset, dayCount } = body;
    if(typeof sLat!=='number' || typeof sLng!=='number' || !t || !dateStr || !mode){
      return new Response(JSON.stringify({error:'invalid input'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    const out = search({ sLat, sLng, sElev:sElev||0, t, dateStr, mode, sunsetMode:!!sunsetMode, bodyFilter, dayOffset, dayCount });
    return new Response(JSON.stringify(out), { headers:{...cors,'Content-Type':'application/json'} });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
