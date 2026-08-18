/**
 * HANABI 計算 API の入力検証（Production Worker の CPU/メモリ保護）。
 *
 * 認証済みユーザーでも client 入力を無制限に信用しない。
 * - 数値は有限（NaN/Infinity 不可）
 * - 緯度 -90..90 / 経度 -180..180
 * - 配列長・nAzimuths・距離・各種数値に、通常利用を妨げない余裕を持った上限
 * - 文字列長の合理的上限
 * 不正値は ValidationError（呼出側で 400 BAD_REQUEST・fail-closed）。
 *
 * 上限は現行 HANABI（public/apps/hanabi/index.html）の入力レンジから、通常利用に十分な余裕で設定:
 *   focal 9..1200 / az,el offset -60..60 / tripodH 0..500cm / target height 1..2000 /
 *   width,depth 1..5000 / topWidth 0..5000 / treeHeight 0..30 / numTable height,dia 1..2000。
 * 件数・距離・分割数は現実的な最大に安全マージンを掛けた保護上限（正確な業務値ではなく DoS 防止）。
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ---- 保護上限（通常利用を妨げない余裕を持たせた DoS 防止値） ----
export const LIMITS = {
  STR_MAX: 200, // id 等の文字列長上限
  NUMS_PER_TUBE: 64, // 1筒場あたり号数件数（実際は号数表の件数=十数）
  TUBES: 2000, // 1大会の筒場件数
  TARGETS: 5000, // 対象件数
  NUMTABLE: 500, // 号数表件数（実際は十数）
  SUBTARGETS: 16, // サブ対象件数（UI 上は 2）
  ALL_TUBES: 2000, // terrain allTubes 件数
  N_AZIMUTHS: 4096, // 稜線方位分割（canvasWidth/4 相当。大画面でも十分な上限）
  PROFILE_ROWS: 20000, // 断面プロファイル行数（distM/50 相当。長距離でも保護）
  RIDGE_ROWS: 4096, // 稜線方位行数（= nAzimuths と同オーダー）
  RIDGE_POINTS: 20000, // 1方位あたりステップ数（maxDistM/50 相当）
  FUJI_ROWS: 4096,
  DIST_M_MAX: 500000, // 距離上限[m]（500km。富士特例含め十分）
  PROFILE_STEPS_MAX: 20000,
  // 数値の合理レンジ（余裕込み）
  FOCAL: [1, 5000] as const,
  OFFSET_DEG: [-360, 360] as const, // az/el offset（UI は ±60。余裕を持たせる）
  TRIPOD_CM: [0, 100000] as const, // cm（UI は 0..500。異常巨大値のみ弾く）
  ELEV_M: [-1000, 100000] as const, // 標高・オフセット[m]
  HEIGHT_M: [0, 100000] as const, // 対象・花火高さ[m]
  DIA_M: [0, 100000] as const, // 開花径[m]
  SENSOR_MM: [1, 1000] as const,
  TREE_M: [0, 10000] as const,
  SPEED: [0, 1000] as const, // 風速
} as const;

export function assertFiniteNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(`${name} は有限の数値である必要があります。`);
  }
  return v;
}

export function assertInRange(v: unknown, name: string, min: number, max: number): number {
  const n = assertFiniteNumber(v, name);
  if (n < min || n > max) {
    throw new ValidationError(`${name} は ${min}〜${max} の範囲である必要があります。`);
  }
  return n;
}

export function assertLat(v: unknown, name = "latitude"): number {
  return assertInRange(v, name, -90, 90);
}
export function assertLng(v: unknown, name = "longitude"): number {
  return assertInRange(v, name, -180, 180);
}

/** 省略可能な数値。undefined/null は許容（既定は呼出側）。値がある場合は有限性を検証。 */
export function assertOptionalNumber(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  return assertFiniteNumber(v, name);
}

export function assertOptionalInRange(
  v: unknown,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (v === undefined || v === null) return undefined;
  return assertInRange(v, name, min, max);
}

export function assertString(v: unknown, name: string, maxLen = LIMITS.STR_MAX): string {
  if (typeof v !== "string") throw new ValidationError(`${name} は文字列である必要があります。`);
  if (v.length > maxLen) throw new ValidationError(`${name} が長すぎます（最大 ${maxLen} 文字）。`);
  return v;
}

