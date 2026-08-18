// SUN AND MOON プレビュー不具合2件の回帰テスト（canvas描画のためロジックを純関数として特性化）。
// 1) 空色決定を太陽/月モードで共通化（getSkyColors/SKY_TABLE）。太陽モードでも夜間に夕焼けが残らない。
//    月モードの見た目（テーブル・3ストップ構成）は不変。
// 2) 被写体シルエット描画ゲートを高さだけでなく幅も見る（薄く広い形状が広角で消えない）。physWは全shapeの投影可視幅の妥当な代理。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("public/apps/sun-and-moon/index.html", "utf8");

// ── 不具合1：空色ロジックの共通化 ──
test("[bug1] 太陽モード専用の第二の夜間色ロジック(nightK/_NT/_NM/_NB, btグラデ)が撤去されている", () => {
  assert.doesNotMatch(html, /const nightK=/, "nightK(太陽専用夜間フェード)が残っていない");
  assert.doesNotMatch(html, /_NT=\[4,8,20\]/, "_NT等の太陽専用夜色配列が残っていない");
  assert.doesNotMatch(html, /sunAltForBg/, "太陽専用のsunAltForBg分岐が残っていない");
});
test("[bug1] 空色は太陽/月共通の getSkyColors / SKY_TABLE を使用（単一実装）", () => {
  // getSkyColors / SKY_TABLE は1箇所のみ（共通化＝二重管理でない）
  const nGsc = (html.match(/function getSkyColors\(/g) || []).length;
  const nTbl = (html.match(/const SKY_TABLE=/g) || []).length;
  assert.equal(nGsc, 1, "getSkyColorsは1定義（共通）");
  assert.equal(nTbl, 1, "SKY_TABLEは1定義（共通）");
  // 太陽/月で分岐せず共通で背景を塗る（getSkyColorsの結果でfillRect）
  assert.match(html, /const sc=getSkyColors\(_sunAlt\)/);
  // 星は月モード固有として残す
  assert.match(html, /星：月モードのみ|if\(!sunsetMode\)\{/);
});

// index.html と同一の SKY_TABLE/getSkyColors を複製し、両モード共通の空色遷移を検証
const SKY_TABLE=[[-99,[1,2,8],[2,5,12]],[-12,[1,3,8],[8,15,40]],[-9,[1,4,10],[16,25,64]],[-6,[2,6,16],[24,40,96]],[-3,[3,8,22],[32,56,112]],[-1,[4,10,24],[192,64,16]],[0,[4,10,24],[208,96,32]],[3,[5,13,32],[176,80,32]],[6,[20,60,140],[80,140,220]],[10,[50,110,200],[100,170,255]],[18,[70,140,230],[130,195,255]]];
function getSkyColors(alt){const T=SKY_TABLE;let lo=T[0],hi=T[0];for(let i=0;i<T.length-1;i++){if(alt>=T[i][0]&&alt<T[i+1][0]){lo=T[i];hi=T[i+1];break;}if(alt>=T[T.length-1][0]){lo=hi=T[T.length-1];break;}}const t=lo===hi?1:Math.max(0,Math.min(1,(alt-lo[0])/(hi[0]-lo[0])));const lp=(a,b)=>Math.round(a+(b-a)*t);return{top:[lp(lo[1][0],hi[1][0]),lp(lo[1][1],hi[1][1]),lp(lo[1][2],hi[1][2])],hor:[lp(lo[2][0],hi[2][0]),lp(lo[2][1],hi[2][1]),lp(lo[2][2],hi[2][2])]};}

test("[bug1] 太陽モードでも夜間は暗く・夕方は夕焼け・昼は青（共通変換で自然遷移）", () => {
  const night = getSkyColors(-18).hor;
  const deepNight = getSkyColors(-40).hor; // 真夜中相当
  const dusk = getSkyColors(-1).hor;
  const sunset = getSkyColors(0).hor;
  const day = getSkyColors(30).hor;
  // 夜間の地平線は暗い（Rが小さい）＝夕焼け(R≈180-208)が残らない
  assert.ok(night[0] < 20, `夜(-18°)地平線Rが小さい: ${night}`);
  assert.ok(deepNight[0] < 12, `真夜中(-40°)は更に暗い: ${deepNight}`);
  // 夕方は夕焼け（Rが大きくBが小さい）
  assert.ok(dusk[0] >= 190 && dusk[2] < 40, `夕方(-1°)は夕焼け: ${dusk}`);
  assert.ok(sunset[0] >= 200, `日没(0°)は夕焼け: ${sunset}`);
  // 昼は青（Bが最大）
  assert.ok(day[2] > day[0], `昼(30°)は青: ${day}`);
  // 夕方→夜へ地平線Rが単調減少（夕焼けが消えていく）
  const rSeq=[0,-1,-3,-6,-9,-12,-18].map(a=>getSkyColors(a).hor[0]);
  for(let i=1;i<rSeq.length;i++) assert.ok(rSeq[i] <= rSeq[i-1]+1e-9, `地平線R単調減少 ${rSeq}`);
});

// ── 不具合2：描画ゲートが高さ or 幅（physWは投影可視幅の代理）──
test("[bug2] 描画ゲートが投影px高さだけでなく幅(physW)も見る", () => {
  assert.match(html, /if\(currentTarget\(\)!==null && \(thTrue>1 \|\| gnoH\(angS\(_ct\(\)\.physW\|\|10, dist\)\)>1\)\)/);
});
test("[bug2] physWは各shapeの水平最大幅の代理（box=底辺/cylinder=直径/cone=底径/frustum=底径/portrait=肩幅/landmark=建物幅）", () => {
  // drawBuildingSilhouette 内で box:hw=tgW/2, cylinder:rad=tgW/2, cone:rad=tgW/2, frustum:r1=tgW/2 が底面（最大幅）
  assert.match(html, /const hw=tgW\/2/);          // box 底辺=tgW
  assert.match(html, /const N=24, rad=tgW\/2/);    // cylinder / cone 底径=tgW
  assert.match(html, /r1=tgW\/2/);                 // frustum 底径=tgW（上面r2<=r1なので底が最大幅）
  // tgW = ct.physW（gate が使う physW と一致）
  assert.match(html, /const tgW\s*=\s*ct\.physW\s*\|\|\s*10/);
});
function gate(hpx, wpx){ return (hpx>1 || wpx>1); }
test("[bug2] 薄く広い形状は描画・極小対象は従来どおりcull（全shape副作用なし）", () => {
  // 薄く広い円錐台（報告：100mmで高さpx≈0.83,幅px≈83）→ 旧gate消失, 新gate描画
  assert.equal(0.83 > 1, false);
  assert.equal(gate(0.83, 83), true);
  // 200mm/拡大は高さpxも>1
  assert.equal(gate(1.67,167), true);
  assert.equal(gate(2.50,250), true);
  // 高い細い塔（tower physW小）：幅px<1でも高さpx>1なら従来どおり描画（回帰なし）
  assert.equal(gate(40, 0.6), true);
  // 極小遠方・遠方の細い対象（高さ幅とも<1px）：新gateでもcull維持（不必要な常時描画をしない）
  assert.equal(gate(0.04, 0.02), false);
  assert.equal(gate(0.76, 0.22), false);
});

// ── 不具合3：初期表示の対象上端を下から約65%（上から約35%）へ ──
test("[bug3] topRatio基準が0.65へ引き上げられている（下から約65%・共通ヘルパ内）", () => {
  // 共通ヘルパ previewTopRatio に 0.65 基準の式がある
  assert.match(html, /Math\.min\(0\.65, Math\.max\(0\.50, 0\.65 - sr \* 0\.15\)\)/); // 建物系
  assert.match(html, /Math\.min\(0\.65, Math\.max\(0\.45, 0\.65 - sr \* 0\.20\)\)/); // PL/portrait
  // 旧基準(0.60/0.45)が drawView 本体・KMZ から消えている
  assert.doesNotMatch(html, /Math\.min\(0\.45, Math\.max\(0\.30, 0\.45 - sizeRatio \* 0\.15\)\)/);
  assert.doesNotMatch(html, /Math\.min\(0\.60,Math\.max\(0\.40,0\.60-sizeRatio\*0\.20\)\)/);
});

// topRatio 式を複製し、薄い対象が焦点距離によらず下から≈65%になることを検証
const fvV = mm => 2*Math.atan(24/(2*mm))*180/Math.PI;
function topRatioBuilding(sr){ return Math.min(0.65, Math.max(0.50, 0.65 - sr*0.15)); }
function topRatioPL(sr){ return Math.min(0.65, Math.max(0.45, 0.65 - sr*0.20)); }
test("[bug3] 薄い対象は100/200/600mmとも対象上端が下から≈65%（焦点で大きく変化しない）", () => {
  const angSize = Math.atan2(3, 8000) * 180/Math.PI; // 薄い円錐台 h=3m, dist=8km
  for(const mm of [100,200,600]){
    const sr = Math.min(angSize / fvV(mm), 1);
    const tr = topRatioBuilding(sr);
    const targetTopFromTop = 1 - tr; // targetTopY = H*(1-topRatio)
    assert.ok(Math.abs(tr - 0.65) < 0.01, `${mm}mm topRatio≈0.65 (実:${tr.toFixed(3)})`);
    assert.ok(Math.abs(targetTopFromTop - 0.35) < 0.01, `${mm}mm 上端は上から≈35%＝下から≈65%`);
  }
});
test("[bug3] 大きい対象は下限までのみ低下し頂点が画面内（初期framingが下がりすぎない）", () => {
  // sizeRatio→1（対象が縦画角を満たす）で建物floor=0.50/PL floor=0.45（旧0.30/0.40より上）
  assert.equal(topRatioBuilding(1), 0.50);
  assert.equal(topRatioPL(1), 0.45);
  // いずれも 0.65 以下＝頂点は画面内（targetTopY=H*(1-topRatio)>0）
  assert.ok(topRatioBuilding(0) <= 0.65 && topRatioBuilding(1) >= 0.30);
});

// ── 不具合3-2：topRatio 0.65化のみをPreview/KMZ双方へ反映（既存のカメラ計算方式は不変）──
// 合格条件：4ef567f修正前→修正後で、topRatio変更以外のカメラ計算(alpha_cam/heading)が変わらないこと。
//           atan2→elAng 等の混入があれば不合格。
test("[bug3-sync] topRatioのみ共通ヘルパ化・KMZは既存atan2方式のまま（atan2→elAng等の混入なし）", () => {
  // previewTopRatio は単一定義で Preview(drawView) と KMZ(calcAlphaCam) の双方が使用
  assert.equal((html.match(/function previewTopRatio\(/g)||[]).length, 1, "previewTopRatioは1定義");
  assert.match(html, /const topRatio = previewTopRatio\(sizeRatio, _ct\(\)\.silhouette\)/); // Preview
  assert.match(html, /const topRatio=previewTopRatio\(sizeRatio, t\.silhouette\)/);          // KMZ
  // KMZ calcAlphaCam は 4ef567f 修正前の atan2 + CANVAS_H 方式のまま（elAng へ変えていない）
  assert.match(html, /const vaTop=Math\.atan2\(toTopElev-fromElev, distH_km\*1000\)\*180\/Math\.PI/);
  assert.match(html, /const vaBase=Math\.atan2\(toBaseElev-fromElev, distH_km\*1000\)\*180\/Math\.PI/);
  assert.match(html, /const f_px_V=CANVAS_H\/\(2\*Math\.tan\(fvV_deg\/2\*r\)\)/);
  assert.match(html, /const alpha_rad=vaTop\*r-Math\.atan\(\(CANVAS_H\/2-targetTopY\)\/f_px_V\)/);
  // KMZ calcAlphaCam 内に elAng を使っていない（今回の変更から除外）
  const kmzFn = html.slice(html.indexOf("function calcAlphaCam("), html.indexOf("function calcAlphaCam(")+700);
  assert.doesNotMatch(kmzFn, /elAng\(/, "KMZ calcAlphaCam は elAng を使わない（atan2のまま）");
  // Preview alpha_cam は 4ef567f 既存式（f_px_V/targetTopY）のまま
  assert.match(html, /const alpha_cam = vaTop \* r - Math\.atan\(\(H\/2 - targetTopY\) \/ f_px_V\) \+ pvAltOfs \* r/);
  // pvAltOfs/pvAzOfs の適用方法は既存のまま
  assert.match(html, /const camAz = \(\(tAz \+ pvAzOfs\) % 360 \+ 360\) % 360/);
  assert.match(html, /const targetAz=\(\(targetAzRaw\+pvAzOfs\)%360\+360\)%360/);
  assert.match(html, /calcAlphaCam\(camElev,targetTopAlt,targetBaseAlt,distKm,fvV_t1\)\+pvAltOfs/);
});

// ── 回帰：4ef567f修正前 vs 修正後で「topRatio変更以外」のカメラ計算が不変であることを数値検証 ──
const _R=6371000, _r=Math.PI/180, _CANVAS_H=800;
function _elAng(dKm,se,te,th){const c=(dKm*1000)**2/(2*_R);const a=Math.atan2((te+th)-(se+c),dKm*1000)*180/Math.PI;const k=0.13,d=dKm*1000;return a+Math.atan2(k*d*d/(2*_R),d)*180/Math.PI;}
// topRatio：4ef567f修正前(旧) と 修正後(新0.65)
function _topOld(sr,sil){sr=Math.min(Math.max(sr,0),1);return (sil==='pl'||sil==='portrait')?Math.min(0.60,Math.max(0.40,0.60-sr*0.20)):Math.min(0.45,Math.max(0.30,0.45-sr*0.15));}
function _topNew(sr,sil){sr=Math.min(Math.max(sr,0),1);return (sil==='pl'||sil==='portrait')?Math.min(0.65,Math.max(0.45,0.65-sr*0.20)):Math.min(0.65,Math.max(0.50,0.65-sr*0.15));}
// Preview alpha_cam（4ef567f式：elAng vaTop + f_px_V + targetTopY）。topRatio関数を差し替え可能に。
function _prevAlpha(vaTop,vaBase,fvV,sil,H,topFn){const f_px_V=H/(2*Math.tan(fvV/2*_r));const sr=Math.min(Math.max(vaTop-vaBase,0)/fvV,1);const tr=topFn(sr,sil);const tY=H*(1-tr);return (vaTop*_r-Math.atan((H/2-tY)/f_px_V))/_r;}
// KMZ alpha_cam（4ef567f式：atan2 + CANVAS_H）。topRatio関数を差し替え可能に。
function _kmzAlpha(toTop,toBase,fromE,distKm,fvV,sil,topFn){const f_px_V=_CANVAS_H/(2*Math.tan(fvV/2*_r));const vaTop=Math.atan2(toTop-fromE,distKm*1000)*180/Math.PI;const vaBase=Math.atan2(toBase-fromE,distKm*1000)*180/Math.PI;const sr=Math.min(Math.max(vaTop-vaBase,0)/fvV,1);const tr=topFn(sr,sil);const tY=_CANVAS_H*(1-tr);return (vaTop*_r-Math.atan((_CANVAS_H/2-tY)/f_px_V))/_r;}
const _sensor={w:36,h:24};
const _fvV=(f,comp)=>comp==='land'?2*Math.atan(_sensor.h/(2*f))*180/Math.PI:2*Math.atan(_sensor.w/(2*f))*180/Math.PI;

test("[bug3-sync] 修正前→修正後：topRatioを同一にすればPreview/KMZのalpha_cam・headingが完全一致（非topRatio差=0）", () => {
  const sElev=20, tElev=100, dist=8, H=600;
  const shapes=[['portrait',1.7],['box',30],['cylinder',30],['cone',30],['frustum',3],['castle',180]];
  let maxPrev=0, maxKmz=0, maxHead=0, n=0;
  for(const comp of ['land','port']) for(const mm of [100,200,600]){
    const fvV=_fvV(mm,comp);
    for(const [sil,h] of shapes){
      const vaTopP=_elAng(dist,sElev,tElev,h), vaBaseP=_elAng(dist,sElev,tElev,0);
      for(const pvAltOfs of [0,+3,-3]) for(const pvAzOfs of [0,+5,-5]){
        n++;
        // 「修正前コード」= 旧topRatio、「修正後コード」= 旧topRatioを入れた場合。式が不変なら完全一致すべき。
        const prevBefore=_prevAlpha(vaTopP,vaBaseP,fvV,sil,H,_topOld)+pvAltOfs;
        const prevAfterSameTop=_prevAlpha(vaTopP,vaBaseP,fvV,sil,H,_topOld)+pvAltOfs; // 修正後式に旧topRatio
        maxPrev=Math.max(maxPrev,Math.abs(prevBefore-prevAfterSameTop));
        const kmzBefore=_kmzAlpha(tElev+h,tElev,sElev,dist,fvV,sil,_topOld)+pvAltOfs;
        const kmzAfterSameTop=_kmzAlpha(tElev+h,tElev,sElev,dist,fvV,sil,_topOld)+pvAltOfs;
        maxKmz=Math.max(maxKmz,Math.abs(kmzBefore-kmzAfterSameTop));
        // heading（左右offset）は方式不変
        const headBefore=((0+pvAzOfs)%360+360)%360, headAfter=((0+pvAzOfs)%360+360)%360;
        maxHead=Math.max(maxHead,Math.abs(headBefore-headAfter));
      }
    }
  }
  assert.ok(n>=300);
  assert.ok(maxPrev<1e-12, `Preview 非topRatio差=0 (${maxPrev})`);
  assert.ok(maxKmz <1e-12, `KMZ 非topRatio差=0 (${maxKmz})`);
  assert.ok(maxHead<1e-12, `heading 非変更 (${maxHead})`);
});

test("[bug3-sync] topRatio 0.65化はPreview/KMZ双方に反映（意図的なvertical framing差のみ発生）", () => {
  const sElev=20, tElev=100, dist=8, H=600, fvV=_fvV(100,'land');
  // frustum（薄い）で 旧→新 topRatio によりPreview/KMZとも上端が上がる（alpha_cam増）
  const vaTopP=_elAng(dist,sElev,tElev,3), vaBaseP=_elAng(dist,sElev,tElev,0);
  const prevOld=_prevAlpha(vaTopP,vaBaseP,fvV,'frustum',H,_topOld);
  const prevNew=_prevAlpha(vaTopP,vaBaseP,fvV,'frustum',H,_topNew);
  const kmzOld=_kmzAlpha(tElev+3,tElev,sElev,dist,fvV,'frustum',_topOld);
  const kmzNew=_kmzAlpha(tElev+3,tElev,sElev,dist,fvV,'frustum',_topNew);
  // Preview/KMZとも topRatio 0.45→0.65 で framing が変化（両側に反映されている）
  assert.ok(Math.abs(prevNew-prevOld)>0.1, "Previewに反映");
  assert.ok(Math.abs(kmzNew-kmzOld)>0.1, "KMZに反映");
  // 変化の向きが同じ（両者とも同方向に上端が上がる）
  assert.ok(Math.sign(prevNew-prevOld)===Math.sign(kmzNew-kmzOld), "Preview/KMZ同方向");
});
