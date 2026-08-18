/**
 * HANABI シーン解計算（サーバ・独自式適用）。
 *
 * renderSim（client 描画関数）の「答えを計算する部分」だけをサーバへ移したもの。
 * 描画（Canvas）は client に残す。ここでは独自の elAng（曲率+屈折）/ 風物理（windDriftWorld）/
 * 号数内部パラメータ（riseTime/windFollowRatio）を適用し、**適用済みの結果値**（角度・距離）だけを返す。
 *
 * 方針: 原則として既存 HANABI の計算を維持する（elAng・号数 seed・無風位置・ougi・KML kmlKunitomo 等は
 * 旧仕様互換を維持）。ただし**風による位置決定のみ**、明示的な仕様判断により world-fixed 仕様を正本とする
 * （風あり normal burst / renderSim kunitomo）。world-fixed 仕様は HANABI_WIND_WORLD_FIXED_MIGRATION_REPORT
 * で確定: wind physics → fixed world position（tube/ground burst から blowToDeg 方向へ driftM 移動）→
 * viewpoint projection。同一花火は観測地点に依存せず同一 world 位置になる。
 * 旧 viewpoint-relative 方式（calcWindOffset）との差は impact report に記録済み。
 * client は返却値を toX/toY_cam（画角のみで決まる投影）で画素化して描く。
 * 独自係数・独自式そのものは返さない（riseTime/windFollowRatio 等は応答に含めない）。
 */

import { elAng, windDriftWorld, hav, brng, seedNumMeta, type WindState } from "./hanabi_calc";

export interface SceneTubeInput {
  id: string;
  lat: number;
  lng: number;
  /** 地面標高[m]（elev） */
  elev?: number;
  /** 打ち上げ標高オフセット[m]（elevOffset） */
  elevOffset?: number;
  enabled?: boolean;
  /** 選択されている号数の配列（例: ["5","10"]） */
  nums: string[];
  /** 扇を描くか（tb.ougi。false のとき扇なし。既定は描く） */
  ougi?: boolean;
  /** 扇の正面方位[度]（tb.ougiAz。既定 0） */
  ougiAz?: number;
  /** 國友打ちの号数別方向数（tb.kunitomoNums。例 {"5":3,"10":5}） */
  kunitomoNums?: Record<string, number>;
}

export interface SceneTargetInput {
  id: string;
  lat: number;
  lng: number;
  elev?: number;
  baseOffset?: number;
  height: number;
}

/**
 * 号数表（ユーザーデータ）。height/dia は花火諸元（公開情報）。
 * riseTime/windFollowRatio はユーザーが編集・保存・import した場合のみ含まれる。
 * 未指定（初期状態）の号数はサーバ内部 seed の内部パラメータで補完する（結果のみ返す）。
 */
export interface NumRowInput {
  num: string;
  height: number;
  dia: number;
  riseTime?: number;
  windFollowRatio?: number;
}

export interface SceneSolveRequest {
  viewpoint: {
    /** 手動視点があるか（viewManual && viewLat!==null 相当） */
    manual: boolean;
    lat?: number | null;
    lng?: number | null;
    elev?: number; // viewElev
    tripodH: number; // cm
    elevOffset: number; // m
  };
  camera: {
    focal: number;
    sensor: { w: number; h: number };
    compMode: "land" | "port";
    azOffset: number; // deg
    elOffset: number; // deg
  };
  festivalTubes: SceneTubeInput[];
  targets: SceneTargetInput[];
  numTable: NumRowInput[];
  selectedTubeId: string;
  targetId?: string | null;
  subTargetIds?: string[];
  wind: WindState | null;
  /** 扇の高さ（db.ougi.height）。扇の開花点計算に使う。 */
  ougiHeight?: number;
}

export interface BurstResult {
  num: string;
  fwAzDeg: number;
  fwAltDeg: number;
  fwDkm: number;
  diaM: number;
  /** 元 renderSim の hasWind 判定（wind.azOffsetDeg!==0 || wind.distOffsetKm!==0）と同値。描画の弧/直線切替用。 */
  hasWind: boolean;
}

/** 扇（ougi）1方向の開花点（独自放物線 h=H·sin²θ, d=H·sin2θ）。半径円は描かない（弧のみ）。 */
export interface OugiPoint {
  horzDeg: number;
  fwAzDeg: number;
  fwAltDeg: number;
  fwDkm: number;
}