export function assertArrayMax<T>(v: unknown, name: string, max: number): T[] {
  if (!Array.isArray(v)) throw new ValidationError(`${name} は配列である必要があります。`);
  if (v.length > max) throw new ValidationError(`${name} の件数が上限（${max}）を超えています。`);
  return v as T[];
}

export function assertIntInRange(v: unknown, name: string, min: number, max: number): number {
  const n = assertFiniteNumber(v, name);
  if (!Number.isInteger(n)) throw new ValidationError(`${name} は整数である必要があります。`);
  if (n < min || n > max) {
    throw new ValidationError(`${name} は ${min}〜${max} の整数である必要があります。`);
  }
  return n;
}

// ==================== scene-solve 検証 ====================
import type { SceneSolveRequest } from "./scene";
import type { WindState } from "./hanabi_calc";
import type { TerrainSolveRequest } from "./terrain";

function validateWind(w: unknown): WindState | null {
  if (w === null || w === undefined) return null;
  if (typeof w !== "object") throw new ValidationError("wind の形式が不正です。");
  const o = w as Record<string, unknown>;
  return {
    dirDeg: assertInRange(o.dirDeg, "wind.dirDeg", -360, 360),
    speed: assertInRange(o.speed, "wind.speed", LIMITS.SPEED[0], LIMITS.SPEED[1]),
  };
}

