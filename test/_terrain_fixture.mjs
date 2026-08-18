/**
 * Terrain characterization/parity 用の共有フィクスチャ。
 * - 固定 elevation 関数から Terrain-RGB PNG（8bit/RGB/非interlace）を生成。
 * - fake tile fetcher（server の TerrainElevationProvider に注入）。
 * - client（fetchTerrainProfile/fetchBgRidgeline/getElevFromR2）の忠実 JS 参照実装。
 *
 * ネットワーク terrain は変動要因があるため、固定 elevation fixture を正本にする。
 */
import zlib from "node:zlib";
import { elAng as _elAng, hav as _hav, brng as _brng } from "./_bundle/hanabi_calc.mjs";

const R = 6371000;
const DEG = Math.PI / 180;
const STEP = 50;
const NAZ = Math.ceil(800 / 4); // 200（現行 preview-canvas 不在の固定値）
const FUJI_LAT = 35.3606, FUJI_LNG = 138.7274;

// ---- 固定 elevation fixture（tile 座標→標高 を決定的に返す）----
// z13 tile / pixel 単位で決まる合成標高。no-data 領域も混ぜる。
export function fixtureElev(z, tx, ty, px, py) {
  // 特定 tile の一部を no-data(0,0,0) にする
  if ((tx + ty) % 7 === 0 && px < 8 && py < 8) return null; // no-data
  // 決定的な標高（tile 座標と pixel から）
  const base = ((tx * 131 + ty * 57) % 500);
  return base + px * 1.5 + py * 0.75; // m
}

// ---- Terrain-RGB encode/PNG 生成 ----
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encElev(e) {
  if (e === null) return [0, 0, 0];
  const v = Math.round((e + 10000) / 0.1);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
// 8bit RGB 非interlace, filter type 0（各行 None）で PNG を作る
export function makeTilePng(z, tx, ty, filterType = 0) {
  const W = 256, H = 256, ch = 3;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = W * ch;
  const raw = Buffer.alloc(H * (stride + 1));
  // まず生 RGB を作る
  const rgb = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = encElev(fixtureElev(z, tx, ty, x, y));
    const o = y * stride + x * ch; rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
  }
  // filter を適用（parity 検証のため filterType を切替可能に）
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = filterType;
    for (let i = 0; i < stride; i++) {
      const cur = rgb[y * stride + i];
      const a = i >= ch ? rgb[y * stride + i - ch] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + i] : 0;
      const c = (i >= ch && y > 0) ? rgb[(y - 1) * stride + i - ch] : 0;
      let f;
      if (filterType === 0) f = cur;
      else if (filterType === 1) f = (cur - a) & 255;
      else if (filterType === 2) f = (cur - b) & 255;
      else if (filterType === 3) f = (cur - ((a + b) >> 1)) & 255;
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; f = (cur - pred) & 255; }
      raw[y * (stride + 1) + 1 + i] = f;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---- fake fetcher（server TerrainElevationProvider へ注入）----
// TileResult: {kind:"ok",bytes} | {kind:"nodata"} | {kind:"failure",status}
export function makeFakeFetcher(filterType = 0, opts = {}) {
  const fetched = [];
  const fetcher = async (z, x, y) => {
    fetched.push(`${z}/${x}/${y}`);
    if (opts.nodata && opts.nodata(z, x, y)) return { kind: "nodata" };
    if (opts.failure && opts.failure(z, x, y)) return { kind: "failure", status: opts.failureStatus || 503 };
    if (opts.badPng && opts.badPng(z, x, y)) return { kind: "ok", bytes: new Uint8Array([1, 2, 3, 4]) }; // 不正 PNG（decode 失敗）
    return { kind: "ok", bytes: new Uint8Array(makeTilePng(z, x, y, filterType)) };
  };
  return { fetcher, fetched };
}

