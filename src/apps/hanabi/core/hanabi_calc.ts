/**
 * HANABI 中核計算モジュール（サーバ専有・独自係数/独自補正式）
 *
 * このファイルは HANABI の商品価値を構成する独自計算だけを持つ。
 * public asset（client）には配布しない。scene-solve / terrain-solve / earth-kml から呼ぶ。
 *
 * 方針: elAng / 号数 seed（riseTime/windFollowRatio）/ hav / brng 等は元 client 実装と**同一の演算**
 *   （式・定数・評価順・丸めなし）で旧仕様互換を維持する。
 *   - calcWindOffset（旧 viewpoint-relative 風式）は characterization / 履歴互換用に保持する。
 *     現行 scene の風による位置決定の正本は **windDriftWorld**（world-fixed 仕様）であり、
 *     風あり normal burst / renderSim kunitomo はこちらを使う（HANABI_WIND_WORLD_FIXED_MIGRATION_REPORT）。
 *   - client 側の該当実行コードは除去し、本モジュールをサーバでのみ実行する。
 *   - characterization test が、元 index.html から抽出した実装と本モジュールの出力一致を検証する
 *     （calcWindOffset 等の旧式は差 0、風位置決定は world-fixed 仕様として world invariance を固定）。
 *
 * 独自定数（client から除去し、ここへ集約）:
 *   - 大気屈折係数 k = 0.13（地上物 terrestrial refraction）
 *   - 地上→上空 風速換算 WIND_ALT_FACTOR = 10/7
 *   - DEFAULT_NUM_TABLE の riseTime / windFollowRatio（空気抵抗 Cd=0.44・逆算密度~620kg/m3 由来）
 */

// ---- 独自定数（非公開） ----
const K_TERRESTRIAL_REFRACTION = 0.13;
const WIND_ALT_FACTOR = 10 / 7;
const EARTH_R_M = 6371000;

/**
 * DEFAULT 号数テーブル seed（独自係数）。
 * height/dia は花火諸元（公開情報）だが、riseTime/windFollowRatio は「ユーザーに見せない内部パラメータ」。
 * client には配布せず、未保存初期状態のシーン計算に用いる（結果値のみ返す）。
 */
export const NUM_TABLE_SEED = [
  { num: "2.5", height: 90, dia: 50, riseTime: 4.29, windFollowRatio: 0.78 },
  { num: "3", height: 132, dia: 60, riseTime: 5.19, windFollowRatio: 0.85 },
  { num: "4", height: 186, dia: 130, riseTime: 6.16, windFollowRatio: 0.86 },
  { num: "5", height: 224, dia: 170, riseTime: 6.76, windFollowRatio: 0.85 },
  { num: "6", height: 264, dia: 220, riseTime: 7.34, windFollowRatio: 0.85 },
  { num: "7", height: 298, dia: 240, riseTime: 7.8, windFollowRatio: 0.84 },
  { num: "8", height: 336, dia: 280, riseTime: 8.28, windFollowRatio: 0.83 },
  { num: "10", height: 394, dia: 320, riseTime: 8.97, windFollowRatio: 0.81 },
  { num: "20", height: 548, dia: 480, riseTime: 10.58, windFollowRatio: 0.69 },
  { num: "30", height: 655, dia: 550, riseTime: 11.56, windFollowRatio: 0.61 },
  { num: "40", height: 798, dia: 725, riseTime: 12.76, windFollowRatio: 0.57 },
];

/** 号数の内部パラメータ（riseTime/windFollowRatio）を seed から解決する（非公開）。 */
export function seedNumMeta(num: string): { riseTime: number; windFollowRatio: number } | null {
  const row = NUM_TABLE_SEED.find((r) => r.num === num);
  return row ? { riseTime: row.riseTime, windFollowRatio: row.windFollowRatio } : null;
}

/**
 * 仰角計算（HANABI 独自: 地球曲率 + 地上物大気屈折 k=0.13）。
 * 元 client 実装（index.html: function elAng(dKm,se,te,th)）と同一演算。
 *
 * @param dKm 水平距離[km]
 * @param se  視点標高[m]（地面+三脚+オフセット）
 * @param te  対象基準標高[m]
 * @param th  対象の高さ[m]（te からの相対）
 * @returns 仰角[度]
 */
