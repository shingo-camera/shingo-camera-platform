// ============================================================
// functions/api/instant.js
// 指定日時・地点の天体計算（通常プレビュー用サーバAPI）
// 月位置 / 太陽位置 / 月齢 / 月の位相傾き を返す。
// 計算式は _astro.js（共通モジュール）を使用し、ブラウザから秘匿する。
// ============================================================

import {
  moonPos,
  sunPos,
  moonAge
} from './_astro.js';

// 月の位相傾き（3Dベクトル方式）
// index.html drawView() 内の計算をそのまま移植。
// アルゴリズム・符号・座標系は変更しない。moon=月位置, sun=太陽位置。
function calcMoonTilt(moon, sun){
  let moonTilt = 0;
  const mAzR = moon.az*Math.PI/180, mAltR = moon.alt*Math.PI/180;
  const sAzR = sun.az*Math.PI/180,  sAltR = sun.alt*Math.PI/180;
  // 北=+X,東=+Y,天頂=+Z の地平座標系で方向ベクトルを計算
  const vm=[Math.cos(mAltR)*Math.cos(mAzR),Math.cos(mAltR)*Math.sin(mAzR),Math.sin(mAltR)];
  const vs=[Math.cos(sAltR)*Math.cos(sAzR),Math.cos(sAltR)*Math.sin(sAzR),Math.sin(sAltR)];
  const dx=vs[0]-vm[0],dy=vs[1]-vm[1],dz=vs[2]-vm[2];
  const dl=Math.sqrt(dx*dx+dy*dy+dz*dz);
  if(dl>0){
    const dnx=dx/dl,dny=dy/dl,dnz=dz/dl;
    // 観察者視野基底: er=右方向, eu=上方向
    const erx=-Math.sin(mAzR),ery=Math.cos(mAzR);
    const eux=-Math.sin(mAltR)*Math.cos(mAzR),euy=-Math.sin(mAltR)*Math.sin(mAzR),euz=Math.cos(mAltR);
    const sun_right=dnx*erx+dny*ery;
    const sun_up=dnx*eux+dny*euy+dnz*euz;
    moonTilt=Math.atan2(-sun_up,sun_right);
  }
  return moonTilt;
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
    const { datetime, lat, lng } = body;

    // 最低限のバリデーション
    if(!datetime){
      return new Response(JSON.stringify({error:'invalid input: datetime required'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    const dt = new Date(datetime);
    if(isNaN(dt.getTime())){
      return new Response(JSON.stringify({error:'invalid input: datetime not a valid date'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    if(!Number.isFinite(lat) || !Number.isFinite(lng)){
      return new Response(JSON.stringify({error:'invalid input: lat/lng must be finite numbers'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }

    const moon = moonPos(dt, lat, lng);
    const sun  = sunPos(dt, lat, lng);
    const age  = moonAge(dt);
    const moonTilt = calcMoonTilt(moon, sun);

    const out = {
      moon: {
        alt: moon.alt, az: moon.az, dist_km: moon.dist_km,
        angDiam: moon.angDiam, ra: moon.ra, dec: moon.dec, Hr: moon.Hr
      },
      sun: {
        alt: sun.alt, az: sun.az, dist_au: sun.dist_au,
        angDiam: sun.angDiam, ra: sun.ra, dec: sun.dec, Hr: sun.Hr
      },
      moonAge: age,
      moonTilt
    };
    return new Response(JSON.stringify(out), { headers:{...cors,'Content-Type':'application/json'} });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