// ---- client 参照実装（getElevFromR2 と同一の tile/pixel/decode）----
function lngToTileX(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
function latToTileY(lat, z) { return Math.floor((1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2 * Math.pow(2, z)); }
export function clientGetElev(lat, lng) {
  const z = 13;
  const tx = lngToTileX(lng, z), ty = latToTileY(lat, z);
  const px = Math.floor(((lng + 180) / 360 * Math.pow(2, z) - tx) * 256);
  const py = Math.floor(((1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2 * Math.pow(2, z) - ty) * 256);
  const pxc = Math.min(255, Math.max(0, px)), pyc = Math.min(255, Math.max(0, py));
  const e = fixtureElev(z, tx, ty, pxc, pyc);
  if (e === null) return null;
  // encode→decode round-trip（PNG と同じ量子化を通す）
  const [r, g, b] = encElev(e);
  if (r === 0 && g === 0 && b === 0) return null;
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

export function hav(lat1, lng1, lat2, lng2) { return _hav(lat1, lng1, lat2, lng2); }
export function brng(lat1, lng1, lat2, lng2) { return _brng(lat1, lng1, lat2, lng2); }
export function elAng(dKm, se, te, th) { return _elAng(dKm, se, te, th); }

const project = (vLat, vLng, azRad, xm) => ({
  lat: vLat + (xm * Math.cos(azRad) / R) * (180 / Math.PI),
  lng: vLng + (xm * Math.sin(azRad) / R) * (180 / Math.PI) / Math.cos(vLat * DEG),
});

// ---- client 参照 front terrain（fetchTerrainProfile 忠実移植）----
export function clientFront({ viewLat, viewLng, sElev, tube, allTubes, maxDiaHalf, camAzDeg, fovH, treeHeightM }) {
  const distM = hav(viewLat, viewLng, tube.lat, tube.lng) * 1000;
  const steps = Math.max(2, Math.floor(distM / STEP));
  const az = brng(viewLat, viewLng, tube.lat, tube.lng) * DEG;
  const perpAz = az + Math.PI / 2;
  const offsets = [0, maxDiaHalf, -maxDiaHalf];
  const profile = [];
  for (let i = 0; i <= steps; i++) {
    const xm = (distM / steps) * i;
    const lat0 = viewLat + (xm * Math.cos(az) / R) * (180 / Math.PI);
    const lng0 = viewLng + (xm * Math.sin(az) / R) * (180 / Math.PI) / Math.cos(viewLat * DEG);
    let maxElev = null;
    for (const off of offsets) {
      let lat1 = lat0, lng1 = lng0;
      if (off !== 0) {
        lat1 = lat0 + (off * Math.cos(perpAz) / R) * (180 / Math.PI);
        lng1 = lng0 + (off * Math.sin(perpAz) / R) * (180 / Math.PI) / Math.cos(lat0 * DEG);
      }
      const e = clientGetElev(lat1, lng1);
      if (e !== null && (maxElev === null || e > maxElev)) maxElev = e;
    }
    profile.push({ x: xm, elev: maxElev !== null ? maxElev : 0 });
  }
  const maxDistM = allTubes.reduce((mx, tb) => Math.max(mx, hav(viewLat, viewLng, tb.lat, tb.lng) * 1000), distM);
  const ridgeSteps = Math.max(2, Math.floor(maxDistM / STEP));
  const halfFov = fovH / 2;
  const ridgeline = [];
  for (let i = 0; i < NAZ; i++) {
    const t2 = i / (NAZ - 1);
    const azDeg = camAzDeg - halfFov + t2 * fovH;
    const azRad = azDeg * DEG;
    let maxVA = null;
    for (let j = 1; j <= ridgeSteps; j++) {
      const xm = (maxDistM / ridgeSteps) * j;
      const p = project(viewLat, viewLng, azRad, xm);
      const e = clientGetElev(p.lat, p.lng);
      if (e === null) continue;
      const eEff = e > sElev ? e + treeHeightM : e;
      const va = elAng(xm / 1000, sElev, eEff, 0);
      if (maxVA === null || va > maxVA) maxVA = va;
    }
    ridgeline.push({ azDeg, maxVA });
  }
  // fuji
  const distToFujiKm = hav(viewLat, viewLng, FUJI_LAT, FUJI_LNG);
  const fujiAzDeg = brng(viewLat, viewLng, FUJI_LAT, FUJI_LNG);
  const fujiInFov = Math.abs(((fujiAzDeg - camAzDeg + 540) % 360) - 180) <= halfFov;
  let ridgelineFuji = null;
  if (distToFujiKm <= 30 && fujiInFov) {
    const fujiDistM = (distToFujiKm + 12) * 1000;
    const fujiSteps = Math.max(2, Math.floor(fujiDistM / STEP));
    const startJ = Math.ceil((maxDistM / fujiDistM) * fujiSteps) + 1;
    ridgelineFuji = [];
    for (let i = 0; i < NAZ; i++) {
      const t2 = i / (NAZ - 1);
      const azDeg = camAzDeg - halfFov + t2 * fovH;
      const azRad = azDeg * DEG;
      let maxVA = null;
      for (let j = startJ; j <= fujiSteps; j++) {
        const xm = (fujiDistM / fujiSteps) * j;
        const p = project(viewLat, viewLng, azRad, xm);
        const e = clientGetElev(p.lat, p.lng);
        if (e === null) continue;
        const va = elAng(xm / 1000, sElev, e, 0);
        if (maxVA === null || va > maxVA) maxVA = va;
      }
      ridgelineFuji.push({ azDeg, maxVA });
    }
  }
  return { profile, ridgeline, ridgelineFuji };
}

// ---- client 参照 back terrain（fetchBgRidgeline 忠実移植）----
export function clientBack({ viewLat, viewLng, sElev, tube, camAzDeg, fovH, treeHeightM }) {
  const distM = hav(viewLat, viewLng, tube.lat, tube.lng) * 1000;
  const BG_MAX_KM = 20;
  const startM = distM, endM = distM + BG_MAX_KM * 1000;
  const steps = Math.max(2, Math.floor((endM - startM) / STEP));
  const halfFov = fovH / 2;
  const bgRidgeline = [];
  for (let i = 0; i < NAZ; i++) {
    const t = i / (NAZ - 1);
    const azDeg = camAzDeg - halfFov + t * fovH;
    const azRad = azDeg * DEG;
    let maxVA = null;
    for (let j = 0; j <= steps; j++) {
      const xm = startM + STEP * j;
      const p = project(viewLat, viewLng, azRad, xm);
      const e = clientGetElev(p.lat, p.lng);
      if (e === null) continue;
      const eEff = e > sElev ? e + treeHeightM : e;
      const va = elAng(xm / 1000, sElev, eEff, 0);
      if (maxVA === null || va > maxVA) maxVA = va;
    }
    bgRidgeline.push({ azDeg, maxVA });
  }
  return { bgRidgeline };
}