/** scene-solve リクエストを検証（不正なら ValidationError を投げる）。正常系はそのまま返す。 */
export function validateSceneRequest(body: unknown): SceneSolveRequest {
  if (!body || typeof body !== "object") throw new ValidationError("リクエスト本文が不正です。");
  const b = body as Record<string, unknown>;

  // viewpoint
  const vp = b.viewpoint as Record<string, unknown> | undefined;
  if (!vp || typeof vp !== "object") throw new ValidationError("viewpoint が必要です。");
  if (typeof vp.manual !== "boolean") throw new ValidationError("viewpoint.manual は真偽値です。");
  const viewpoint = {
    manual: vp.manual as boolean,
    lat: vp.lat === null || vp.lat === undefined ? (vp.lat as null | undefined) : assertLat(vp.lat, "viewpoint.lat"),
    lng: vp.lng === null || vp.lng === undefined ? (vp.lng as null | undefined) : assertLng(vp.lng, "viewpoint.lng"),
    elev: assertOptionalInRange(vp.elev, "viewpoint.elev", LIMITS.ELEV_M[0], LIMITS.ELEV_M[1]) ?? 0,
    tripodH: assertInRange(vp.tripodH, "viewpoint.tripodH", LIMITS.TRIPOD_CM[0], LIMITS.TRIPOD_CM[1]),
    elevOffset: assertInRange(vp.elevOffset, "viewpoint.elevOffset", LIMITS.ELEV_M[0], LIMITS.ELEV_M[1]),
  };
  if (viewpoint.manual && (viewpoint.lat === null || viewpoint.lat === undefined || viewpoint.lng === null || viewpoint.lng === undefined)) {
    throw new ValidationError("manual 視点には lat/lng が必要です。");
  }

  // camera
  const cam = b.camera as Record<string, unknown> | undefined;
  if (!cam || typeof cam !== "object") throw new ValidationError("camera が必要です。");
  const sensor = cam.sensor as Record<string, unknown> | undefined;
  if (!sensor || typeof sensor !== "object") throw new ValidationError("camera.sensor が必要です。");
  if (cam.compMode !== "land" && cam.compMode !== "port") {
    throw new ValidationError("camera.compMode は land/port です。");
  }
  const camera = {
    focal: assertInRange(cam.focal, "camera.focal", LIMITS.FOCAL[0], LIMITS.FOCAL[1]),
    sensor: {
      w: assertInRange(sensor.w, "camera.sensor.w", LIMITS.SENSOR_MM[0], LIMITS.SENSOR_MM[1]),
      h: assertInRange(sensor.h, "camera.sensor.h", LIMITS.SENSOR_MM[0], LIMITS.SENSOR_MM[1]),
    },
    compMode: cam.compMode as "land" | "port",
    azOffset: assertInRange(cam.azOffset, "camera.azOffset", LIMITS.OFFSET_DEG[0], LIMITS.OFFSET_DEG[1]),
    elOffset: assertInRange(cam.elOffset, "camera.elOffset", LIMITS.OFFSET_DEG[0], LIMITS.OFFSET_DEG[1]),
  };

  // festivalTubes
  const rawTubes = assertArrayMax<Record<string, unknown>>(b.festivalTubes, "festivalTubes", LIMITS.TUBES);
  const festivalTubes = rawTubes.map((t, i) => {
    if (!t || typeof t !== "object") throw new ValidationError(`festivalTubes[${i}] が不正です。`);
    const nums = assertArrayMax<unknown>(t.nums, `festivalTubes[${i}].nums`, LIMITS.NUMS_PER_TUBE).map(
      (n, j) => assertString(n, `festivalTubes[${i}].nums[${j}]`),
    );
    // kunitomoNums（号数→方向数）。件数は号数件数の上限に準じる。値は有限数。
    let kunitomoNums: Record<string, number> | undefined;
    if (t.kunitomoNums !== undefined && t.kunitomoNums !== null) {
      if (typeof t.kunitomoNums !== "object") {
        throw new ValidationError(`festivalTubes[${i}].kunitomoNums が不正です。`);
      }
      const entries = Object.entries(t.kunitomoNums as Record<string, unknown>);
      if (entries.length > LIMITS.NUMS_PER_TUBE) {
        throw new ValidationError(`festivalTubes[${i}].kunitomoNums の件数が上限を超えています。`);
      }
      kunitomoNums = {};
      for (const [k, v] of entries) {
        assertString(k, `festivalTubes[${i}].kunitomoNums key`);
        kunitomoNums[k] = assertIntInRange(v, `festivalTubes[${i}].kunitomoNums[${k}]`, 0, 100);
      }
    }
    return {
      id: assertString(t.id, `festivalTubes[${i}].id`),
      lat: assertLat(t.lat, `festivalTubes[${i}].lat`),
      lng: assertLng(t.lng, `festivalTubes[${i}].lng`),
      elev: assertOptionalInRange(t.elev, `festivalTubes[${i}].elev`, LIMITS.ELEV_M[0], LIMITS.ELEV_M[1]),
      elevOffset: assertOptionalInRange(t.elevOffset, `festivalTubes[${i}].elevOffset`, LIMITS.ELEV_M[0], LIMITS.ELEV_M[1]),
      enabled: t.enabled === undefined ? undefined : Boolean(t.enabled),
      nums,
      ougi: t.ougi === undefined ? undefined : Boolean(t.ougi),
      ougiAz: assertOptionalInRange(t.ougiAz, `festivalTubes[${i}].ougiAz`, -1000, 1000),
      kunitomoNums,
    };
  });

  // targets
  const rawTargets = assertArrayMax<Record<string, unknown>>(b.targets ?? [], "targets", LIMITS.TARGETS);
  const targets = rawTargets.map((t, i) => {
    if (!t || typeof t !== "object") throw new ValidationError(`targets[${i}] が不正です。`);
    return {
      id: assertString(t.id, `targets[${i}].id`),
      lat: assertLat(t.lat, `targets[${i}].lat`),
      lng: assertLng(t.lng, `targets[${i}].lng`),
      elev: assertOptionalInRange(t.elev, `targets[${i}].elev`, LIMITS.ELEV_M[0], LIMITS.ELEV_M[1]),
      baseOffset: assertOptionalInRange(t.baseOffset, `targets[${i}].baseOffset`, LIMITS.ELEV_M[0], LIMITS.ELEV_M[1]),
      height: assertInRange(t.height, `targets[${i}].height`, LIMITS.HEIGHT_M[0], LIMITS.HEIGHT_M[1]),
    };
  });

  // numTable
  const rawNum = assertArrayMax<Record<string, unknown>>(b.numTable, "numTable", LIMITS.NUMTABLE);
  const numTable = rawNum.map((r, i) => {
    if (!r || typeof r !== "object") throw new ValidationError(`numTable[${i}] が不正です。`);
    return {
      num: assertString(r.num, `numTable[${i}].num`),
      height: assertInRange(r.height, `numTable[${i}].height`, LIMITS.HEIGHT_M[0], LIMITS.HEIGHT_M[1]),
      dia: assertInRange(r.dia, `numTable[${i}].dia`, LIMITS.DIA_M[0], LIMITS.DIA_M[1]),
      riseTime: assertOptionalInRange(r.riseTime, `numTable[${i}].riseTime`, 0, 3600),
      windFollowRatio: assertOptionalInRange(r.windFollowRatio, `numTable[${i}].windFollowRatio`, 0, 1),
    };
  });

  const selectedTubeId = assertString(b.selectedTubeId, "selectedTubeId");
  const targetId =
    b.targetId === null || b.targetId === undefined ? null : assertString(b.targetId, "targetId");
  const subTargetIds = assertArrayMax<unknown>(b.subTargetIds ?? [], "subTargetIds", LIMITS.SUBTARGETS).map(
    (s, i) => assertString(s, `subTargetIds[${i}]`),
  );
  const wind = validateWind(b.wind);
  const ougiHeight = assertOptionalInRange(b.ougiHeight, "ougiHeight", 0, LIMITS.HEIGHT_M[1]);

  return {
    viewpoint,
    camera,
    festivalTubes,
    targets,
    numTable,
    selectedTubeId,
    targetId,
    subTargetIds,
    wind,
    ougiHeight,
  };
}

