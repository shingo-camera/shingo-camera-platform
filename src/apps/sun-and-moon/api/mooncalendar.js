// ============================================================
// functions/api/mooncalendar.js
// 「満ち欠けカレンダー」1か月分の 月齢 / 月の出 / 月の入（サーバ側）
// portrait.html の moonT()/moonTCached() と同一アルゴリズムを移植。
// 計算式は _astro.js（共通モジュール）を使用しブラウザから秘匿する。
// ============================================================

import {
  moonPos,
  moonAge
} from './_astro.js';

// 月の出・月の入（portrait.html moonT() 相当）
// JST 0時基準・10分刻み粗探索・閾値0°・上向き=出/下向き=入・各交差8回二分探索。
// moonPos()の補正済み高度をそのまま使用。
function moonEvents(dateStr, lat, lng){
  const base = new Date(dateStr + 'T00:00:00+09:00');
  let rise=null, set=null, prev=null, prevT=null;
  for(let h=0; h<=25.1; h+=10/60){
    const t=new Date(base.getTime()+h*3600000);
    const p=moonPos(t,lat,lng);
    if(prev!==null){
      if(prev<=0 && p.alt>0 && !rise){
        let lo=prevT, hi=t;
        for(let i=0;i<8;i++){ const mid=new Date((lo.getTime()+hi.getTime())/2); if(moonPos(mid,lat,lng).alt>0)hi=mid; else lo=mid; }
        rise=new Date((lo.getTime()+hi.getTime())/2);
      }
      if(prev>0 && p.alt<=0 && !set){
        let lo=prevT, hi=t;
        for(let i=0;i<8;i++){ const mid=new Date((lo.getTime()+hi.getTime())/2); if(moonPos(mid,lat,lng).alt<0)hi=mid; else lo=mid; }
        set=new Date((lo.getTime()+hi.getTime())/2);
      }
    }
    prev=p.alt; prevT=t;
  }
  return {rise,set};
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
  if(request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if(request.method !== 'POST')    return new Response('POST only', { status:405, headers: cors });
  try{
    const body = await request.json();
    const { year, month, lat, lng } = body;

    // 最低限のバリデーション（現実的な年範囲に限定）
    if(!Number.isInteger(year) || year<1900 || year>2100){
      return new Response(JSON.stringify({error:'invalid input: year must be an integer within 1900-2100'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    if(!Number.isInteger(month) || month<1 || month>12){
      return new Response(JSON.stringify({error:'invalid input: month must be an integer 1-12'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    if(!Number.isFinite(lat) || !Number.isFinite(lng)){
      return new Response(JSON.stringify({error:'invalid input: lat/lng must be finite numbers'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }

    // 月末日（TZ非依存でUTC基準に算出）。month は 1-12。
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const days = [];
    for(let d=1; d<=daysInMonth; d++){
      const date = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const age  = moonAge(new Date(date + 'T03:00:00Z'));
      const mt   = moonEvents(date, lat, lng);
      days.push({
        date,
        moonAge: age,
        rise: mt.rise ? mt.rise.toISOString() : null,
        set:  mt.set  ? mt.set.toISOString()  : null
      });
    }

    return new Response(JSON.stringify({ year, month, days }), {
      headers:{...cors,'Content-Type':'application/json'}
    });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
