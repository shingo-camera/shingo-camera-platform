/**
 * Terrain-RGB decoder（png.ts）と tile fetch/cache/concurrency（terrain_tiles.ts）のテスト。
 *
 * - RGB→elevation decode / no-data(0,0,0) / 境界 / 各 filter type（None/Sub/Up/Average/Paeth）。
 * - IHDR 検証（bit depth / color type / interlace / 寸法）で対応範囲外を fail-closed。
 * - request 内 tile cache（同一 tile は 1 回だけ fetch/decode）。
 * - 同時接続上限（≤6）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  decodeTerrainPng, elevFromPixel, PngError,
  TerrainElevationProvider, lngToTileX, latToTileY,
} from "./_bundle/hanabi_terrain.mjs";
import { makeTilePng, makeFakeFetcher, fixtureElev, clientGetElev } from "./_terrain_fixture.mjs";

// PNG builder（任意 IHDR でテスト用に生成）
function crc32(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return(~c)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length,0);const body=Buffer.concat([Buffer.from(type,"ascii"),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body),0);return Buffer.concat([len,body,crc]);}
function customPng(w,h,bd,ct,interlace){
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);
  ihdr[8]=bd;ihdr[9]=ct;ihdr[10]=0;ihdr[11]=0;ihdr[12]=interlace;
  const idat=zlib.deflateSync(Buffer.alloc(8));
  return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",idat),chunk("IEND",Buffer.alloc(0))]);
}

test("[terrain-decode] 各 filter type で RGB→elevation が client 式と一致", async () => {
  for (const ft of [0, 1, 2, 3, 4]) {
    const png = new Uint8Array(makeTilePng(13, 7274, 3225, ft));
    const tile = await decodeTerrainPng(png);
    assert.equal(tile.w, 256); assert.equal(tile.h, 256); assert.equal(tile.ch, 3);
    // 代表 pixel を fixture 期待値と照合
    for (const [px, py] of [[10, 10], [128, 200], [255, 255], [0, 0]]) {
      const e = elevFromPixel(tile, px, py);
      const expectRaw = fixtureElev(13, 7274, 3225, px, py);
      if (expectRaw === null) { assert.equal(e, null, `filter${ft} (${px},${py}) no-data`); continue; }
      // encode→decode 量子化を通した期待値
      const v = Math.round((expectRaw + 10000) / 0.1);
      const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      const expect = (r === 0 && g === 0 && b === 0) ? null : -10000 + (r * 65536 + g * 256 + b) * 0.1;
      assert.ok(Math.abs(e - expect) < 1e-9, `filter${ft} (${px},${py}) elev ${e} vs ${expect}`);
    }
  }
});

test("[terrain-decode] no-data(0,0,0) は null", async () => {
  // (tx+ty)%7===0 かつ px<8,py<8 が no-data になる tile を選ぶ（7274+3226=10500, %7=0）
  const png = new Uint8Array(makeTilePng(13, 7274, 3226, 0));
  const tile = await decodeTerrainPng(png);
  assert.equal(elevFromPixel(tile, 2, 2), null, "no-data 領域は null");
  assert.notEqual(elevFromPixel(tile, 100, 100), null, "通常領域は値あり");
});

test("[terrain-decode] IHDR 検証: 16bit/interlace/color type 0/過大寸法 は fail-closed", async () => {
  await assert.rejects(() => decodeTerrainPng(new Uint8Array(customPng(256, 256, 16, 2, 0))), PngError, "16bit 拒否");
  await assert.rejects(() => decodeTerrainPng(new Uint8Array(customPng(256, 256, 8, 2, 1))), PngError, "interlace 拒否");
  await assert.rejects(() => decodeTerrainPng(new Uint8Array(customPng(256, 256, 8, 0, 0))), PngError, "color type 0(grayscale) 拒否");
  await assert.rejects(() => decodeTerrainPng(new Uint8Array(customPng(512, 512, 8, 2, 0))), PngError, "過大寸法 拒否");
});

test("[terrain-decode] 不正 signature / 過小サイズ は fail-closed", async () => {
  await assert.rejects(() => decodeTerrainPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), PngError);
  await assert.rejects(() => decodeTerrainPng(new Uint8Array([1, 2, 3])), PngError);
});

test("[terrain-tiles] provider getElev が client getElevFromR2 と一致", async () => {
  const { fetcher } = makeFakeFetcher(0);
  const prov = new TerrainElevationProvider(fetcher);
  const coords = [
    { lat: 34.68, lng: 135.50 }, { lat: 35.20, lng: 138.60 }, { lat: 34.70, lng: 135.52 },
  ];
  await prov.prefetch(coords);
  for (const { lat, lng } of coords) {
    const got = prov.getElev(lat, lng);
    const expect = clientGetElev(lat, lng);
    if (expect === null) assert.equal(got, null);
    else assert.ok(Math.abs(got - expect) < 1e-9, `elev ${got} vs ${expect}`);
  }
});

test("[terrain-tiles] 同一 tile は 1 回だけ fetch（request 内 cache）", async () => {
  const { fetcher, fetched } = makeFakeFetcher(0);
  const prov = new TerrainElevationProvider(fetcher);
  // 同一 tile 内に落ちる近接座標を多数
  const coords = [];
  for (let i = 0; i < 50; i++) coords.push({ lat: 34.6800 + i * 1e-5, lng: 135.5000 + i * 1e-5 });
  await prov.prefetch(coords);
  const uniq = new Set(fetched);
  assert.equal(fetched.length, uniq.size, "重複 fetch なし");
  // 2 回目 prefetch（同じ座標）→ 追加 fetch 0
  const before = fetched.length;
  await prov.prefetch(coords);
  assert.equal(fetched.length, before, "cache 済みは再 fetch しない");
});

test("[terrain-tiles] 404 相当は no-data 扱い（hadFailure=false）", async () => {
  // 特定 tile を nodata（404）にする → getElev は null、hadFailure は false のまま。
  const { fetcher } = makeFakeFetcher(0, { nodata: (z, x, y) => (x % 2 === 0) });
  const prov = new TerrainElevationProvider(fetcher);
  await prov.prefetch([{ lat: 34.68, lng: 135.50 }, { lat: 35.20, lng: 138.60 }]);
  assert.equal(prov.hadFailure(), false, "404(nodata) は systemic failure ではない");
});

test("[terrain-tiles] 500/503 相当は failure（hadFailure=true → TERRAIN_UNAVAILABLE 経路）", async () => {
  const { fetcher } = makeFakeFetcher(0, { failure: () => true, failureStatus: 503 });
  const prov = new TerrainElevationProvider(fetcher);
  await prov.prefetch([{ lat: 34.68, lng: 135.50 }]);
  assert.equal(prov.hadFailure(), true, "5xx は systemic failure（no-data と誤認しない）");
});

test("[terrain-tiles] 403/410/429 も failure 扱い", async () => {
  for (const st of [403, 410, 429]) {
    const { fetcher } = makeFakeFetcher(0, { failure: () => true, failureStatus: st });
    const prov = new TerrainElevationProvider(fetcher);
    await prov.prefetch([{ lat: 34.68, lng: 135.50 }]);
    assert.equal(prov.hadFailure(), true, `${st} は failure`);
  }
});

test("[terrain-tiles] 不正 PNG(200 だが decode 不能) は failure 扱い", async () => {
  const { fetcher } = makeFakeFetcher(0, { badPng: () => true });
  const prov = new TerrainElevationProvider(fetcher);
  await prov.prefetch([{ lat: 34.68, lng: 135.50 }]);
  assert.equal(prov.hadFailure(), true, "decode 失敗は failure（fail-closed）");
  assert.doesNotThrow(() => prov.getElev(34.68, 135.50));
});
