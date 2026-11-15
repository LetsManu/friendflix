// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/**
 * Uploaded brand images (branding plan Task 1, Global Constraints "Images"). The admin's browser already re-encodes them (canvas → PNG);
 * the server trusts nothing of that: it accepts PNG or WebP only, walks the container chunk by chunk with every declared length checked
 * against the buffer, refuses anything structurally off (bad CRC, truncation, bytes after the end, an unknown critical chunk, a header
 * that lies about its length) and rebuilds the file from an allow-list of chunks, so metadata (text, EXIF, XMP, ICC profiles) never
 * reaches the public route. PNG pixel data is inflated once (bounded by the size the header implies) to prove it is what it claims.
 * No image library: the backend has none and the plan adds none.
 */

export type BrandImageKind = 'symbol' | 'logo' | 'signIn';
export const BRAND_IMAGE_KINDS: readonly BrandImageKind[] = ['symbol', 'logo', 'signIn'];
export type BrandImageMime = 'image/png' | 'image/webp';
export const BRAND_IMAGE_MIMES: readonly BrandImageMime[] = ['image/png', 'image/webp'];
/** the largest upload (as uploaded, before sanitizing) */
export const BRAND_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export type BrandImageErrorCode = 'type' | 'size' | 'dimensions' | 'corrupt';
export class BrandImageError extends Error {
  constructor(readonly code: BrandImageErrorCode) {
    super(code);
    this.name = 'BrandImageError';
  }
}

export interface SanitizedImage { bytes: Buffer; mime: BrandImageMime; width: number; height: number; hash: string }

/**
 * Whether an image of w × h may serve as `kind`: the symbol is square, 512–2048 px (the upper bound keeps the pixel check bounded); the
 * logo at most 2048 × 512; the sign-in image at most 2560 × 1600.
 */
export function dimensionsOk(kind: BrandImageKind, w: number, h: number): boolean {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return false;
  if (kind === 'symbol') return w === h && w >= 512 && w <= 2048;
  if (kind === 'logo') return w <= 2048 && h <= 512;
  return w <= 2560 && h <= 1600;
}

const corrupt = () => new BrandImageError('corrupt');

/** the sanitized image, or a BrandImageError (`size` before anything is parsed, `type` for anything but PNG / WebP) */
export function sanitizeImage(buf: Buffer, kind: BrandImageKind): SanitizedImage {
  if (buf.length > BRAND_IMAGE_MAX_BYTES) throw new BrandImageError('size');
  let out: Omit<SanitizedImage, 'hash'>;
  if (isPng(buf)) out = sanitizePng(buf, kind);
  else if (isWebp(buf)) out = sanitizeWebp(buf, kind);
  else throw new BrandImageError('type');
  return { ...out, hash: createHash('sha256').update(out.bytes).digest('hex') };
}

/** the type by magic bytes (null: neither PNG nor WebP) */
export function sniffBrandImage(buf: Buffer): BrandImageMime | null {
  return isPng(buf) ? 'image/png' : isWebp(buf) ? 'image/webp' : null;
}

// ---- PNG ----

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG);

/** the chunks that survive; every other ancillary chunk is dropped, every other critical chunk refused */
const PNG_KEEP: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM']);
/** allowed bit depths per colour type, and the samples per pixel */
const PNG_DEPTHS: Record<number, { depths: number[]; channels: number }> = {
  0: { depths: [1, 2, 4, 8, 16], channels: 1 },
  2: { depths: [8, 16], channels: 3 },
  3: { depths: [1, 2, 4, 8], channels: 1 },
  4: { depths: [8, 16], channels: 2 },
  6: { depths: [8, 16], channels: 4 },
};
/** Adam7: x start, y start, x step, y step */
const ADAM7: ReadonlyArray<[number, number, number, number]> = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface PngChunk { type: string; raw: Buffer; data: Buffer }

