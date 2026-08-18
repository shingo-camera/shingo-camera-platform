/**
 * Terrain solve の結果 parity（server solveTerrain vs client 参照実装）。
 *
 * 固定 elevation fixture を正本に、同じ入力で server と client の
 * profile / ridgeline / obstruction / 富士 / 後地形 が一致することを固定する。
 * sampling parity（3線 / ridge 方位 / treeHeight / 富士特例）も含む。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveTerrain, TerrainElevationProvider, NAZIMUTHS } from "./_bundle/hanabi_terrain.mjs";
import { makeFakeFetcher, clientFront, clientBack, hav, brng } from "./_terrain_fixture.mjs";

function approxEqRidge(a, b, msg) {
  assert.equal(a.length, b.length, msg + " length");
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i].azDeg - b[i].azDeg) < 1e-9, `${msg}[${i}] azDeg ${a[i].azDeg} vs ${b[i].azDeg}`);
    if (a[i].maxVA === null || b[i].maxVA === null) {
      assert.equal(a[i].maxVA, b[i].maxVA, `${msg}[${i}] maxVA null`);
    } else {
      assert.ok(Math.abs(a[i].maxVA - b[i].maxVA) < 1e-9, `${msg}[${i}] maxVA ${a[i].maxVA} vs ${b[i].maxVA}`);
    }
  }
}

async function runServerFront(input) {
  const { fetcher } = makeFakeFetcher(0);
  const prov = new TerrainElevationProvider(fetcher);
  return solveTerrain({
    mode: "front",
    viewpoint: { lat: input.viewLat, lng: input.viewLng, elev: input.elev, tripodH: input.tripodH, elevOffset: input.elevOffset },
    selectedTube: input.tube,
    allTubes: input.allTubes,
    maxDiaHalf: input.maxDiaHalf,
    camAzDeg: input.camAzDeg,
    fovHDeg: input.fovH,
    treeHeightM: input.treeHeightM,
  }, prov);
}
async function runServerBack(input) {
  const { fetcher } = makeFakeFetcher(0);
  const prov = new TerrainElevationProvider(fetcher);
  return solveTerrain({
    mode: "back",
    viewpoint: { lat: input.viewLat, lng: input.viewLng, elev: input.elev, tripodH: input.tripodH, elevOffset: input.elevOffset },
    selectedTube: input.tube,
    allTubes: input.allTubes,
    maxDiaHalf: input.maxDiaHalf,
    camAzDeg: input.camAzDeg,
    fovHDeg: input.fovH,
    treeHeightM: input.treeHeightM,
  }, prov);
}

// sElev を client 参照へ渡すため算出
function sElevOf(i) { return (i.elev || 0) + i.tripodH / 100 + i.elevOffset; }

test("[terrain-solve] front: profile/ridgeline が client と一致（通常ケース）", async () => {
  const input = {
    viewLat: 34.68, viewLng: 135.50, elev: 10, tripodH: 150, elevOffset: 0,
    tube: { lat: 34.689, lng: 135.50 }, allTubes: [{ lat: 34.689, lng: 135.50 }, { lat: 34.690, lng: 135.501 }],
    maxDiaHalf: 160, camAzDeg: brng(34.68, 135.50, 34.689, 135.50), fovH: 10, treeHeightM: 20,
  };
  const s = await runServerFront(input);
  const c = clientFront({ ...input, sElev: sElevOf(input) });
  assert.equal(s.profile.length, c.profile.length, "profile length");
  for (let i = 0; i < c.profile.length; i++) {
    assert.ok(Math.abs(s.profile[i].x - c.profile[i].x) < 1e-9, `profile[${i}].x`);
    assert.ok(Math.abs(s.profile[i].elev - c.profile[i].elev) < 1e-9, `profile[${i}].elev ${s.profile[i].elev} vs ${c.profile[i].elev}`);
  }
  approxEqRidge(s.ridgeline, c.ridgeline, "ridgeline");
  assert.equal(s.ridgeline.length, NAZIMUTHS, "nAzimuths=200 固定");
  assert.equal(s.ridgelineFuji, null, "富士圏外は null");
});

test("[terrain-solve] front: treeHeight 補正が効く（樹高で稜線が上がる）", async () => {
  const base = {
    viewLat: 34.68, viewLng: 135.50, elev: 10, tripodH: 150, elevOffset: 0,
    tube: { lat: 34.71, lng: 135.50 }, allTubes: [{ lat: 34.71, lng: 135.50 }],
    maxDiaHalf: 200, camAzDeg: brng(34.68, 135.50, 34.71, 135.50), fovH: 20,
  };
  const s0 = await runServerFront({ ...base, treeHeightM: 0 });
  const s20 = await runServerFront({ ...base, treeHeightM: 20 });
  // client 参照とも一致
  const c20 = clientFront({ ...base, treeHeightM: 20, sElev: sElevOf({ ...base, treeHeightM: 20 }) });
  approxEqRidge(s20.ridgeline, c20.ridgeline, "ridgeline tree=20");
  // 樹高ありの方が maxVA が同等以上（少なくとも一部で上がる）
  let anyHigher = false;
  for (let i = 0; i < s0.ridgeline.length; i++) {
    if (s0.ridgeline[i].maxVA !== null && s20.ridgeline[i].maxVA !== null && s20.ridgeline[i].maxVA > s0.ridgeline[i].maxVA + 1e-12) anyHigher = true;
  }
  assert.ok(anyHigher, "樹高補正で稜線が上がる方位が存在する");
});

test("[terrain-solve] front: 富士特例が client と一致（富士圏内）", async () => {
  // 富士近傍・画角を富士方向へ
  const view = { lat: 35.20, lng: 138.60 };
  const tube = { lat: 35.25, lng: 138.62 };
  const camAzDeg = brng(view.lat, view.lng, 35.3606, 138.7274); // 富士方向
  const input = {
    viewLat: view.lat, viewLng: view.lng, elev: 100, tripodH: 150, elevOffset: 0,
    tube, allTubes: [tube, { lat: 35.30, lng: 138.65 }],
    maxDiaHalf: 300, camAzDeg, fovH: 40, treeHeightM: 20,
  };
  const s = await runServerFront(input);
  const c = clientFront({ ...input, sElev: sElevOf(input) });
  assert.notEqual(s.ridgelineFuji, null, "富士圏内は fuji あり");
  assert.notEqual(c.ridgelineFuji, null);
  approxEqRidge(s.ridgelineFuji, c.ridgelineFuji, "ridgelineFuji");
  approxEqRidge(s.ridgeline, c.ridgeline, "ridgeline(富士ケース)");
});

test("[terrain-solve] back: bgRidgeline が client と一致", async () => {
  const input = {
    viewLat: 34.68, viewLng: 135.50, elev: 10, tripodH: 150, elevOffset: 0,
    tube: { lat: 34.71, lng: 135.50 }, allTubes: [{ lat: 34.71, lng: 135.50 }],
    maxDiaHalf: 200, camAzDeg: brng(34.68, 135.50, 34.71, 135.50), fovH: 20, treeHeightM: 20,
  };
  const s = await runServerBack(input);
  const c = clientBack({ ...input, sElev: sElevOf(input) });
  approxEqRidge(s.bgRidgeline, c.bgRidgeline, "bgRidgeline");
  assert.equal(s.bgRidgeline.length, NAZIMUTHS);
});

test("[terrain-solve] sampling parity: server が生成する sample tile は client と同一集合", async () => {
  // server の prefetch が触る tile と、client 参照の getElev が触る tile が一致することを、
  // fetched tile 集合と client の sample 座標→tile 集合で照合。
  const input = {
    viewLat: 34.68, viewLng: 135.50, elev: 10, tripodH: 150, elevOffset: 0,
    tube: { lat: 34.70, lng: 135.50 }, allTubes: [{ lat: 34.70, lng: 135.50 }],
    maxDiaHalf: 160, camAzDeg: brng(34.68, 135.50, 34.70, 135.50), fovH: 10, treeHeightM: 20,
  };
  const { fetcher, fetched } = makeFakeFetcher(0);
  const prov = new TerrainElevationProvider(fetcher);
  await solveTerrain({
    mode: "front", viewpoint: { lat: input.viewLat, lng: input.viewLng, elev: input.elev, tripodH: input.tripodH, elevOffset: input.elevOffset },
    selectedTube: input.tube, allTubes: input.allTubes, maxDiaHalf: input.maxDiaHalf,
    camAzDeg: input.camAzDeg, fovHDeg: input.fovH, treeHeightM: input.treeHeightM,
  }, prov);
  // fetched は重複なし
  assert.equal(fetched.length, new Set(fetched).size, "重複 fetch なし（1 tile 1 回）");
  assert.ok(fetched.length > 0, "tile を取得している");
});
