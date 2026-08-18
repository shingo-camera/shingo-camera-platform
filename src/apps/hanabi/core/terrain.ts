/**
 * HANABI 地形遮蔽・稜線計算（サーバ完結・単一 phase）。
 *
 * fetchTerrainProfile / fetchBgRidgeline（client）の独自処理を **サーバ完結**へ移す:
 *   - サンプリング位置の内部生成（client へ返さない＝ plan response 観測性を廃止）
 *   - tile 取得・Terrain-RGB decode（terrain_tiles.ts / png.ts）
 *   - 独自遮蔽（3線 max）・稜線（方位別 max 仰角 elAng＋樹高補正）・富士特例
 *   - 最終結果（profile / ridgeline / fuji / bgRidgeline）だけ client へ返す
 *
 * 最重要（§9）: fetchTerrainProfile / fetchBgRidgeline と同一演算・同一評価順・同一 STEP/nAzimuths で計算し、
 * 同じ elevation 入力に対し同じ profile/ridge/obstruction 結果を返す（結果を変えない）。
 *
 * nAzimuths は現行挙動（preview-canvas 不在で 200 固定）を正本として維持する（§6・今回修正しない）。
 */

import { elAng, hav, brng } from "./hanabi_calc";
import { TerrainElevationProvider } from "./terrain_tiles";

const R_EARTH = 6371000;
const STEP_M = 50;
const FUJI_LAT = 35.3606;
const FUJI_LNG = 138.7274;
const BG_MAX_KM = 20;
// 現行 client では nAzimuths = ceil((preview-canvas?.width || 800) / 4) だが preview-canvas は不在のため
// 常に 200。これを正本として固定（§6）。
const NAZIMUTHS = Math.ceil(800 / 4);

export interface Geo {
  lat: number;
  lng: number;
}

export interface TerrainViewpoint {
  lat: number;
  lng: number;
  elev: number; // viewElev
  tripodH: number; // cm
  elevOffset: number; // m
}

export interface TerrainSolveRequest {
  mode: "front" | "back";
  viewpoint: TerrainViewpoint;
  selectedTube: Geo;
  allTubes: Geo[];
  maxDiaHalf: number; // 前地形 profile の3線オフセット（最大開花半径）
  camAzDeg: number; // カメラ方位（tAz + azOffset を正規化した値）
  fovHDeg: number; // 水平画角（focal/compMode から算出）
  treeHeightM: number;
}

export interface RidgePoint {
  azDeg: number;
  maxVA: number | null;
}
export interface ProfilePoint {
  x: number;
  elev: number;
}

export interface TerrainSolveResult {
  ok: true;
  mode: "front" | "back";
  profile?: ProfilePoint[];
  ridgeline?: RidgePoint[];
  ridgelineFuji?: RidgePoint[] | null;
  bgRidgeline?: RidgePoint[];
}

// 視点からの方位・距離での投影（client と同一式）
function project(vLat: number, vLng: number, azRad: number, xm: number): Geo {
  const lat = vLat + ((xm * Math.cos(azRad)) / R_EARTH) * (180 / Math.PI);
  const lng =
    vLng + (((xm * Math.sin(azRad)) / R_EARTH) * (180 / Math.PI)) / Math.cos((vLat * Math.PI) / 180);
  return { lat, lng };
}

function sElevOf(vp: TerrainViewpoint): number {
  return (vp.elev || 0) + vp.tripodH / 100 + vp.elevOffset;
}

/** 稜線1方位の最大仰角（client の ridge ループと同一：樹高補正・elAng・null skip・評価順）。 */
function ridgeMaxVA(
  provider: TerrainElevationProvider,
  vLat: number,
  vLng: number,
  azRad: number,
  jStart: number,
  jEnd: number,
  totalDistM: number,
  totalSteps: number,
  sElev: number,
  treeHeightM: number,
  applyTree: boolean,
): number | null {
  let maxVA: number | null = null;
  for (let j = jStart; j <= jEnd; j++) {
    const xm = (totalDistM / totalSteps) * j;
    const p = project(vLat, vLng, azRad, xm);
    const e = provider.getElev(p.lat, p.lng);
    if (e === null) continue;
    const eEff = applyTree ? (e > sElev ? e + treeHeightM : e) : e;
    const va = elAng(xm / 1000, sElev, eEff, 0);
    if (maxVA === null || va > maxVA) maxVA = va;
  }
  return maxVA;
}