/** 國友打ち（kunitomo）1方向の開花点（独自放物線＋1.65補正＋riseTimeK＋風）。 */
export interface KunitomoPoint {
  num: string;
  horzDeg: number;
  fwAzDeg: number;
  fwAltDeg: number;
  fwDkm: number;
  radiusBasisM: number; // R = dia/2（client が radPx = f_px_H*R/(fwDkm*1000) を算出）
}

/**
 * KML(Google Earth) 用の國友打ち最終位置（旧 downloadGoogleEarthKml と同一・wind 非適用・tube 中心）。
 * client は lat/lng/alt をそのまま KML 座標へ書く（h/dBase/1.65 等の内部式は返さない）。
 */
export interface KmlKunitomoPoint {
  num: string;
  horzDeg: number;
  lat: number;
  lng: number;
  alt: number; // 絶対高度 = tubeElev + h
}

export interface TubeResult {
  id: string;
  groundAzDeg: number;
  groundAltDeg: number;
  dKm: number;
  bursts: BurstResult[];
  /** 扇の開花点（tb.ougi!==false のとき。無効時は空配列） */
  ougi: OugiPoint[];
  /** 國友打ちの開花点（kunitomoNums 設定の号数のみ・renderSim 用＝wind 適用・viewpoint 相対） */
  kunitomo: KunitomoPoint[];
  /**
   * KML(Google Earth) 用の國友打ち最終位置（wind 非適用・tube 中心・絶対 lat/lng/alt）。
   * renderSim 用の kunitomo とは semantics が異なる（KML は風で動かさず tube 座標基準）。
   * 旧 downloadGoogleEarthKml の kunitomo 描画結果をそのまま再現する適用済み最終値。
   */
  kmlKunitomo: KmlKunitomoPoint[];
}
export interface TargetResult {
  id: string;
  azDeg: number;
  dKm: number;
  vaTopDeg: number;
  vaBaseDeg: number;
  height: number;
  baseElev: number;
}

export interface SceneSolveResult {
  ok: boolean;
  reason?: string;
  view?: { lat: number; lng: number; sElev: number };
  camAxis?: { tAzDeg: number; dKmTube: number; vaTubeDeg: number };
  tubes?: TubeResult[];
  target?: TargetResult | null;
  subTargets?: TargetResult[];
}

const DEG = Math.PI / 180;

/** 元 client: tbBaseElev = elev + elevOffset */
function tbBaseElev(tb: { elev?: number; elevOffset?: number }): number {
  return (tb.elev || 0) + (tb.elevOffset || 0);
}
/** 元 client: tgBaseElev = elev + baseOffset */
function tgBaseElev(tg: { elev?: number; baseOffset?: number }): number {
  return (tg.elev || 0) + (tg.baseOffset || 0);
}

/** 号数の内部パラメータ（riseTime/windFollowRatio）を解決。ユーザーデータ優先、無ければ seed。 */
function resolveNumMeta(
  row: NumRowInput,
): { riseTime: number; windFollowRatio: number } {
  // 統合前 HANABI の loadDB/importData と同一挙動:
  // riseTime / windFollowRatio を**各 field 単位で独立に**解決する。
  //   riseTime: ユーザー明示値 → seed → 7
  //   windFollowRatio: ユーザー明示値 → seed → 0.8
  // （旧 client は欠落 field だけ default seed から補完し、明示 field は維持していた。）
  const seed = seedNumMeta(row.num);
  const riseTime = row.riseTime !== undefined ? row.riseTime : seed ? seed.riseTime : 7;
  const windFollowRatio =
    row.windFollowRatio !== undefined ? row.windFollowRatio : seed ? seed.windFollowRatio : 0.8;
  return { riseTime, windFollowRatio };
}

/**
 * 開花点の絶対緯度経度（great-circle destination）。
 * 元 client の扇/國友打ちのインライン asin/atan2 式と同一演算。
 */
function fwLatLng(tbLat: number, tbLng: number, azRad: number, dM: number): { lat: number; lng: number } {
  const R_earth = 6371000;
  const dOverR = dM / R_earth;
  const lat =
    (Math.asin(
      Math.sin((tbLat * Math.PI) / 180) * Math.cos(dOverR) +
        Math.cos((tbLat * Math.PI) / 180) * Math.sin(dOverR) * Math.cos(azRad),
    ) *
      180) /
    Math.PI;
  const lng =
    tbLng +
    (Math.atan2(
      Math.sin(azRad) * Math.sin(dOverR) * Math.cos((tbLat * Math.PI) / 180),
      Math.cos(dOverR) - Math.sin((tbLat * Math.PI) / 180) * Math.sin((lat * Math.PI) / 180),
    ) *
      180) /
    Math.PI;
  return { lat, lng };
}

