// ============================================================
// functions/api/weatherbody.js
// 天気判定用の天体幾何（月・太陽の方位/仰角）と雲層視線交点をサーバ計算。
// portrait.html の _cloudPiercePoints()/_cloudPierceDist()/_ridgeLatLng() を
// 挙動を変えず移植。Open-Meteo取得・天気キャッシュ・透明度計算・表示はクライアントに残す。
// 計算式は _astro.js（共通モジュール）を使用しブラウザから秘匿する。
// ============================================================

import {
  moonPos,
  sunPos
} from './_astro.js';

// クライアントと同一の定数（雲層代表高度・交点距離上限）
const CLOUD_LAYER_H = { low: 1500, mid: 4500, high: 9000 }; // 各層の代表高度(m)
const CLOUD_DIST_CAP = 200000; // 交点距離の上限(m)

// 方位azRad・水平距離xm(m)の地点の緯度経度（portrait.html _ridgeLatLng と同一）
function _ridgeLatLng(lat,lng,azRad,xm){
  const R=6371000;
  const la=lat+(xm*Math.cos(azRad)/R)*(180/Math.PI);
  const lo=lng+(xm*Math.sin(azRad)/R)*(180/Math.PI)/Math.cos(lat*Math.PI/180);
  return [la,lo];
}

// 視線が雲層代表高度hを貫く水平距離(m)。地球曲率＋屈折(k=0.13)込み。仰角下限0.5°。
function _cloudPierceDist(altDeg, h){
  const a = Math.max(0.5, altDeg) * Math.PI / 180;
  const Reff = 6371000 / (1 - 0.13);
  const t = Math.tan(a);
  return Math.min(CLOUD_DIST_CAP, Reff * (-t + Math.sqrt(t*t + 2*h/Reff)));
}

// 低・中・高層雲との視線交点（portrait.html _cloudPiercePoints と同一）
function cloudPiercePoints(sLat_, sLng_, az, alt){
  const azr = az * Math.PI / 180, o = {};
  for(const k of ['low','mid','high']){
    const [la, lo] = _ridgeLatLng(sLat_, sLng_, azr, _cloudPierceDist(alt, CLOUD_LAYER_H[k]));
    o[k] = { lat: la, lng: lo };
  }
  return o;
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
    const points = body && body.points;

    // 最低限のバリデーション（不正が1件でもあればリクエスト全体を400）
    if(!Array.isArray(points)){
      return new Response(JSON.stringify({error:'invalid input: points must be an array'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    for(const p of points){
      if(!p || isNaN(new Date(p.datetime).getTime())
         || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)
         || typeof p.isSun !== 'boolean'){
        return new Response(JSON.stringify({error:'invalid input: each point needs valid datetime, finite lat/lng, boolean isSun'}),
          {status:400, headers:{...cors,'Content-Type':'application/json'}});
      }
    }

    const results = points.map(p => {
      const dt = new Date(p.datetime);
      const b = p.isSun ? sunPos(dt, p.lat, p.lng) : moonPos(dt, p.lat, p.lng);
      const pierce = cloudPiercePoints(p.lat, p.lng, b.az, b.alt);
      return { id: p.id, az: b.az, alt: b.alt, low: pierce.low, mid: pierce.mid, high: pierce.high };
    });

    return new Response(JSON.stringify({ results }), {
      headers:{...cors,'Content-Type':'application/json'}
    });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
