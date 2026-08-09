// ============================================================
// functions/api/fullmoon.js
// 満月チャンス検索（サーバ側処理）
// 天体計算の中核（moonPos / moonAge / refraction / calcParallax）を
// サーバに置くことで、これらの計算式をブラウザから秘匿する。
// クライアントは撮影地・被写体・日付を送り、結果配列を受け取るだけ。
// ============================================================

// ---- 共通天体計算モジュール ----

import {
  moonPos,
  moonAge,
  brng,
  hav,
  elAng,
  jst
} from './_astro.js';

function searchFullMoon(sLat, sLng, sElev, t, dateStr){
  const tAz   = brng(sLat, sLng, t.lat, t.lng);
  const distH = hav(sLat, sLng, t.lat, t.lng);
  const topAlt  = elAng(distH, sElev, t.elev, t.h);
  const baseAlt = elAng(distH, sElev, t.elev, 0);
  const AZ_THR = 2.5;
  const STEP   = 60*1000; // 1分刻み
  const MOON_R = 0.265;

  // 選択日から1年間の満月日（月齢13〜16.5）を列挙
  const today = new Date(dateStr + 'T00:00:00+09:00');
  const fullMoonDays = [];
  for(let d=0; d<366; d++){
    const base = new Date(today.getTime() + d*86400000);
    const ds = base.toLocaleDateString('sv-SE', {timeZone:'Asia/Tokyo'});
    const age = moonAge(new Date(ds + 'T12:00:00+09:00'));
    if(age>=13.0 && age<=16.5) fullMoonDays.push(ds);
  }

  const results = [];
  for(const ds of fullMoonDays){
    const dayStart = new Date(ds + 'T00:00:00+09:00');
    let found = null;
    for(let i=0; i<=1440; i++){
      const dt = new Date(dayStart.getTime() + i*STEP);
      const mp = moonPos(dt, sLat, sLng);
      const azD = Math.abs(((mp.az - tAz + 180)%360) - 180);
      if(azD<=AZ_THR && mp.alt>=(baseAlt-MOON_R) && mp.alt<=(topAlt+MOON_R)){
        if(!found) found={dt,az:mp.az,alt:mp.alt,azDiff:azD,angDiam:mp.angDiam||0.53};
        else if(Math.abs(mp.alt-topAlt) < Math.abs(found.alt-topAlt)) found={dt,az:mp.az,alt:mp.alt,azDiff:azD,angDiam:mp.angDiam||0.53};
      } else {
        if(found){
          const age = moonAge(new Date(ds + 'T03:00:00Z'));
          results.push({date:ds,time:jst(found.dt),azDiff:found.azDiff,alt:found.alt,topAlt,baseAlt,distM:distH*1000,age,ts:found.dt.getTime(),angDiam:found.angDiam});
          found=null;
        }
      }
    }
    if(found){
      const age = moonAge(new Date(ds + 'T03:00:00Z'));
      results.push({date:ds,time:jst(found.dt),azDiff:found.azDiff,alt:found.alt,topAlt,baseAlt,distM:distH*1000,age,ts:found.dt.getTime(),angDiam:found.angDiam});
    }
  }

  results.sort((a,b)=>a.ts-b.ts);
  return { results, tAz, topAlt, baseAlt, AZ_THR };
}

// ============================================================
// Cloudflare Pages Function エントリポイント
// ============================================================
export async function onRequest(context){
  const { request } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if(request.method === 'OPTIONS'){
    return new Response(null, { headers: cors });
  }
  if(request.method !== 'POST'){
    return new Response('POST only', { status: 405, headers: cors });
  }
  try{
    const body = await request.json();
    const { sLat, sLng, sElev, t, dateStr } = body;
    if(typeof sLat!=='number' || typeof sLng!=='number' || !t || !dateStr){
      return new Response(JSON.stringify({error:'invalid input'}), {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    const out = searchFullMoon(sLat, sLng, sElev||0, t, dateStr);
    return new Response(JSON.stringify(out), {
      headers: {...cors, 'Content-Type':'application/json'},
    });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
