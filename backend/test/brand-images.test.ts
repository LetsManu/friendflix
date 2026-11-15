// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BRAND_IMAGE_MAX_BYTES, BrandImageError, sanitizeImage, type BrandImageKind } from '../src/brand/images.js';

// Branding stage A, Task 1: uploaded brand images are PNG or WebP, rebuilt chunk by chunk from an allow-list (metadata dropped), with
// every length checked against the buffer. The fixtures are built here (zlib + an own CRC), never taken from the code under test.

// ---- PNG fixtures ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer, badCrc = false): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(td) ^ (badCrc ? 1 : 0)) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function ihdr(w: number, h: number, colorType = 2, depth = 8): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = depth; d[9] = colorType; d[10] = 0; d[11] = 0; d[12] = 0;
  return d;
}
/** an RGB 8-bit PNG of w × h black pixels; `before` / `after` are chunks placed before / after the IDAT */
function png(w: number, h: number, o: { before?: Buffer[]; after?: Buffer[]; idat?: Buffer } = {}): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3));
  return Buffer.concat([SIG, chunk('IHDR', ihdr(w, h)), ...(o.before ?? []), chunk('IDAT', o.idat ?? deflateSync(raw)), ...(o.after ?? []), chunk('IEND', Buffer.alloc(0))]);
}
/** the chunk types of a PNG, walked independently of the code under test */
function pngChunks(b: Buffer): string[] {
  expect(b.subarray(0, 8)).toEqual(SIG);
  const out: string[] = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o);
    const type = b.toString('latin1', o + 4, o + 8);
    expect(b.readUInt32BE(o + 8 + len)).toBe(crc32(b.subarray(o + 4, o + 8 + len)));
    out.push(type);
    o += 12 + len;
  }
  return out;
}
const text = (k: string, v: string) => chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1'));

// ---- WebP fixtures ----
/** a known 1×1 lossless WebP (the common smallest-WebP byte string) */
const WEBP_1X1 = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
function riffChunk(fourcc: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const h = Buffer.alloc(8);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}
/** the VP8L chunk (header + payload) of the known 1×1 image */
const VP8L_1X1 = WEBP_1X1.subarray(12);
function vp8x(flags: number, w: number, h: number): Buffer {
  const d = Buffer.alloc(10);
  d[0] = flags;
  d.writeUIntLE(w - 1, 4, 3);
  d.writeUIntLE(h - 1, 7, 3);
  return riffChunk('VP8X', d);
}
/** a lossy VP8 key frame header for w × h (plus filler: only the header is parsed) */
function vp8(w: number, h: number): Buffer {
  const d = Buffer.alloc(30);
  d.writeUIntLE(0x10 | (20 << 5), 0, 3); // key frame (bit 0 = 0), version 0, show_frame, first partition size 20
  d[3] = 0x9d; d[4] = 0x01; d[5] = 0x2a;
  d.writeUInt16LE(w, 6);
  d.writeUInt16LE(h, 8);
  return riffChunk('VP8 ', d);
}
function webpChunks(b: Buffer): string[] {
  expect(b.toString('latin1', 0, 4)).toBe('RIFF');
  expect(b.readUInt32LE(4) + 8).toBe(b.length);
  expect(b.toString('latin1', 8, 12)).toBe('WEBP');
  const out: string[] = [];
  for (let o = 12; o < b.length;) {
    const len = b.readUInt32LE(o + 4);
    out.push(b.toString('latin1', o, o + 4));
    o += 8 + len + (len % 2);
  }
  return out;
}

function refused(buf: Buffer, kind: BrandImageKind = 'logo'): string {
  try {
    sanitizeImage(buf, kind);
  } catch (e) {
    expect(e).toBeInstanceOf(BrandImageError);
    return (e as BrandImageError).code;
  }
  throw new Error('accepted');
}

