// ============================================================
// functions/api/kmzastro.js
// Google Earth KMZ 生成用の天体計算（各時刻の月/太陽位置・角直径・月齢・月傾き）を一括計算。
// KML/COLLADA生成・Canvas天体画像・JSZip・ダウンロード・Google Earth座標変換はクライアントに残す。
// calcMoonTiltStandalone() の3Dベクトル方式を符号・座標系そのまま移植。
// 計算式は _astro.js（共通モジュール）を使用しブラウザから秘匿する。
// ============================================================

import {
  moonPos,
  sunPos,
  moonAge
} from './_astro.js';

// 月の位相傾き（3Dベクトル方式）。portrait.html calcMoonTiltStandalone と同一。
// bp=月位置, sp=太陽位置。返却はラジアン。
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
    const { lat, lng, isSun, datetimes } = body;

    // 最低限のバリデーション
    if(!Number.isFinite(lat) || !Number.isFinite(lng)){
      return new Response(JSON.stringify({error:'invalid input: lat/lng must be finite numbers'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    if(typeof isSun !== 'boolean'){
      return new Response(JSON.stringify({error:'invalid input: isSun must be boolean'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    if(!Array.isArray(datetimes) || datetimes.length===0){
      return new Response(JSON.stringify({error:'invalid input: datetimes must be a non-empty array'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    if(datetimes.length > 500){
      return new Response(JSON.stringify({error:'invalid input: too many datetimes (max 500)'}),
        {status:400, headers:{...cors,'Content-Type':'application/json'}});
    }
    for(const iso of datetimes){
      if(isNaN(new Date(iso).getTime())){
        return new Response(JSON.stringify({error:'invalid input: datetimes contains an invalid date'}),
          {status:400, headers:{...cors,'Content-Type':'application/json'}});
      }
    }

    const results = datetimes.map(iso => {
      const dt   = new Date(iso);
      const moon = moonPos(dt, lat, lng);   // 各時刻につき moonPos/sunPos は1回ずつ
      const sun  = sunPos(dt, lat, lng);
      const b    = isSun ? sun : moon;
      const age  = moonAge(dt);
      const moonTilt = calcMoonTilt(moon, sun);
      return {
        datetime: iso,
        body: { alt: b.alt, az: b.az, angDiam: b.angDiam },
        moon: { alt: moon.alt, az: moon.az, dist_km: moon.dist_km, angDiam: moon.angDiam, ra: moon.ra, dec: moon.dec, Hr: moon.Hr },
        sun:  { alt: sun.alt,  az: sun.az,  dist_au: sun.dist_au,  angDiam: sun.angDiam,  ra: sun.ra,  dec: sun.dec,  Hr: sun.Hr },
        moonAge: age,
        moonTilt
      };
    });

    return new Response(JSON.stringify({ results }), {
      headers:{...cors,'Content-Type':'application/json'}
    });
  }catch(e){
    return new Response(JSON.stringify({error:String(e)}), {status:500, headers:{...cors,'Content-Type':'application/json'}});
  }
}