/** 前地形 solve（profile 3線 + ridgeline + 富士特例）。 */
async function solveFront(
  req: TerrainSolveRequest,
  provider: TerrainElevationProvider,
): Promise<TerrainSolveResult> {
  const { viewpoint: vp, selectedTube, allTubes, maxDiaHalf, camAzDeg, fovHDeg, treeHeightM } = req;
  const vLat = vp.lat;
  const vLng = vp.lng;
  const sElev = sElevOf(vp);

  const distM = hav(vLat, vLng, selectedTube.lat, selectedTube.lng) * 1000;
  const steps = Math.max(2, Math.floor(distM / STEP_M));
  const az = (brng(vLat, vLng, selectedTube.lat, selectedTube.lng) * Math.PI) / 180;
  const perpAz = az + Math.PI / 2;
  const offsets = [0, maxDiaHalf, -maxDiaHalf];

  // ---- 収集フェーズ: 全サンプル座標を求めて tile を prefetch（6 並列・重複排除） ----
  const coords: Geo[] = [];
  const profileCoords: Geo[][] = [];
  for (let i = 0; i <= steps; i++) {
    const xm = (distM / steps) * i;
    const lat0 = vLat + ((xm * Math.cos(az)) / R_EARTH) * (180 / Math.PI);
    const lng0 =
      vLng + (((xm * Math.sin(az)) / R_EARTH) * (180 / Math.PI)) / Math.cos((vLat * Math.PI) / 180);
    const row: Geo[] = [];
    for (const off of offsets) {
      let lat1 = lat0;
      let lng1 = lng0;
      if (off !== 0) {
        lat1 = lat0 + ((off * Math.cos(perpAz)) / R_EARTH) * (180 / Math.PI);
        lng1 =
          lng0 +
          (((off * Math.sin(perpAz)) / R_EARTH) * (180 / Math.PI)) / Math.cos((lat0 * Math.PI) / 180);
      }
      row.push({ lat: lat1, lng: lng1 });
      coords.push({ lat: lat1, lng: lng1 });
    }
    profileCoords.push(row);
  }

  const maxDistM = allTubes.reduce(
    (mx, tb) => Math.max(mx, hav(vLat, vLng, tb.lat, tb.lng) * 1000),
    distM,
  );
  const ridgeSteps = Math.max(2, Math.floor(maxDistM / STEP_M));
  const halfFov = fovHDeg / 2;

  const ridgeAz: number[] = [];
  for (let i = 0; i < NAZIMUTHS; i++) {
    const t2 = i / (NAZIMUTHS - 1);
    ridgeAz.push(camAzDeg - halfFov + t2 * fovHDeg);
  }
  for (const azDeg of ridgeAz) {
    const azRad = (azDeg * Math.PI) / 180;
    for (let j = 1; j <= ridgeSteps; j++) {
      const xm = (maxDistM / ridgeSteps) * j;
      coords.push(project(vLat, vLng, azRad, xm));
    }
  }

  // 富士特例（条件付き）
  const distToFujiKm = hav(vLat, vLng, FUJI_LAT, FUJI_LNG);
  const fujiAzDeg = brng(vLat, vLng, FUJI_LAT, FUJI_LNG);
  const fujiInFov = Math.abs(((fujiAzDeg - camAzDeg + 540) % 360) - 180) <= halfFov;
  const fujiActive = distToFujiKm <= 30 && fujiInFov;
  let fujiDistM = 0;
  let fujiSteps = 0;
  let fujiStartJ = 0;
  if (fujiActive) {
    fujiDistM = (distToFujiKm + 12) * 1000;
    fujiSteps = Math.max(2, Math.floor(fujiDistM / STEP_M));
    fujiStartJ = Math.ceil((maxDistM / fujiDistM) * fujiSteps) + 1;
    for (const azDeg of ridgeAz) {
      const azRad = (azDeg * Math.PI) / 180;
      for (let j = fujiStartJ; j <= fujiSteps; j++) {
        const xm = (fujiDistM / fujiSteps) * j;
        coords.push(project(vLat, vLng, azRad, xm));
      }
    }
  }

  await provider.prefetch(coords);

  // ---- 計算フェーズ（client と同一評価順） ----
  const profile: ProfilePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const xm = (distM / steps) * i;
    let maxElev: number | null = null;
    for (const c of profileCoords[i]) {
      const e = provider.getElev(c.lat, c.lng);
      if (e !== null && (maxElev === null || e > maxElev)) maxElev = e;
    }
    profile.push({ x: xm, elev: maxElev !== null ? maxElev : 0 });
  }

  const ridgeline: RidgePoint[] = [];
  for (const azDeg of ridgeAz) {
    const azRad = (azDeg * Math.PI) / 180;
    const maxVA = ridgeMaxVA(
      provider, vLat, vLng, azRad, 1, ridgeSteps, maxDistM, ridgeSteps, sElev, treeHeightM, true,
    );
    ridgeline.push({ azDeg, maxVA });
  }

  let ridgelineFuji: RidgePoint[] | null = null;
  if (fujiActive) {
    ridgelineFuji = [];
    for (const azDeg of ridgeAz) {
      const azRad = (azDeg * Math.PI) / 180;
      const maxVA = ridgeMaxVA(
        provider, vLat, vLng, azRad, fujiStartJ, fujiSteps, fujiDistM, fujiSteps, sElev, treeHeightM, false,
      );
      ridgelineFuji.push({ azDeg, maxVA });
    }
  }

  return { ok: true, mode: "front", profile, ridgeline, ridgelineFuji };
}