/** 扇（ougi）の開花点群。元 renderSim 扇描画の値計算と同一。半径円なし（弧のみ）。 */
function solveOugi(
  tb: SceneTubeInput,
  ougiHeight: number,
  simLat: number,
  simLng: number,
  sElev: number,
  tbElev: number,
): OugiPoint[] {
  if (tb.ougi === false) return [];
  const ougiAzDeg = tb.ougiAz || 0;
  const latAzR = (ougiAzDeg + 90 + 360) % 360;
  const latAzL = (ougiAzDeg - 90 + 360) % 360;
  const ougiDirs = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
  const out: OugiPoint[] = [];
  for (const horzDeg of ougiDirs) {
    const thetaDeg = 90 - Math.abs(horzDeg);
    const theta = (thetaDeg * Math.PI) / 180;
    const h = ougiHeight * Math.sin(theta) * Math.sin(theta);
    const d = ougiHeight * Math.sin(2 * theta);
    const lateralAz = horzDeg >= 0 ? latAzR : latAzL;
    const { lat: fwLat, lng: fwLng } = fwLatLng(tb.lat, tb.lng, (lateralAz * Math.PI) / 180, d);
    const fwAzDeg = brng(simLat, simLng, fwLat, fwLng);
    const fwDkm = Math.max(0.05, hav(simLat, simLng, fwLat, fwLng));
    const fwAlt = elAng(fwDkm, sElev, tbElev, h);
    out.push({ horzDeg, fwAzDeg, fwAltDeg: fwAlt, fwDkm });
  }
  return out;
}

/** 國友打ち（kunitomo）の開花点群。元 renderSim 國友打ち描画の値計算と同一。 */
function solveKunitomo(
  tb: SceneTubeInput,
  numByNum: Map<string, NumRowInput>,
  simLat: number,
  simLng: number,
  sElev: number,
  tbElev: number,
  wind: WindState | null,
): KunitomoPoint[] {
  const kunitomoNums = tb.kunitomoNums || {};
  const ougiAzDeg = tb.ougiAz || 0;
  const out: KunitomoPoint[] = [];
  // 10号以下の登録号数で kunitomoNums に設定があるもののみ（元実装と同一フィルタ）
  const kNumRows = tb.nums
    .map((n) => ({ row: numByNum.get(n), num: n }))
    .filter(({ row, num }) => row && parseInt(num) <= 10 && (kunitomoNums[num] || 0) > 0);

  for (const { row, num } of kNumRows) {
    if (!row) continue;
    const dirs = kunitomoNums[num] === 5 ? [-60, -30, 0, 30, 60] : [-30, 0, 30];
    const H = row.height;
    const R = row.dia / 2;
    const meta = resolveNumMeta(row);
    const baseRiseTime = meta.riseTime !== undefined && meta.riseTime !== null ? meta.riseTime : 7;

    for (const horzDeg of dirs) {
      const thetaDeg = 90 - Math.abs(horzDeg);
      const theta = (thetaDeg * Math.PI) / 180;
      const h = H * Math.sin(theta) * Math.sin(theta);
      const dBase = H * Math.sin(theta) * Math.cos(theta) * 2;
      const d = dBase * (Math.abs(horzDeg) === 60 ? 1.65 : 1.0);
      const riseTimeK = baseRiseTime * Math.sin(theta);

      const lateralAzDeg =
        horzDeg === 0 ? ougiAzDeg : (ougiAzDeg + (horzDeg > 0 ? 90 : -90) + 360) % 360;
      const arrivalAzRad = (lateralAzDeg * Math.PI) / 180;

      const windK = windDriftWorld(riseTimeK, meta.windFollowRatio, wind);
      // 風なしの ground burst world 位置（既存の horzDeg/h/dBase/1.65/lateralAz から確定）。
      const g = fwLatLng(tb.lat, tb.lng, arrivalAzRad, d);
      // world-fixed: その world 位置から blowToDeg 方向へ driftM だけ world 上で移動して固定。
      const bw =
        windK.driftM === 0
          ? { lat: g.lat, lng: g.lng }
          : fwLatLng(g.lat, g.lng, (windK.blowToDeg * Math.PI) / 180, windK.driftM);
      // 固定 world 位置を viewpoint へ投影。
      const fwAzDeg = brng(simLat, simLng, bw.lat, bw.lng);
      const fwDkm = Math.max(0.05, hav(simLat, simLng, bw.lat, bw.lng));
      const fwAlt = elAng(fwDkm, sElev, tbElev, h);
      out.push({ num, horzDeg, fwAzDeg, fwAltDeg: fwAlt, fwDkm, radiusBasisM: R });
    }
  }
  return out;
}