export function elAng(dKm: number, se: number, te: number, th: number): number {
  const R = EARTH_R_M,
    k = K_TERRESTRIAL_REFRACTION;
  const d = dKm * 1000;
  const curv = d ** 2 / (2 * R);
  const altRaw = (Math.atan2(te + th - (se + curv), d) * 180) / Math.PI;
  const terrRefr = (Math.atan2((k * d * d) / (2 * R), d) * 180) / Math.PI;
  return altRaw + terrRefr;
}

export interface WindState {
  dirDeg: number;
  speed: number;
}
export interface WindOffset {
  azOffsetDeg: number;
  distOffsetKm: number;
}

/**
 * 風ドリフト物理（HANABI 独自: WIND_ALT_FACTOR=10/7・号数別 followRatio・視線分解）。
 * 元 client 実装（index.html: function calcWindOffset）と同一演算。
 * 元実装のグローバル windEffectState は引数 wind として渡す（null で無風）。
 *
 * @param viewAzDeg 視線方位[度]
 * @param distKm    視点→筒場 距離[km]
 * @param riseTime  号数別 上昇時間[s]
 * @param followRatio 号数別 風追従率（undefined で 0.8）
 * @param wind      風状態 {dirDeg,speed} または null（無風）
 */
export function calcWindOffset(
  viewAzDeg: number,
  distKm: number,
  riseTime: number,
  followRatio: number | undefined,
  wind: WindState | null,
): WindOffset {
  if (!wind) return { azOffsetDeg: 0, distOffsetKm: 0 };
  const { dirDeg, speed } = wind;
  const altWind = speed * WIND_ALT_FACTOR;
  const fr = followRatio === undefined ? 0.8 : followRatio;
  const driftM = altWind * fr * riseTime;

  const blowToDeg = (dirDeg + 180) % 360;
  const relDeg = ((blowToDeg - viewAzDeg + 540) % 360) - 180;
  const relRad = (relDeg * Math.PI) / 180;

  const lateralM = driftM * Math.sin(relRad);
  const depthM = driftM * Math.cos(relRad);

  const distM = distKm * 1000;
  const azOffsetDeg = (Math.atan2(lateralM, distM) * 180) / Math.PI;
  const distOffsetKm = depthM / 1000;

  return { azOffsetDeg, distOffsetKm };
}

/** world-fixed 風ドリフト（driftM[m] と流される world 方位 blowToDeg[deg]）。 */
export interface WindDriftWorld {
  driftM: number;
  blowToDeg: number;
}

/**
 * world-fixed 風ドリフト物理。viewpoint を入力にしない（HANABI world-fixed 仕様の正本）。
 * driftM は calcWindOffset と同一式（WIND_ALT_FACTOR=10/7・号数別 followRatio・riseTime）。
 * blowToDeg は玉が流される world 方位（= dirDeg+180、既存定義と同一）。
 * 呼び出し側は destPoint(originLat, originLng, blowToDeg, driftM/1000) で world 位置を確定する。
 */
export function windDriftWorld(
  riseTime: number,
  followRatio: number | undefined,
  wind: WindState | null,
): WindDriftWorld {
  if (!wind) return { driftM: 0, blowToDeg: 0 };
  const altWind = wind.speed * WIND_ALT_FACTOR;
  const fr = followRatio === undefined ? 0.8 : followRatio;
  const driftM = altWind * fr * riseTime;
  const blowToDeg = (wind.dirDeg + 180) % 360;
  return { driftM, blowToDeg };
}

// ---- 表示用幾何（教科書的・client にも存在するが、サーバ内部でも同じ値を使うため保持） ----
// 元 client 実装 hav / brng / azDiff と同一演算（結果一致のため同じ式で計算する）。

/** 球面距離[km]（haversine）。元 index.html: function hav(a,b,c,d)。 */
export function hav(a: number, b: number, c: number, d: number): number {
  const R = 6371,
    r = Math.PI / 180;
  const dA = (c - a) * r,
    dB = (d - b) * r;
  const x =
    Math.sin(dA / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dB / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** 方位角[度]。元 index.html: function brng(a,b,c,d)。 */
export function brng(a: number, b: number, c: number, d: number): number {
  const r = Math.PI / 180,
    dl = (d - b) * r;
  const y = Math.sin(dl) * Math.cos(c * r);
  const x = Math.cos(a * r) * Math.sin(c * r) - Math.sin(a * r) * Math.cos(c * r) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 方位差（-180..+180）。元 index.html: function azDiff(a,b)。 */
export function azDiff(a: number, b: number): number {
  let d = ((b - a) + 360) % 360;
  return d > 180 ? d - 360 : d;
}