// ==================== terrain-solve 検証（単一 phase・サーバ完結） ====================
// client は sample 数・nAzimuths・STEP を指定しない（サーバがアルゴリズムから決定）。
// ループ量を左右する値（allTubes 件数・視点↔筒場/最遠筒場の距離・focal 由来の fovH）に上限を課す。
function validateGeo(o: unknown, name: string): { lat: number; lng: number } {
  if (!o || typeof o !== "object") throw new ValidationError(`${name} が不正です。`);
  const g = o as Record<string, unknown>;
  return { lat: assertLat(g.lat, `${name}.lat`), lng: assertLng(g.lng, `${name}.lng`) };
}

export function validateTerrainSolve(body: unknown): TerrainSolveRequest {
  if (!body || typeof body !== "object") throw new ValidationError("リクエスト本文が不正です。");
  const b = body as Record<string, unknown>;

  const mode = b.mode === "back" ? "back" : b.mode === "front" ? "front" : null;
  if (!mode) throw new ValidationError("mode は front または back を指定してください。");

  const vp = b.viewpoint as Record<string, unknown> | undefined;
  if (!vp || typeof vp !== "object") throw new ValidationError("viewpoint が必要です。");
  const viewpoint = {
    lat: assertLat(vp.lat, "viewpoint.lat"),
    lng: assertLng(vp.lng, "viewpoint.lng"),
    elev: assertOptionalInRange(vp.elev, "viewpoint.elev", LIMITS.ELEV_M[0], LIMITS.ELEV_M[1]) ?? 0,
    tripodH: assertInRange(vp.tripodH, "viewpoint.tripodH", LIMITS.TRIPOD_CM[0], LIMITS.TRIPOD_CM[1]),
    elevOffset: assertInRange(vp.elevOffset, "viewpoint.elevOffset", LIMITS.ELEV_M[0], LIMITS.ELEV_M[1]),
  };

  const selectedTube = validateGeo(b.selectedTube, "selectedTube");
  const rawAll = assertArrayMax<unknown>(b.allTubes ?? [], "allTubes", LIMITS.ALL_TUBES);
  const allTubes = rawAll.map((t, i) => validateGeo(t, `allTubes[${i}]`));

  const maxDiaHalf = assertInRange(b.maxDiaHalf, "maxDiaHalf", 0, LIMITS.DIA_M[1]);
  const camAzDeg = assertInRange(b.camAzDeg, "camAzDeg", -1000, 1000);
  const fovHDeg = assertInRange(b.fovHDeg, "fovHDeg", 0, 360);
  const treeHeightM = assertInRange(b.treeHeightM, "treeHeightM", LIMITS.TREE_M[0], LIMITS.TREE_M[1]);

  // ループ量保護: 視点↔選択筒場・視点↔各筒場の距離が過大でないこと（distM 上限）。
  // 実距離はサーバで hav 計算するが、極端な緯度経度差での暴走を防ぐため、ここで粗く上限判定する。
  const roughKm = (a: { lat: number; lng: number }, c: { lat: number; lng: number }) => {
    const dLat = (c.lat - a.lat) * 111;
    const dLng = (c.lng - a.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  };
  const maxKm = LIMITS.DIST_M_MAX / 1000;
  if (roughKm(viewpoint, selectedTube) > maxKm) {
    throw new ValidationError("視点↔選択筒場の距離が上限を超えています。");
  }
  for (let i = 0; i < allTubes.length; i++) {
    if (roughKm(viewpoint, allTubes[i]) > maxKm) {
      throw new ValidationError(`視点↔allTubes[${i}] の距離が上限を超えています。`);
    }
  }

  return { mode, viewpoint, selectedTube, allTubes, maxDiaHalf, camAzDeg, fovHDeg, treeHeightM };
}