/**
 * 対象物の解（方位・距離・仰角 top/base）を計算する。renderSim drawTarget の値計算と同一。
 */
function solveTarget(
  simLat: number,
  simLng: number,
  sElev: number,
  tg: SceneTargetInput,
): TargetResult {
  const dTgElev = tgBaseElev(tg);
  const azDeg = brng(simLat, simLng, tg.lat, tg.lng);
  const dKm = hav(simLat, simLng, tg.lat, tg.lng);
  const vaTopDeg = elAng(dKm, sElev, dTgElev, tg.height);
  const vaBaseDeg = elAng(dKm, sElev, dTgElev, 0);
  return { id: tg.id, azDeg, dKm, vaTopDeg, vaBaseDeg, height: tg.height, baseElev: dTgElev };
}

/**
 * KML(Google Earth) 用の國友打ち最終位置を計算する（旧 downloadGoogleEarthKml と同一演算）。
 * 正本（結果を変えない）:
 *   dirs = kunitomoNums[num]===5 ? [-60,-30,0,30,60] : [-30,0,30]
 *   thetaDeg=90-|horzDeg|, h=H·sin²θ, dBase=H·sinθ·cosθ·2, d=dBase·(|horzDeg|===60?1.65:1)
 *   alt = tubeElev + h
 *   horzDeg===0: tube 座標。horzDeg≠0: destPoint(tube, (ougiAz±90), d/1000)。
 *   ※ renderSim 用 solveKunitomo と異なり wind 非適用・num サイズ制限なし・tube 中心。
 *   ※ 号数は height 降順（KML の numRows ソートと同一）。
 */
function solveKmlKunitomo(
  tb: SceneTubeInput,
  numByNum: Map<string, NumRowInput>,
  tbElev: number,
): KmlKunitomoPoint[] {
  const kunitomoNums = tb.kunitomoNums || {};
  const ougiAz = tb.ougiAz || 0;
  const out: KmlKunitomoPoint[] = [];
  // KML は numRows を height 降順にソートしてから走査する（同一順序を再現）。
  const numRows = tb.nums
    .map((n) => numByNum.get(n))
    .filter((r): r is NumRowInput => !!r)
    .sort((a, b) => b.height - a.height);
  for (const row of numRows) {
    const cnt = kunitomoNums[row.num] || 0;
    if (!(cnt > 0)) continue; // KML は num サイズ制限なし（kunitomoNums[num]>0 のみ）
    const dirs = cnt === 5 ? [-60, -30, 0, 30, 60] : [-30, 0, 30];
    for (const horzDeg of dirs) {
      const thetaDeg = 90 - Math.abs(horzDeg);
      const theta = (thetaDeg * Math.PI) / 180;
      const h = row.height * Math.sin(theta) * Math.sin(theta);
      const dBase = row.height * Math.sin(theta) * Math.cos(theta) * 2;
      const d = dBase * (Math.abs(horzDeg) === 60 ? 1.65 : 1.0);
      const alt = tbElev + h;
      let lat: number;
      let lng: number;
      if (horzDeg === 0) {
        lat = tb.lat;
        lng = tb.lng;
      } else {
        const latAzDeg = (ougiAz + (horzDeg > 0 ? 90 : -90) + 360) % 360;
        const p = fwLatLng(tb.lat, tb.lng, (latAzDeg * Math.PI) / 180, d);
        lat = p.lat;
        lng = p.lng;
      }
      out.push({ num: row.num, horzDeg, lat, lng, alt });
    }
  }
  return out;
}

/**
 * renderSim の「答えを計算する部分」を、同一演算で再現する。
 */
