// ============================================================
// functions/api/chance.js
// チャンス検索・ピンポイントチャンスの統合サーバAPI
// mode で分岐（'chance' / 'pinpoint'）。期間は365日で統一。
// 天体計算は _astro.js（共通モジュール）を使用し、ブラウザから秘匿。
// ============================================================
import { searchCore, acceptMove } from './_search.js';
import { moonAge, jstDateTime } from './_astro.js';

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
  // 探索刻み：chance / pinpoint / 一括pinpoint すべて1分で統一（§12）。
  // これにより同一撮影地点・対象・日時で通常/一括の代表時刻・m・★が一致する。
  const step = 60 * 1000;
  let bodyModes;
  if(isPin){
    if(bodyFilter === 'moon') bodyModes = [false];
    else if(bodyFilter === 'sun') bodyModes = [true];
    else bodyModes = [false, true];
  } else {
    bodyModes = [ !!sunsetMode ];
  }
  // 評価一本化：chance / pinpoint は同じ候補集合・同じ理想点・同じ必要移動距離 m を使う。
  // 違いは採否フィルタのみ（chance ≤200m / pinpoint ≤30m）。
  //   ・共通プレフィルタ：方位 ±(200m相当角)。これにより pinpoint 候補は chance 候補の部分集合。
  //   ・最終採否と★評価は searchCore が代表時刻へ添付する fd.moveM（実移動距離）を正本にする。
  const MAX_MOVE_M = isPin ? 30 : 200;
  const strategy = {
    // プレフィルタは searchCore が prefilterBounds(superset) で内部決定するため azThr は未使用。
    azThr: () => 180,
    buildResult: (fd, ds, isSun, ctx) => {
      // 採否は fail-closed：収束かつ moveM 閾値内のときのみ採用（NaN/Infinity/未収束は不採用, P0-4）。
      if(!acceptMove(fd, MAX_MOVE_M)) return null;
      const age = isSun ? null : moonAge(new Date(ds + 'T03:00:00Z'));
      // 表示 date/time は displayDt(=fd.dispDt) から同一Dateで生成（日跨ぎ安全）。azDiff/alt/angDiam も displayDt 由来。
      // ts は canonical fd.dt のまま（識別・sort・moveM検証用）。
      const dd = jstDateTime(fd.dispDt);
      if(isPin){
        return { date: dd.date, time: dd.time, azDiff: fd.azDiff, moveM: fd.moveM,
          alt: fd.alt, baseAlt: ctx.baseAlt, topAlt: ctx.topAlt, distM: ctx.distM, age, ts: fd.dt.getTime(),
          angDiam: fd.angDiam, isSun, tAz: ctx.tAz, targetAngDiam: ctx.targetAngDiam,
          pLat: ctx.sLat, pLng: ctx.sLng, pElev: ctx.sElev };
      } else {
        return { date: dd.date, time: dd.time, azDiff: fd.azDiff, moveM: fd.moveM,
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
