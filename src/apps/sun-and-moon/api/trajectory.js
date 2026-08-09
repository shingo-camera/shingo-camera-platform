// ============================================================
// functions/api/trajectory.js
// drawView() の日周トラック／拡大時5秒ティック／ズームスクラブ・再生 用の
// 月・太陽位置と月傾きをサーバ計算。Canvas描画・座標投影・ズーム再生制御はクライアントに残す。
// 月傾きは instant.js / kmzastro.js と同一の3Dベクトル方式（符号・座標系不変）。
// 計算式は _astro.js（共通モジュール）を使用しブラウザから秘匿する。
//
//   track : 日周トラック。JST 0:00 起点・stepSec 刻み（0.5分＝30秒）で24h（焦点距離非依存の固定グリッド）
//   zoom  : ズーム系列。centerDatetime を中心に ±rangeSec を stepSec(=1) 刻み（±1380秒＝2761点）
// track と zoom は個別に要求可能（null で省略）。
// ============================================================

import {
  moonPos,
  sunPos
} from './_astro.js';

// 月の位相傾き（3Dベクトル方式）。moon=月位置, sun=太陽位置。返却ラジアン。
function calcMoonTilt(moon, sun){
  const mAzR=moon.az*Math.PI/180, mAltR=moon.alt*Math.PI/180;
  const sAzR=sun.az*Math.PI/180,  sAltR=sun.alt*Math.PI/180;
  const vm=[Math.cos(mAltR)*Math.cos(mAzR),Math.cos(mAltR)*Math.sin(mAzR),Math.sin(mAltR)];
  const vs=[Math.cos(sAltR)*Math.cos(sAzR),Math.cos(sAltR)*Math.sin(sAzR),Math.sin(sAltR)];
  const dx=vs[0]-vm[0],dy=vs[1]-vm[1],dz=vs[2]-vm[2];
  const dl=Math.sqrt(dx*dx+dy*dy+dz*dz);
  let moonTilt=0;
  if(dl>0){
    const dnx=dx/dl,dny=dy/dl,dnz=dz/dl;
    const erx=-Math.sin(mAzR),ery=Math.cos(mAzR);
    const eux=-Math.sin(mAltR)*Math.cos(mAzR),euy=-Math.sin(mAltR)*Math.sin(mAzR),euz=Math.cos(mAltR);
    const sun_right=dnx*erx+dny*ery;
    const sun_up=dnx*eux+dny*euy+dnz*euz;
    moonTilt=Math.atan2(-sun_up,sun_right);
  }
  return moonTilt;
}

// 1点分の天体値（moon/sunは各1回）
function computePoint(dt, lat, lng){
  const moon=moonPos(dt,lat,lng);
  const sun =sunPos(dt,lat,lng);
  return {
    moon:{ alt:moon.alt, az:moon.az, angDiam:moon.angDiam },
    sun: { alt:sun.alt,  az:sun.az,  angDiam:sun.angDiam },
    moonTilt: calcMoonTilt(moon, sun)
  };
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
  const bad = msg => new Response(JSON.stringify({error:'invalid input: '+msg}),
    {status:400, headers:{...cors,'Content-Type':'application/json'}});
  try{
    const body = await request.json();
    const { lat, lng, track, zoom } = body;

    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return bad('lat/lng must be finite numbers');
    if(!track && !zoom) return bad('at least one of track/zoom is required');

    let trackOut = null, zoomOut = null;

    // ── 日周トラック：JST 0:00 起点・stepSec 刻みで 24h ──
    if(track){
      const date = track.date;
      const stepSec = track.stepSec;
      if(typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad('track.date must be YYYY-MM-DD');
      if(!Number.isFinite(stepSec) || stepSec <= 0) return bad('track.stepSec must be a positive number');
      const base = new Date(date + 'T00:00:00+09:00');
      if(isNaN(base.getTime())) return bad('track.date is not a valid date');
      const n = Math.floor(86400/stepSec) + 1;
      if(n > 5000) return bad('track has too many points');
      trackOut = [];
      for(let i=0;i<n;i++){
        const dt = new Date(base.getTime() + i*stepSec*1000);
        const p = computePoint(dt, lat, lng);
        trackOut.push({ datetime: dt.toISOString(), moon:p.moon, sun:p.sun, moonTilt:p.moonTilt });
      }
    }

    // ── ズーム系列：centerDatetime ± rangeSec を stepSec 刻み ──
    if(zoom){
      const center = new Date(zoom.centerDatetime);
      const rangeSec = zoom.rangeSec;
      const stepSec = zoom.stepSec;
      if(isNaN(center.getTime())) return bad('zoom.centerDatetime is invalid');
      if(!Number.isFinite(rangeSec) || rangeSec < 0 || rangeSec > 1380) return bad('zoom.rangeSec must be within 0..1380');
      if(stepSec !== 1) return bad('zoom.stepSec must be 1');
      const cnt = Math.floor(2*rangeSec/stepSec) + 1;
      if(cnt > 5000) return bad('zoom has too many points');
      zoomOut = [];
      for(let os=-rangeSec; os<=rangeSec; os+=stepSec){
        const dt = new Date(center.getTime() + os*1000);
        const p = computePoint(dt, lat, lng);
        zoomOut.push({ datetime: dt.toISOString(), offsetSec: os, moon:p.moon, sun:p.sun, moonTilt:p.moonTilt });
      }
    }

    return new Response(JSON.stringify({ track: trackOut, zoom: zoomOut }), {
      headers:{...cors,'Content-Type':'application/json'}
    });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