export function solveScene(req: SceneSolveRequest): SceneSolveResult {
  const { viewpoint, festivalTubes, targets, numTable, selectedTubeId, wind } = req;

  // 選択筒場（renderSim: tubes.find(...)。tubes は名前順ソートだが選択解決には無関係）
  const selTube = festivalTubes.find((t) => t.id === selectedTubeId);
  if (!selTube) return { ok: false, reason: "NO_SELECTED_TUBE" };

  const tg = req.targetId ? targets.find((x) => x.id === req.targetId) || null : null;

  // 視点標高（renderSim と同一分岐）
  let simLat: number, simLng: number, sElev: number;
  if (viewpoint.manual && viewpoint.lat !== null && viewpoint.lat !== undefined) {
    simLat = viewpoint.lat;
    simLng = viewpoint.lng as number;
    sElev = (viewpoint.elev || 0) + viewpoint.tripodH / 100 + viewpoint.elevOffset;
  } else if (tg) {
    const az2tube = brng(tg.lat, tg.lng, selTube.lat, selTube.lng);
    const deg1km = 1000 / 111000;
    simLat = tg.lat + Math.cos(az2tube * DEG) * deg1km;
    simLng = tg.lng + (Math.sin(az2tube * DEG) * deg1km) / Math.cos(tg.lat * DEG);
    sElev = viewpoint.tripodH / 100 + viewpoint.elevOffset;
  } else {
    return { ok: false, reason: "NO_VIEWPOINT" };
  }

  // 視点→選択筒場の基本方位・距離
  const tAz = brng(simLat, simLng, selTube.lat, selTube.lng);
  const dKmTube = hav(simLat, simLng, selTube.lat, selTube.lng);

  // カメラ仰角基準：選択筒場の最大号数開花高度（renderSim simMaxRow/simTargetH と同一）
  const numByNum = new Map(numTable.map((r) => [r.num, r]));
  const simNumRows = selTube.nums.map((n) => numByNum.get(n)).filter(Boolean) as NumRowInput[];
  const simMaxRow =
    simNumRows.length > 0 ? simNumRows.reduce((a, b) => (a.height > b.height ? a : b)) : null;
  const simTargetH = simMaxRow ? simMaxRow.height : 100;
  const vaTubeDeg = elAng(dKmTube, sElev, tbBaseElev(selTube), simTargetH);

  // 各筒場の解（renderSim drawFireworks と同一演算）
  const tubes: TubeResult[] = [];
  for (const tb of festivalTubes) {
    if (tb.enabled === false) continue; // 無効筒場はスキップ（renderSim と同一）
    const tbElev = tbBaseElev(tb);
    const tbDkm = hav(simLat, simLng, tb.lat, tb.lng);
    const tbAz = brng(simLat, simLng, tb.lat, tb.lng);
    const groundAltDeg = elAng(tbDkm, sElev, tbElev, 0);

    const bursts: BurstResult[] = [];
    for (const numStr of tb.nums) {
      const row = numByNum.get(numStr);
      if (!row) continue;
      const meta = resolveNumMeta(row);
      const riseTime = meta.riseTime !== undefined && meta.riseTime !== null ? meta.riseTime : 7;
      // world-fixed: 風で流された burst world 位置を先に確定（viewpoint を風物理の入力にしない）。
      // driftM/blowToDeg は既存と同一式（WIND_ALT_FACTOR/followRatio/riseTime, blowTo=dir+180）。
      const wd = windDriftWorld(riseTime || 7, meta.windFollowRatio, wind);
      const bw =
        wd.driftM === 0
          ? { lat: tb.lat, lng: tb.lng }
          : fwLatLng(tb.lat, tb.lng, (wd.blowToDeg * Math.PI) / 180, wd.driftM);
      // 固定 world 位置を viewpoint へ投影する。
      const fwAz = brng(simLat, simLng, bw.lat, bw.lng);
      const fwDkm = Math.max(0.05, hav(simLat, simLng, bw.lat, bw.lng));
      const fwAlt = elAng(fwDkm, sElev, tbElev, row.height);
      // 元 renderSim の hasWind と同一意味（弧/直線の描画切替に client が使う）。風で動いたら true。
      const hasWind = wd.driftM !== 0;
      bursts.push({ num: numStr, fwAzDeg: fwAz, fwAltDeg: fwAlt, fwDkm, diaM: row.dia, hasWind });
    }
    tubes.push({
      id: tb.id,
      groundAzDeg: tbAz,
      groundAltDeg,
      dKm: tbDkm,
      bursts,
      ougi: solveOugi(tb, req.ougiHeight ?? 90, simLat, simLng, sElev, tbElev),
      kunitomo: solveKunitomo(tb, numByNum, simLat, simLng, sElev, tbElev, wind),
      kmlKunitomo: solveKmlKunitomo(tb, numByNum, tbElev),
    });
  }

  const target = tg ? solveTarget(simLat, simLng, sElev, tg) : null;
  const subTargets: TargetResult[] = [];
  for (const sid of req.subTargetIds || []) {
    const st = targets.find((x) => x.id === sid);
    if (st) subTargets.push(solveTarget(simLat, simLng, sElev, st));
  }

  return {
    ok: true,
    view: { lat: simLat, lng: simLng, sElev },
    camAxis: { tAzDeg: tAz, dKmTube, vaTubeDeg },
    tubes,
    target,
    subTargets,
  };
}
