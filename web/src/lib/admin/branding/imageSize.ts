// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pixel size of a picked PNG, WebP or JPEG, read from its header without decoding it (Admin → Branding, imageResize.ts): a small,
 * highly compressed file can still be 50 000 px wide, and `createImageBitmap` would decode all of it before its size could be checked.
 * - PNG: the IHDR chunk right after the signature.
 * - WebP: the first chunk after RIFF/WEBP: VP8X (the canvas), VP8L (lossless) or VP8 (lossy key frame).
 * - JPEG: the segments are walked up to the first start-of-frame marker (SOF0–SOF15 but DHT, JPG and DAC).
 * Anything else, or a header cut short: null (the caller refuses it as unreadable).
 */

export interface ImageSize { type: 'png' | 'webp' | 'jpeg'; width: number; height: number }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);

function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { type: 'png', width: u32be(b, 16), height: u32be(b, 20) };
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') return { type: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    // a key frame: 3 bytes of frame tag, the start code 9d 01 2a, then 14-bit width and height (2 bits of scale above them)
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

/** the start-of-frame markers: C0–CF except C4 (DHT), C8 (JPG) and CC (DAC) */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function jpeg(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1]!;
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]!; } // fill bytes
    // markers without a length: TEM, RST0–7 (and a stray SOI)
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null; // the end, or the scan, before any frame header
    if (i + 3 >= b.length) return null;
    if (isSof(m)) {
      if (i + 8 >= b.length) return null;
      return { type: 'jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** the size in a file's first bytes (see the module comment); null when it is none of the three or cut short */
export function readImageSize(b: Uint8Array): ImageSize | null {
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return png(b);
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  return null;
}
