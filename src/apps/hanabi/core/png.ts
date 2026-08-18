/**
 * Terrain-RGB PNG デコーダ（Cloudflare Workers 互換・新規依存なし）。
 *
 * 対応範囲（防御的に厳格検証。範囲外は fail-closed）:
 *   - 8bit / color type 2(RGB) または 6(RGBA) / 非 interlace / 256x256（Terrain-RGB tile）。
 * inflate は Workers 標準の DecompressionStream('deflate')（zlib 互換）を使用。
 * scanline unfilter は None/Sub/Up/Average/Paeth を純 JS で実装。
 *
 * 実 tile の PNG 形式は未実測のため、IHDR（bit depth / color type / interlace / 寸法）を必ず検証し、
 * 対応範囲外なら例外（PngError）を投げる。未知形式を無理に decode しない。
 *
 * decode 仕様（client getElevFromR2 と同一・正本）:
 *   elevation = -10000 + (R*65536 + G*256 + B)*0.1
 *   RGB(0,0,0) → null（no-data）
 */

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngError";
  }
}

// 防御的上限（256x256 Terrain-RGB tile 想定。異常 PNG で memory/CPU を消費させない）。
const MAX_DIM = 256; // 想定 tile は 256x256。これを超える寸法は拒否。
const MAX_PNG_BYTES = 2 * 1024 * 1024; // 圧縮 PNG の最大許容（2MB。256x256 RGB は通常数十〜数百 KB）。
const MAX_INFLATED_BYTES = (MAX_DIM * MAX_DIM * 4) + MAX_DIM; // RGBA + 各行 filter byte 分の上限。

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export interface DecodedTile {
  w: number;
  h: number;
  ch: number; // 3(RGB) or 4(RGBA)
  data: Uint8Array; // w*h*ch, unfiltered
}

async function inflate(buf: Uint8Array): Promise<Uint8Array> {
  // Workers 標準 DecompressionStream('deflate') は zlib 形式（PNG IDAT）を解凍する。
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  const out = new Uint8Array(ab);
  if (out.length > MAX_INFLATED_BYTES) {
    throw new PngError("inflated data too large");
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Terrain-RGB PNG を decode。対応範囲外は PngError（fail-closed）。 */
export async function decodeTerrainPng(png: Uint8Array): Promise<DecodedTile> {
  if (png.length < 8 || png.length > MAX_PNG_BYTES) {
    throw new PngError("png size out of range");
  }
  for (let i = 0; i < 8; i++) {
    if (png[i] !== PNG_SIG[i]) throw new PngError("bad png signature");
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIHDR = false;
  const idatParts: Uint8Array[] = [];
  let idatTotal = 0;

  while (off + 8 <= png.length) {
    const len = view.getUint32(off);
    if (len > MAX_PNG_BYTES) throw new PngError("chunk length too large");
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > png.length) throw new PngError("truncated chunk");

    if (type === "IHDR") {
      if (len !== 13) throw new PngError("bad IHDR length");
      w = view.getUint32(dataStart);
      h = view.getUint32(dataStart + 4);
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
      // compression method (dataStart+10) は 0 のみ規定。filter method (dataStart+11) 0 のみ。
      interlace = png[dataStart + 12];
      sawIHDR = true;
      // ---- 厳格検証（対応範囲外は fail-closed）----
      if (w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM) {
        throw new PngError(`unsupported dimensions ${w}x${h}`);
      }
      if (bitDepth !== 8) throw new PngError(`unsupported bit depth ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) {
        throw new PngError(`unsupported color type ${colorType}`);
      }
      if (interlace !== 0) throw new PngError(`unsupported interlace ${interlace}`);
      if (png[dataStart + 10] !== 0) throw new PngError("unsupported compression method");
      if (png[dataStart + 11] !== 0) throw new PngError("unsupported filter method");
    } else if (type === "IDAT") {
      idatTotal += len;
      if (idatTotal > MAX_PNG_BYTES) throw new PngError("IDAT too large");
      idatParts.push(png.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    off = dataEnd + 4; // skip CRC
  }

  if (!sawIHDR) throw new PngError("missing IHDR");
  if (idatParts.length === 0) throw new PngError("missing IDAT");

  // IDAT 連結 → inflate
  let idat: Uint8Array;
  if (idatParts.length === 1) {
    idat = idatParts[0];
  } else {
    idat = new Uint8Array(idatTotal);
    let p = 0;
    for (const part of idatParts) {
      idat.set(part, p);
      p += part.length;
    }
  }
  const raw = await inflate(idat);

  const ch = colorType === 2 ? 3 : 4;
  const stride = w * ch;
  const expected = h * (stride + 1);
  if (raw.length < expected) throw new PngError("inflated data shorter than expected");

  // scanline unfilter（前行を保持しつつ in-place で復元）
  const out = new Uint8Array(h * stride);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    const ft = raw[rowStart];
    const src = rowStart + 1;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v: number;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new PngError(`unsupported filter type ${ft}`);
      }
      cur[i] = v & 255;
    }
    out.set(cur, y * stride);
    prev.set(cur);
  }

  return { w, h, ch, data: out };
}

/** decode 済み tile の pixel から標高[m]を返す（client 式と同一）。no-data は null。 */
export function elevFromPixel(tile: DecodedTile, px: number, py: number): number | null {
  const x = px < 0 ? 0 : px > tile.w - 1 ? tile.w - 1 : px;
  const y = py < 0 ? 0 : py > tile.h - 1 ? tile.h - 1 : py;
  const idx = (y * tile.w + x) * tile.ch;
  const r = tile.data[idx];
  const g = tile.data[idx + 1];
  const b = tile.data[idx + 2];
  if (r === 0 && g === 0 && b === 0) return null;
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}
