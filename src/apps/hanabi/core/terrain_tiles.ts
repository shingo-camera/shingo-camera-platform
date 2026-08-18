/**
 * Terrain tile 取得・request 内 cache・同時接続制御・標高サンプリング（server 側）。
 *
 * - tile URL は server 側で固定生成（cold-snowflake-f232 公開 R2.dev）。client から任意 URL は渡せない。
 * - 同時 outgoing connection 上限 6 を踏まえ、fetch は最大 6 並列に制御（無制限 Promise.all 禁止）。
 * - request 内 tile cache（同一 tile の fetch/decode は 1 回だけ）。
 * - decode 済み tile のみ保持（圧縮 bytes / inflate buffer は decode 後に解放される）。
 *
 * 標高取得は client getElevFromR2 と同一（z=13・同一 tile/pixel 座標式・同一 decode）。
 */

import { decodeTerrainPng, elevFromPixel, PngError } from "./png";
import type { DecodedTile } from "./png";

// cold-snowflake-f232 公開 R2.dev（server 固定。client からの上書き不可）。
const DEM_TILE_URL = "https://pub-1ed8bf2d0ae64e1bb8602c7a30e60b5a.r2.dev";
const Z = 13;
const MAX_CONCURRENCY = 6; // Workers 同時 outgoing 接続上限。
const MAX_UNIQUE_TILES = 512; // 防御的上限（最大ケース 119 に十分な余裕。超過は fail-closed）。

export function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
}
export function latToTileY(lat: number, z: number): number {
  const r = Math.PI / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(lat * r) + 1 / Math.cos(lat * r)) / Math.PI) / 2) * Math.pow(2, z),
  );
}

// tile 取得結果の種別（HTTP failure と「本当に tile なし(no-data)」を分離）。
//  - "ok":      200。bytes を decode する。
//  - "nodata":  tile が存在しない（404）。no-data（海面/範囲外）として扱う（client parity）。
//  - "failure": 403/429/5xx 等の systemic 障害。R2 障害を「地形なし」と誤認しないため failure 扱い。
export type TileResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "nodata" }
  | { kind: "failure"; status: number };

export interface TileFetcher {
  // fetch 実体（テスト時に差し替え可能）。既定は global fetch で固定 URL を叩く。
  (z: number, x: number, y: number): Promise<TileResult>;
}

const defaultFetcher: TileFetcher = async (z, x, y) => {
  const url = `${DEM_TILE_URL}/${z}/${x}/${y}.png`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // ネットワーク例外は systemic failure（no-data と誤認しない）。
    return { kind: "failure", status: 0 };
  }
  if (res.status === 200) {
    const ab = await res.arrayBuffer();
    return { kind: "ok", bytes: new Uint8Array(ab) };
  }
  // 404 = tile が存在しない → no-data（現行 client parity: 範囲外は 0m 扱い）。
  // 410 Gone は「欠損 tile」と同義である実データ側の根拠が未確認のため no-data にしない（failure 扱い）。
  if (res.status === 404) {
    return { kind: "nodata" };
  }
  // 403 / 410 / 429 / 5xx 等 = systemic 障害 → failure（TERRAIN_UNAVAILABLE へ）。
  // systemic failure を「地形なし」と誤認しないことを優先する。
  return { kind: "failure", status: res.status };
};

/**
 * request 単位の tile 標高プロバイダ。
 * 1) 必要な (lat,lng) から必要 tile を集約 → 2) 6 並列で fetch+decode → 3) cache 参照で標高を返す。
 */
export class TerrainElevationProvider {
  private cache = new Map<string, DecodedTile | null>();
  private fetcher: TileFetcher;
  private failed = false;

  constructor(fetcher: TileFetcher = defaultFetcher) {
    this.fetcher = fetcher;
  }

  hadFailure(): boolean {
    return this.failed;
  }

  /** 与えられた座標群から必要 tile を求め、まだ無いものを 6 並列で取得・decode。 */
  async prefetch(coords: { lat: number; lng: number }[]): Promise<void> {
    const need = new Set<string>();
    for (const { lat, lng } of coords) {
      const tx = lngToTileX(lng, Z);
      const ty = latToTileY(lat, Z);
      const key = `${Z}/${tx}/${ty}`;
      if (!this.cache.has(key)) need.add(key);
    }
    if (need.size === 0) return;
    if (this.cache.size + need.size > MAX_UNIQUE_TILES) {
      this.failed = true;
      throw new PngError("too many unique tiles");
    }

    const keys = Array.from(need);
    let idx = 0;
    // 6 並列ワーカー（無制限 Promise.all は禁止）。
    const worker = async () => {
      for (;;) {
        const my = idx++;
        if (my >= keys.length) return;
        const key = keys[my];
        const [zs, xs, ys] = key.split("/");
        try {
          const r = await this.fetcher(Number(zs), Number(xs), Number(ys));
          if (r.kind === "nodata") {
            // 404 等 = tile が本当に存在しない → no-data（failure ではない）。
            this.cache.set(key, null);
            continue;
          }
          if (r.kind === "failure") {
            // 403/429/5xx 等 systemic 障害 → no-data として置きつつ failure フラグを立てる（fail-closed 対象）。
            this.cache.set(key, null);
            this.failed = true;
            continue;
          }
          // r.kind === "ok"
          const tile = await decodeTerrainPng(r.bytes);
          this.cache.set(key, tile);
        } catch {
          // decode 失敗（未対応 PNG 形式など）は「地形取得失敗」とみなし fail-closed 対象にする。
          this.cache.set(key, null);
          this.failed = true;
        }
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENCY, keys.length); i++) workers.push(worker());
    await Promise.all(workers);
  }

  /** cache 済み tile から標高[m]を返す（client getElevFromR2 と同一式）。未取得/no-data は null。 */
  getElev(lat: number, lng: number): number | null {
    const tx = lngToTileX(lng, Z);
    const ty = latToTileY(lat, Z);
    const key = `${Z}/${tx}/${ty}`;
    const tile = this.cache.get(key);
    if (!tile) return null;
    // client と同一の pixel 座標式
    const px = Math.floor(((lng + 180) / 360 * Math.pow(2, Z) - tx) * 256);
    const py = Math.floor(
      (((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2) *
        Math.pow(2, Z) -
        ty) *
        256,
    );
    return elevFromPixel(tile, px, py);
  }
}
