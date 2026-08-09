// ============================================================
// functions/api/_geo.js
// 都道府県判定の共通モジュール（サーバ側）。
// PREF_CODES / GeoJSON読込(メモリ+Cacheキャッシュ) / Point-in-Polygon
// (Polygon・MultiPolygon) / 最近傍県補佐 / distanceM(ハーサイン) を集約。
// japan_pref.geojson（既存R2公開URL）を参照する。判定ロジックはアプリ固有
// データ（HANABI/Portrait）を一切参照しない純粋な緯度経度処理。
// HANABIのクライアント実装(PREF_CODES/pointInPolygon/最近傍)を移植。
// ============================================================

// 都道府県名 → JISコード(1..47)。表示側の県コード導出もこの表を基準にする。
export const PREF_CODES = {
  '北海道':1,'青森県':2,'岩手県':3,'宮城県':4,'秋田県':5,
  '山形県':6,'福島県':7,'茨城県':8,'栃木県':9,'群馬県':10,
  '埼玉県':11,'千葉県':12,'東京都':13,'神奈川県':14,'新潟県':15,
  '富山県':16,'石川県':17,'福井県':18,'山梨県':19,'長野県':20,
  '岐阜県':21,'静岡県':22,'愛知県':23,'三重県':24,'滋賀県':25,
  '京都府':26,'大阪府':27,'兵庫県':28,'奈良県':29,'和歌山県':30,
  '鳥取県':31,'島根県':32,'岡山県':33,'広島県':34,'山口県':35,
  '徳島県':36,'香川県':37,'愛媛県':38,'高知県':39,'福岡県':40,
  '佐賀県':41,'長崎県':42,'熊本県':43,'大分県':44,'宮崎県':45,
  '鹿児島県':46,'沖縄県':47
};

// 既存R2公開URL（HANABIと同一オブジェクトを再利用。移動・複製はしない）。
export const PREF_GEOJSON_URL = 'https://pub-1ed8bf2d0ae64e1bb8602c7a30e60b5a.r2.dev/japan_pref.geojson';

// isolate内メモリキャッシュ。{name, geometry}[]。同一isolateでは再fetchしない。
let _features = null;

// GeoJSONを読み込み、[{name, geometry}] に正規化して返す。
// メモリ→Cache API→originfetch の順。Cache API利用時は clone() で本文の
// 二重消費を避ける。取得/解析不能時は例外を投げる（呼び元で500へ）。
export async function loadGeoJSON(){
  if(_features) return _features;

  let text = null;
  let cache = null;
  try { cache = (typeof caches !== 'undefined') ? caches.default : null; } catch(e){ cache = null; }
  const cacheKey = PREF_GEOJSON_URL;

  if(cache){
    try {
      const hit = await cache.match(cacheKey);
      if(hit){
        text = await hit.text();
      }
    } catch(e){ /* Cache参照失敗は無視してfetchへ */ }
  }

  if(text == null){
    const res = await fetch(PREF_GEOJSON_URL);
    if(!res || !res.ok) throw new Error('geojson fetch failed: status ' + (res && res.status));
    // 先にcacheへ複製を書き、本文は元Responseから読む（clone()で二重消費回避）。
    if(cache){
      try { await cache.put(cacheKey, res.clone()); } catch(e){ /* cache書込失敗は無視 */ }
    }
    text = await res.text();
  }

  let data;
  try { data = JSON.parse(text); }
  catch(e){ throw new Error('geojson parse failed'); }

  const feats = (data && Array.isArray(data.features)) ? data.features : [];
  _features = feats
    .map(f => ({ name: f && f.properties ? f.properties.name : null, geometry: f ? f.geometry : null }))
    .filter(f => f.name && f.geometry);
  return _features;
}

// Point-in-Polygon（Ray casting）。GeoJSON座標は [lng, lat] 並び。
// Polygon / MultiPolygon に対応。外側リング(coordinates[0] / poly[0])のみ判定
// （穴は無視＝HANABI互換）。未対応geometry(GeometryCollection等)はfalse。
export function pointInPolygon(lat, lng, geometry){
  if(!geometry) return false;
  function ringContains(coords){
    if(!Array.isArray(coords)) return false;
    let inside = false;
    let j = coords.length - 1;
    for(let i = 0; i < coords.length; i++){
      const xi = coords[i][0], yi = coords[i][1]; // x=lng, y=lat
      const xj = coords[j][0], yj = coords[j][1];
      if(((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      j = i;
    }
    return inside;
  }
  if(geometry.type === 'Polygon'){
    return ringContains(geometry.coordinates[0]);
  } else if(geometry.type === 'MultiPolygon'){
    for(const poly of geometry.coordinates){
      if(ringContains(poly[0])) return true;
    }
    return false;
  }
  return false; // 未対応geometryは安全にスキップ
}

// 2点間の距離(m)。ハーサイン式（度差をそのままmにしない）。
export function haversineM(lat1, lng1, lat2, lng2){
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*r) * Math.cos(lat2*r) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 全県の境界頂点を走査し最寄り県を決定。比較は度の2乗距離（高速・HANABI互換）、
// distanceMは勝者頂点に対してハーサインでm換算。距離上限は設けない（無制限）。
function nearestPref(lat, lng, features){
  let minSq = Infinity, name = '不明', vLat = null, vLng = null;
  for(const f of features){
    const g = f.geometry;
    let rings = null;
    if(g.type === 'Polygon') rings = g.coordinates;               // [ring][pt][2]
    else if(g.type === 'MultiPolygon') rings = g.coordinates.flat(1); // [ring][pt][2]
    else continue; // 未対応geometryはスキップ
    for(const ring of rings){
      if(!Array.isArray(ring)) continue;
      for(const c of ring){
        const d = (lat - c[1])**2 + (lng - c[0])**2;
        if(d < minSq){ minSq = d; name = f.name; vLat = c[1]; vLng = c[0]; }
      }
    }
  }
  const distanceM = (vLat == null) ? null : Math.round(haversineM(lat, lng, vLat, vLng));
  return { name, distanceM };
}

// 公開関数：緯度経度 → {prefecture, prefectureCode, source, distanceM}
//   source='polygon'（内包）: distanceM=0
//   source='nearest'（海上・境界外）: distanceM>0
// GeoJSONが空/取得不能なら例外（呼び元で500 'geojson unavailable'）。
export async function getPrefectureInfo(lat, lng){
  const features = await loadGeoJSON();
  if(!features.length) throw new Error('geojson empty');

  for(const f of features){
    if(pointInPolygon(lat, lng, f.geometry)){
      return { prefecture: f.name, prefectureCode: PREF_CODES[f.name] || 99, source: 'polygon', distanceM: 0 };
    }
  }
  const near = nearestPref(lat, lng, features);
  return { prefecture: near.name, prefectureCode: PREF_CODES[near.name] || 99, source: 'nearest', distanceM: near.distanceM };
}