function sanitizePng(buf: Buffer, kind: BrandImageKind): Omit<SanitizedImage, 'hash'> {
  const chunks: PngChunk[] = [];
  let o = 8;
  for (;;) {
    if (o + 12 > buf.length) throw corrupt();
    const len = buf.readUInt32BE(o);
    if (len > 0x7fffffff || len > buf.length - o - 12) throw corrupt();
    const type = buf.toString('latin1', o + 4, o + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw corrupt();
    if (buf.readUInt32BE(o + 8 + len) !== crc32(buf.subarray(o + 4, o + 8 + len))) throw corrupt();
    chunks.push({ type, raw: buf.subarray(o, o + 12 + len), data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === 'IEND') break;
  }
  // nothing may follow IEND (a polyglot's second file would)
  if (o !== buf.length) throw corrupt();

  const head = chunks[0]!;
  if (head.type !== 'IHDR' || head.data.length !== 13) throw corrupt();
  const width = head.data.readUInt32BE(0);
  const height = head.data.readUInt32BE(4);
  const [depth, color, compression, filter, interlace] = [head.data[8]!, head.data[9]!, head.data[10]!, head.data[11]!, head.data[12]!];
  const fmt = PNG_DEPTHS[color];
  if (width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) throw corrupt();
  if (!fmt || !fmt.depths.includes(depth) || compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) throw corrupt();
  if (chunks.at(-1)!.data.length !== 0) throw corrupt();

  const kept: Buffer[] = [];
  const idat: Buffer[] = [];
  const seen = new Set<string>();
  let prev = '';
  let paletteEntries = 0;
  for (const c of chunks) {
    const critical = c.type.charCodeAt(0) < 0x61; // upper-case first letter
    if (!PNG_KEEP.has(c.type)) {
      if (critical) throw corrupt();
      prev = c.type;
      continue;
    }
    if (c.type === 'IDAT') {
      if (seen.has('IDAT') && prev !== 'IDAT') throw corrupt(); // IDATs are consecutive
      idat.push(c.data);
    } else {
      if (seen.has(c.type)) throw corrupt(); // each other kept chunk at most once
      if (c.type !== 'IHDR' && c.type !== 'IEND' && seen.has('IDAT')) throw corrupt(); // palette, transparency and colour info precede the pixels
      if (c.type === 'PLTE') {
        // 1–256 entries of 3 bytes; a palette image's PLTE has no more entries than its bit depth can index
        if (color === 0 || color === 4 || c.data.length === 0 || c.data.length % 3 !== 0 || c.data.length > 768) throw corrupt();
        paletteEntries = c.data.length / 3;
        if (color === 3 && paletteEntries > 1 << depth) throw corrupt();
      }
      // transparency: one 2-byte grey sample, one 6-byte RGB sample, or 1 alpha byte per palette entry at most; none with an alpha channel
      if (c.type === 'tRNS' && !trnsOk(color, c.data.length, seen.has('PLTE') ? paletteEntries : 0)) throw corrupt();
      if ((c.type === 'sRGB' && c.data.length !== 1) || (c.type === 'gAMA' && c.data.length !== 4) || (c.type === 'cHRM' && c.data.length !== 32)) throw corrupt();
    }
    seen.add(c.type);
    prev = c.type;
    kept.push(c.raw);
  }
  if (!idat.length || (color === 3 && !seen.has('PLTE'))) throw corrupt();
  if (!dimensionsOk(kind, width, height)) throw new BrandImageError('dimensions');
  checkPixels(Buffer.concat(idat), width, height, depth * fmt.channels, interlace === 1);
  return { bytes: Buffer.concat([PNG_SIG, ...kept]), mime: 'image/png', width, height };
}

/** whether a tRNS of `len` bytes suits the colour type (palette: after the PLTE, at most one byte per entry) */
function trnsOk(color: number, len: number, paletteEntries: number): boolean {
  if (color === 0) return len === 2;
  if (color === 2) return len === 6;
  if (color === 3) return len >= 1 && len <= paletteEntries;
  return false;
}

/**
 * The filtered scanlines inflate to exactly the size the header implies, the zlib stream ends exactly at the end of the IDAT data
 * (nothing rides behind it: no second stream, no appended file), and every row's filter type is 0–4.
 */
function checkPixels(z: Buffer, w: number, h: number, bitsPerPixel: number, interlaced: boolean): void {
  const passes = interlaced
    ? ADAM7.map(([xs, ys, dx, dy]) => [w > xs ? Math.ceil((w - xs) / dx) : 0, h > ys ? Math.ceil((h - ys) / dy) : 0] as const)
    : [[w, h] as const];
  const rows: number[] = []; // the byte length of each row, filter byte included
  let expected = 0;
  for (const [pw, ph] of passes) {
    if (!pw || !ph) continue;
    const rb = 1 + Math.ceil((pw * bitsPerPixel) / 8);
    for (let y = 0; y < ph; y++) rows.push(rb);
    expected += rb * ph;
  }
  let raw: Buffer;
  let consumed: number;
  try {
    // info: the engine reports how many input bytes the stream used (inflate stops at the stream's end and ignores the rest)
    const r = inflateSync(z, { maxOutputLength: expected, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    raw = r.buffer;
    consumed = r.engine.bytesWritten;
  } catch {
    throw corrupt();
  }
  if (raw.length !== expected || consumed !== z.length) throw corrupt();
  let at = 0;
  for (const rb of rows) {
    if (raw[at]! > 4) throw corrupt();
    at += rb;
  }
}

// ---- WebP ----

const isWebp = (b: Buffer) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';

const VP8X_ICC = 0x20, VP8X_ALPHA = 0x10, VP8X_EXIF = 0x08, VP8X_XMP = 0x04, VP8X_ANIM = 0x02;

interface RiffChunk { fourcc: string; data: Buffer }

/** the chunks of a RIFF body from `start` to the end of `buf`, every length checked (an odd chunk carries its pad byte) */
function riffChunks(buf: Buffer, start: number): RiffChunk[] {
  const out: RiffChunk[] = [];
  for (let o = start; o < buf.length;) {
    if (o + 8 > buf.length) throw corrupt();
    const fourcc = buf.toString('latin1', o, o + 4);
    if (!/^[\x20-\x7e]{4}$/.test(fourcc)) throw corrupt();
    const size = buf.readUInt32LE(o + 4);
    const padded = size + (size & 1);
    if (padded > buf.length - o - 8) throw corrupt();
    out.push({ fourcc, data: buf.subarray(o + 8, o + 8 + size) });
    o += 8 + padded;
  }
  return out;
}

function riffChunk(c: RiffChunk): Buffer {
  const h = Buffer.alloc(8);
  h.write(c.fourcc, 0, 'latin1');
  h.writeUInt32LE(c.data.length, 4);
  return Buffer.concat([h, c.data, c.data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** the size of a VP8 (lossy key frame) or VP8L (lossless) bitstream, from its header */
function bitstreamSize(c: RiffChunk): [number, number] {
  const d = c.data;
  if (c.fourcc === 'VP8 ') {
    if (d.length < 10) throw corrupt();
    const tag = d[0]! | (d[1]! << 8) | (d[2]! << 16);
    if ((tag & 1) !== 0 || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw corrupt(); // a key frame with its start code
    if (10 + (tag >>> 5) > d.length) throw corrupt(); // the first partition lies inside the chunk
    const w = d.readUInt16LE(6) & 0x3fff, h = d.readUInt16LE(8) & 0x3fff;
    if (!w || !h) throw corrupt();
    return [w, h];
  }
  if (d.length < 5 || d[0] !== 0x2f) throw corrupt();
  const bits = d.readUInt32LE(1);
  if (bits >>> 29 !== 0) throw corrupt(); // version 0
  return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
}

const isBitstream = (c: RiffChunk) => c.fourcc === 'VP8 ' || c.fourcc === 'VP8L';

/** a still image's chunks (an optional ALPH before a VP8, then the VP8 / VP8L): the kept ones in order and the size */
function stillImage(chunks: RiffChunk[]): { kept: RiffChunk[]; size: [number, number] } {
  const img = chunks.filter(isBitstream);
  const alph = chunks.filter((c) => c.fourcc === 'ALPH');
  if (img.length !== 1 || alph.length > 1) throw corrupt();
  if (alph.length && (img[0]!.fourcc !== 'VP8 ' || chunks.indexOf(alph[0]!) > chunks.indexOf(img[0]!))) throw corrupt();
  return { kept: [...alph, img[0]!], size: bitstreamSize(img[0]!) };
}

function sanitizeWebp(buf: Buffer, kind: BrandImageKind): Omit<SanitizedImage, 'hash'> {
  // the RIFF size covers exactly the rest of the buffer: no truncation, nothing appended
  if (buf.readUInt32LE(4) !== buf.length - 8) throw corrupt();
  const chunks = riffChunks(buf, 12);
  const first = chunks[0];
  if (!first) throw corrupt();
  let kept: RiffChunk[];
  let width: number, height: number;
  if (isBitstream(first)) {
    // the simple format: one bitstream chunk (anything else in such a file is dropped; a second image chunk is refused)
    if (chunks.some((c) => c !== first && (isBitstream(c) || c.fourcc === 'ALPH' || c.fourcc === 'VP8X' || c.fourcc === 'ANIM' || c.fourcc === 'ANMF'))) throw corrupt();
    [width, height] = bitstreamSize(first);
    kept = [first];
  } else if (first.fourcc === 'VP8X') {
    if (first.data.length !== 10) throw corrupt();
    const flags = first.data[0]!;
    width = first.data.readUIntLE(4, 3) + 1;
    height = first.data.readUIntLE(7, 3) + 1;
    const rest = chunks.slice(1);
    if (rest.some((c) => c.fourcc === 'VP8X')) throw corrupt();
    let body: RiffChunk[];
    if (flags & VP8X_ANIM) {
      if (rest.some((c) => isBitstream(c) || c.fourcc === 'ALPH')) throw corrupt();
      const anim = rest.filter((c) => c.fourcc === 'ANIM');
      const frames = rest.filter((c) => c.fourcc === 'ANMF');
      if (anim.length !== 1 || anim[0]!.data.length !== 6 || !frames.length || rest.indexOf(anim[0]!) > rest.indexOf(frames[0]!)) throw corrupt();
      body = [anim[0]!, ...frames.map((f) => frame(f, width, height))];
    } else {
      if (rest.some((c) => c.fourcc === 'ANIM' || c.fourcc === 'ANMF')) throw corrupt();
      const still = stillImage(rest);
      if (still.size[0] !== width || still.size[1] !== height) throw corrupt();
      body = still.kept;
    }
    // the flags of the dropped chunks (ICC, EXIF, XMP) and the reserved bits are cleared; alpha and animation stay
    const vp8x = Buffer.alloc(10);
    first.data.copy(vp8x, 4, 4, 10);
    vp8x[0] = flags & ~(VP8X_ICC | VP8X_EXIF | VP8X_XMP) & (VP8X_ALPHA | VP8X_ANIM);
    kept = [{ fourcc: 'VP8X', data: vp8x }, ...body];
  } else {
    throw corrupt();
  }
  if (!dimensionsOk(kind, width, height)) throw new BrandImageError('dimensions');
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...kept.map(riffChunk)]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return { bytes: Buffer.concat([head, body]), mime: 'image/webp', width, height };
}

/** an animation frame: its 16-byte header (inside the canvas) and its image sub-chunks only (anything else in it is dropped) */
function frame(f: RiffChunk, cw: number, ch: number): RiffChunk {
  const d = f.data;
  if (d.length < 16) throw corrupt();
  const x = d.readUIntLE(0, 3) * 2, y = d.readUIntLE(3, 3) * 2;
  const fw = d.readUIntLE(6, 3) + 1, fh = d.readUIntLE(9, 3) + 1;
  if (x + fw > cw || y + fh > ch) throw corrupt();
  const still = stillImage(riffChunks(d, 16));
  if (still.size[0] !== fw || still.size[1] !== fh) throw corrupt();
  return { fourcc: 'ANMF', data: Buffer.concat([d.subarray(0, 16), ...still.kept.map(riffChunk)]) };
}