describe('PNG', () => {
  it('a tEXt chunk is stripped and the result is still a valid PNG (so are eXIf, iTXt, zTXt, iCCP, tIME and APNG chunks)', () => {
    const meta = [text('Comment', '<script>alert(1)</script>'), chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>')), chunk('zTXt', Buffer.from('k\0\0x')),
      chunk('iCCP', Buffer.from('icc\0\0xx')), chunk('tIME', Buffer.alloc(7)), chunk('acTL', Buffer.alloc(8))];
    const src = png(4, 2, { before: [chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])), chunk('sRGB', Buffer.from([0])), ...meta], after: [chunk('eXIf', Buffer.from('MM\0*GPS'))] });
    const out = sanitizeImage(src, 'logo');
    expect(pngChunks(out.bytes)).toEqual(['IHDR', 'gAMA', 'sRGB', 'IDAT', 'IEND']);
    expect(out.bytes.includes(Buffer.from('script'))).toBe(false);
    expect(out.bytes.includes(Buffer.from('GPS'))).toBe(false);
    expect([out.mime, out.width, out.height]).toEqual(['image/png', 4, 2]);
    // the pixels are untouched and the result passes the sanitizer again unchanged
    const idat = out.bytes.subarray(8 + 25 + 16 + 13 + 8, out.bytes.length - 12 - 4);
    expect(inflateSync(idat).length).toBe(2 * (1 + 4 * 3));
    expect(sanitizeImage(out.bytes, 'logo').bytes).toEqual(out.bytes);
  });

  it('keeps PLTE and tRNS of a palette image, and split IDATs', () => {
    const raw = Buffer.alloc(2 * (1 + 2));
    const z = deflateSync(raw);
    const src = Buffer.concat([SIG, chunk('IHDR', ihdr(2, 2, 3)), chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])), chunk('tRNS', Buffer.from([0])),
      chunk('IDAT', z.subarray(0, 3)), chunk('IDAT', z.subarray(3)), chunk('IEND', Buffer.alloc(0))]);
    expect(pngChunks(sanitizeImage(src, 'logo').bytes)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IDAT', 'IEND']);
  });

  it('a bad CRC is corrupt', () => {
    expect(refused(png(4, 2, { before: [chunk('tEXt', Buffer.from('a\0b'), true)] }))).toBe('corrupt');
    const b = png(4, 2);
    b[b.length - 20] ^= 0xff; // inside the IDAT
    expect(refused(b)).toBe('corrupt');
  });

  it('a PNG signature followed by <svg (or HTML) is corrupt', () => {
    expect(refused(Buffer.concat([SIG, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')]))).toBe('corrupt');
    expect(refused(Buffer.concat([SIG, Buffer.from('<html><script>alert(1)</script></html>')]))).toBe('corrupt');
  });

  it('structural lies are corrupt: a wrong IHDR length, truncation, data after IEND, an unknown critical chunk, no IDAT, bad pixels', () => {
    const shortIhdr = Buffer.concat([SIG, chunk('IHDR', ihdr(4, 2).subarray(0, 12)), chunk('IDAT', deflateSync(Buffer.alloc(26))), chunk('IEND', Buffer.alloc(0))]);
    expect(refused(shortIhdr)).toBe('corrupt');
    const ok = png(4, 2);
    expect(refused(ok.subarray(0, ok.length - 5))).toBe('corrupt'); // truncated IEND
    expect(refused(ok.subarray(0, 8 + 25 + 6))).toBe('corrupt'); // cut inside the IDAT
    expect(refused(Buffer.concat([ok, Buffer.from('<svg/>')]))).toBe('corrupt'); // a polyglot tail
    expect(refused(png(4, 2, { before: [chunk('ABCD', Buffer.alloc(2))] }))).toBe('corrupt');
    expect(refused(Buffer.concat([SIG, chunk('IHDR', ihdr(4, 2)), chunk('IEND', Buffer.alloc(0))]))).toBe('corrupt');
    expect(refused(png(4, 2, { idat: Buffer.from('not zlib at all') }))).toBe('corrupt');
    expect(refused(png(4, 2, { idat: deflateSync(Buffer.alloc(5)) }))).toBe('corrupt'); // too few pixels
    expect(refused(png(4, 2, { before: [chunk('IHDR', ihdr(4, 2))] }))).toBe('corrupt'); // a second IHDR
    // a chunk length far beyond the buffer (the classic over-read)
    const huge = Buffer.from(ok);
    huge.writeUInt32BE(0x7ffffff0, 8 + 25);
    expect(refused(huge)).toBe('corrupt');
    // invalid header fields: zero width, a bad bit depth for the colour type, an unknown filter method
    expect(refused(Buffer.concat([SIG, chunk('IHDR', ihdr(0, 2)), chunk('IDAT', deflateSync(Buffer.alloc(2))), chunk('IEND', Buffer.alloc(0))]))).toBe('corrupt');
    expect(refused(Buffer.concat([SIG, chunk('IHDR', ihdr(4, 2, 2, 4)), chunk('IDAT', deflateSync(Buffer.alloc(26))), chunk('IEND', Buffer.alloc(0))]))).toBe('corrupt');
    const f = ihdr(4, 2); f[11] = 1;
    expect(refused(Buffer.concat([SIG, chunk('IHDR', f), chunk('IDAT', deflateSync(Buffer.alloc(26))), chunk('IEND', Buffer.alloc(0))]))).toBe('corrupt');
  });

  it('header dimensions far beyond the limits are refused before any pixel is inflated', () => {
    expect(refused(Buffer.concat([SIG, chunk('IHDR', ihdr(60000, 60000)), chunk('IDAT', deflateSync(Buffer.alloc(10))), chunk('IEND', Buffer.alloc(0))]), 'signIn')).toBe('dimensions');
  });
});

describe('type, size and dimensions', () => {
  it('a JPEG, a GIF, an SVG or an empty body is the wrong type', () => {
    expect(refused(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]))).toBe('type');
    expect(refused(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'))).toBe('type');
    expect(refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('type');
    expect(refused(Buffer.alloc(0))).toBe('type');
    expect(refused(Buffer.from('RIFF\x04\x00\x00\x00WAVE', 'latin1'))).toBe('type');
  });

  it('a 3 MB body is too big (checked before anything is parsed)', () => {
    expect(BRAND_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(refused(Buffer.concat([SIG, Buffer.alloc(3 * 1024 * 1024)]))).toBe('size');
    expect(refused(Buffer.alloc(BRAND_IMAGE_MAX_BYTES + 1))).toBe('size');
  });

  it('symbol: square and at least 512 px; logo up to 2048 × 512; sign-in image up to 2560 × 1600', () => {
    expect(refused(png(300, 300), 'symbol')).toBe('dimensions');
    expect(refused(png(512, 600), 'symbol')).toBe('dimensions');
    expect(sanitizeImage(png(512, 512), 'symbol')).toMatchObject({ width: 512, height: 512 });
    expect(refused(png(2049, 100), 'logo')).toBe('dimensions');
    expect(refused(png(100, 513), 'logo')).toBe('dimensions');
    expect(sanitizeImage(png(2048, 512), 'logo')).toMatchObject({ width: 2048, height: 512 });
    expect(refused(png(2561, 10), 'signIn')).toBe('dimensions');
    expect(refused(png(10, 1601), 'signIn')).toBe('dimensions');
    expect(sanitizeImage(png(2560, 1600), 'signIn')).toMatchObject({ width: 2560, height: 1600 });
  });
});

describe('WebP', () => {
  it('the known 1×1 lossless image passes unchanged', () => {
    const out = sanitizeImage(WEBP_1X1, 'logo');
    expect([out.mime, out.width, out.height]).toEqual(['image/webp', 1, 1]);
    expect(out.bytes).toEqual(WEBP_1X1);
  });

  it('EXIF, XMP and ICCP are stripped and the VP8X flags cleared', () => {
    const exif = riffChunk('EXIF', Buffer.from('MM\0*\0\0\0\x08GPS-SECRET', 'latin1'));
    const xmp = riffChunk('XMP ', Buffer.from('<x:xmpmeta>author-secret</x:xmpmeta>'));
    const icc = riffChunk('ICCP', Buffer.from('icc-profile'));
    const src = riff([vp8x(0x20 | 0x10 | 0x08 | 0x04, 1, 1), icc, VP8L_1X1, exif, xmp]);
    const out = sanitizeImage(src, 'logo');
    expect(webpChunks(out.bytes)).toEqual(['VP8X', 'VP8L']);
    expect(out.bytes[20]! & (0x20 | 0x08 | 0x04)).toBe(0); // ICC, EXIF and XMP flags
    expect(out.bytes[20]! & 0x10).toBe(0x10); // the alpha flag stays
    for (const s of ['GPS-SECRET', 'author-secret', 'icc-profile']) expect(out.bytes.includes(Buffer.from(s))).toBe(false);
    expect([out.width, out.height]).toEqual([1, 1]);
  });

  it('reads a lossy VP8 frame\'s size, and a VP8X canvas must agree with its image', () => {
    expect(sanitizeImage(riff([vp8(640, 640)]), 'symbol')).toMatchObject({ width: 640, height: 640, mime: 'image/webp' });
    expect(refused(riff([vp8(300, 300)]), 'symbol')).toBe('dimensions');
    expect(refused(riff([vp8x(0, 2, 2), VP8L_1X1]))).toBe('corrupt');
  });

  it('structural lies are corrupt: RIFF size, chunk length past the end, no image, trailing bytes, a broken VP8L header', () => {
    const big = Buffer.from(WEBP_1X1);
    big.writeUInt32LE(0x7ffffff0, 4);
    expect(refused(big)).toBe('corrupt');
    const past = Buffer.from(WEBP_1X1);
    past.writeUInt32LE(0x7ffffff0, 16);
    expect(refused(past)).toBe('corrupt');
    expect(refused(riff([riffChunk('EXIF', Buffer.from('x'))]))).toBe('corrupt');
    expect(refused(riff([vp8x(0, 1, 1)]))).toBe('corrupt');
    expect(refused(Buffer.concat([WEBP_1X1, Buffer.from('<svg/>')]))).toBe('corrupt');
    const sig = Buffer.from(WEBP_1X1);
    sig[20] = 0x2e; // the VP8L signature byte
    expect(refused(sig)).toBe('corrupt');
    expect(refused(WEBP_1X1.subarray(0, 18))).toBe('corrupt');
  });
});

it('the hash is the sha256 of the sanitized bytes (not of the upload)', () => {
  const src = png(4, 2, { before: [text('Author', 'someone')] });
  const out = sanitizeImage(src, 'logo');
  expect(out.hash).toBe(createHash('sha256').update(out.bytes).digest('hex'));
  expect(out.hash).not.toBe(createHash('sha256').update(src).digest('hex'));
  expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
});