/** 後地形 solve（bgRidgeline: 筒場より奥 20km）。 */
async function solveBack(
  req: TerrainSolveRequest,
  provider: TerrainElevationProvider,
): Promise<TerrainSolveResult> {
  const { viewpoint: vp, selectedTube, camAzDeg, fovHDeg, treeHeightM } = req;
  const vLat = vp.lat;
  const vLng = vp.lng;
  const sElev = sElevOf(vp);

  const distM = hav(vLat, vLng, selectedTube.lat, selectedTube.lng) * 1000;
  const startM = distM;
  const endM = distM + BG_MAX_KM * 1000;
  const steps = Math.max(2, Math.floor((endM - startM) / STEP_M));
  const halfFov = fovHDeg / 2;

  const bgAz: number[] = [];
  for (let i = 0; i < NAZIMUTHS; i++) {
    const t = i / (NAZIMUTHS - 1);
    bgAz.push(camAzDeg - halfFov + t * fovHDeg);
  }

  const coords: Geo[] = [];
  for (const azDeg of bgAz) {
    const azRad = (azDeg * Math.PI) / 180;
    for (let j = 0; j <= steps; j++) {
      const xm = startM + STEP_M * j;
      coords.push(project(vLat, vLng, azRad, xm));
    }
  }
  await provider.prefetch(coords);

  const bgRidgeline: RidgePoint[] = [];
  for (const azDeg of bgAz) {
    const azRad = (azDeg * Math.PI) / 180;
    let maxVA: number | null = null;
    for (let j = 0; j <= steps; j++) {
      const xm = startM + STEP_M * j;
      const p = project(vLat, vLng, azRad, xm);
      const e = provider.getElev(p.lat, p.lng);
      if (e === null) continue;
      const eEff = e > sElev ? e + treeHeightM : e;
      const va = elAng(xm / 1000, sElev, eEff, 0);
      if (maxVA === null || va > maxVA) maxVA = va;
    }
    bgRidgeline.push({ azDeg, maxVA });
  }

  return { ok: true, mode: "back", bgRidgeline };
}

export async function solveTerrain(
  req: TerrainSolveRequest,
  provider: TerrainElevationProvider,
): Promise<TerrainSolveResult> {
  return req.mode === "back" ? solveBack(req, provider) : solveFront(req, provider);
}

export { NAZIMUTHS, STEP_M, BG_MAX_KM };
