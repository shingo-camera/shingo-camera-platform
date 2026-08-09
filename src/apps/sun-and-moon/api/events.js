// ============================================================
// functions/api/events.js
// 「05 太陽・月」欄の選択日1日分の天体イベント（サーバ側）
//   日の出 / 日の入 / 月の出 / 月の入 / 月齢
// portrait.html の sunT() / moonT() のアルゴリズムを挙動を変えず移植。
// 計算式は _astro.js（共通モジュール）を使用しブラウザから秘匿する。
// ============================================================

import {
  moonPos,
  sunPos,
  moonAge,
  refraction
} from './_astro.js';

// 日の出・日の入（portrait.html sunT() 相当）
// 5分刻み粗探索・閾値-0.833°・各交差を8回二分探索。
// 高度判定は大気差を除いた真の仰角 alt - refraction(alt)。
function sunEvents(dateStr, lat, lng){
  const base = new Date(dateStr + 'T00:00:00+09:00');
  let rise=null, set=null, prev=null, prevT=null;
  const thresh=-0.833;
  for(let h=0; h<=25.1; h+=5/60){
    const t=new Date(base.getTime()+h*3600000);
    const p=sunPos(t,lat,lng);
    const alt=p.alt-refraction(p.alt);
    if(prev!==null){
      if(prev<=thresh && alt>thresh && !rise){
        let lo=prevT, hi=t;
        for(let i=0;i<8;i++){ const mid=new Date((lo.getTime()+hi.getTime())/2); const a=sunPos(mid,lat,lng).alt-refraction(sunPos(mid,lat,lng).alt); if(a>thresh)hi=mid; else lo=mid; }
        rise=new Date((lo.getTime()+hi.getTime())/2);
      }
      if(prev>thresh && alt<=thresh && !set){
        let lo=prevT, hi=t;
        for(let i=0;i<8;i++){ const mid=new Date((lo.getTime()+hi.getTime())/2); const a=sunPos(mid,lat,lng).alt-refraction(sunPos(mid,lat,lng).alt); if(a<thresh)hi=mid; else lo=mid; }
        set=new Date((lo.getTime()+hi.getTime())/2);
      }
    }
    prev=alt; prevT=t;
  }
  return (rise||set) ? {rise,set} : null;
}

// 月の出・月の入（portrait.html moonT() 相当）
// 10分刻み粗探索・閾値0°・各交差を8回二分探索。moonPos()の補正済み高度をそのまま使用。
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

// YYYY-MM-DD 形式＋実在日付チェック
function validDateStr(s){
  if(typeof s!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y,m,d]=s.split('-').map(Number);
  const chk=new Date(Date.UTC(y, m-1, d));
  return chk.getUTCFullYear()===y && chk.getUTCMonth()===m-1 && chk.getUTCDate()===d;
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
    const { date, lat, lng } = body;

    // 最低限のバリデーション
    if(!date || !validDateStr(date)){
      return new Response(JSON.stringify({error:'invalid input: date must be a real YYYY-MM-DD'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    if(!Number.isFinite(lat) || !Number.isFinite(lng)){
      return new Response(JSON.stringify({error:'invalid input: lat/lng must be finite numbers'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }

    const sun  = sunEvents(date, lat, lng);   // {rise,set} | null
    const moon = moonEvents(date, lat, lng);  // {rise,set}
    const age  = moonAge(new Date(date + 'T03:00:00Z'));

    const toISO = d => d ? d.toISOString() : null;
    const out = {
      sun:  { rise: toISO(sun && sun.rise), set: toISO(sun && sun.set) },
      moon: { rise: toISO(moon.rise),       set: toISO(moon.set) },
      moonAge: age
    };
    return new Response(JSON.stringify(out), { headers:{...cors,'Content-Type':'application/json'} });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
