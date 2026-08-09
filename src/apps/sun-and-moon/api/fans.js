// ============================================================
// functions/api/fans.js
// 地図の扇形（月・太陽の出入±30分の方位範囲）をサーバ側で計算。
// drawFans() と同一仕様：
//   月 … 出入時刻は observer 地点、方位は target 地点
//   太陽 … 出入時刻も方位も target 地点（sunT を target で再計算）
// 計算式は _astro.js（共通モジュール）を使用しブラウザから秘匿する。
// 扇形・同心円・凡例の描画はクライアント側に残す。
// ============================================================

import {
  moonPos,
  sunPos,
  refraction
} from './_astro.js';

const STEP = 30*60*1000; // 30分

// 月の出・月の入（portrait.html moonT() 相当）
// JST 0時基準・10分刻み・閾値0°・上向き=出/下向き=入・各交差8回二分探索・補正済みalt。
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

// 日の出・日の入（portrait.html sunT() 相当）
// JST 0時基準・5分刻み・閾値-0.833°・各交差8回二分探索・alt-refraction(alt)。交差なしはnull。
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

// 出（rise）区間：開始=rise、終了=rise+30分。方位は posFn を target 地点で評価。
function riseRange(riseTime, posFn, tLat, tLng){
  const startTime=riseTime;
  const endTime=new Date(riseTime.getTime()+STEP);
  return {
    startTime: startTime.toISOString(),
    endTime:   endTime.toISOString(),
    startAz:   posFn(startTime, tLat, tLng).az,
    endAz:     posFn(endTime,   tLat, tLng).az
  };
}
// 入（set）区間：開始=set-30分、終了=set。
function setRange(setTime, posFn, tLat, tLng){
  const startTime=new Date(setTime.getTime()-STEP);
  const endTime=setTime;
  return {
    startTime: startTime.toISOString(),
    endTime:   endTime.toISOString(),
    startAz:   posFn(startTime, tLat, tLng).az,
    endAz:     posFn(endTime,   tLat, tLng).az
  };
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
    const { date, observerLat, observerLng, targetLat, targetLng } = body;

    // 最低限のバリデーション
    if(!date || !validDateStr(date)){
      return new Response(JSON.stringify({error:'invalid input: date must be a real YYYY-MM-DD'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    if(![observerLat, observerLng, targetLat, targetLng].every(Number.isFinite)){
      return new Response(JSON.stringify({error:'invalid input: lat/lng must be finite numbers'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }

    // 月：出入時刻は observer 地点、方位は target 地点
    const m = moonEvents(date, observerLat, observerLng); // {rise,set}
    const moon = {
      rise: m.rise ? riseRange(m.rise, moonPos, targetLat, targetLng) : null,
      set:  m.set  ? setRange(m.set,  moonPos, targetLat, targetLng) : null
    };

    // 太陽：出入時刻も方位も target 地点
    const s = sunEvents(date, targetLat, targetLng); // {rise,set} | null
    const sun = {
      rise: (s && s.rise) ? riseRange(s.rise, sunPos, targetLat, targetLng) : null,
      set:  (s && s.set)  ? setRange(s.set,  sunPos, targetLat, targetLng) : null
    };

    return new Response(JSON.stringify({ moon, sun }), {
      headers:{...cors,'Content-Type':'application/json'}
    });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
