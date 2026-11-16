// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Branding uploads, prepared in the browser (branding stage A Task 4). The backend takes PNG or WebP only, at most 2 MB, and
 * checks the size of each kind (backend/src/brand/images.ts dimensionsOk); a picked file can be anything the browser decodes (a JPEG
 * photo, a large PNG). Every pick is drawn onto a canvas and re-encoded, which also drops any metadata it carried:
 * - the symbol: cover-cropped from the centre to exactly 512 × 512 (the manifest's icon size; the controller's ruling), refused under
 *   512 on its shorter side;
 * - the logo: fit within 2048 × 512; the sign-in image: fit within 2560 × 1600 (never upscaled).
 * The result is a PNG. A logo or sign-in photo whose PNG is over 2 MB is tried as WebP (where the browser encodes it), then drawn smaller
 * in steps of a fifth, until it fits (`encodeFitting`, unit-tested with a fake encoder). Before anything is decoded, the file's header
 * gives its size (imageSize.ts): a side over 12 000 px is refused without decoding it. The size maths is pure and unit-tested;
 * `prepareImage` needs a browser.
 */

import { readImageSize, type ImageSize } from './imageSize';

export type BrandImageKind = 'symbol' | 'logo' | 'signIn';

export const SYMBOL_SIZE = 512;
/** the boxes the logo and the sign-in image are fitted into (the backend's limits) */
export const IMAGE_BOX = { logo: { w: 2048, h: 512 }, signIn: { w: 2560, h: 1600 } } as const;
/** the backend's body limit (BRAND_IMAGE_MAX_BYTES) */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** a picked file larger than this is not even decoded (a phone photo is a few MB) */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** nor one with a side longer than this (a canvas of it would not fit in memory on a phone) */
export const MAX_SOURCE_SIDE = 12_000;

export interface DrawPlan { sx: number; sy: number; sw: number; sh: number; w: number; h: number }
export interface Size { w: number; h: number }

/** the centred square of a w × h picture, drawn at `size` × `size`; null when its shorter side is under `size` */
export function coverCrop(w: number, h: number, size = SYMBOL_SIZE): DrawPlan | null {
  const side = Math.min(w, h);
  if (!(side >= size)) return null;
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), sw: side, sh: side, w: size, h: size };
}

/** w × h scaled down (never up) to fit within maxW × maxH, keeping the aspect ratio; at least 1 px */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): Size {
  const f = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)) };
}

/** a fifth smaller (the next try for a picture whose encoding is over 2 MB) */
export const shrink = (s: Size): Size => ({ w: Math.max(1, Math.round(s.w * 0.8)), h: Math.max(1, Math.round(s.h * 0.8)) });

/** what to draw for a picked w × h picture of this kind */
export function plan(kind: BrandImageKind, w: number, h: number): DrawPlan | { error: 'small' } {
  if (kind === 'symbol') return coverCrop(w, h) ?? { error: 'small' };
  const box = IMAGE_BOX[kind];
  return { sx: 0, sy: 0, sw: w, sh: h, ...fitWithin(w, h, box.w, box.h) };
}

export type PrepareError = 'type' | 'read' | 'small' | 'large' | 'tooLarge';
export type Prepared = { ok: true; blob: Blob; width: number; height: number } | { ok: false; error: PrepareError; width?: number; height?: number };

/** the picked file types the page offers (SVG never: it can carry script) */
export const PICK_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/** draws a plan and encodes it as `type` (a canvas in the browser, a fake in the tests); null when the browser could not */
export type Encoder = (p: DrawPlan, type: 'image/png' | 'image/webp', quality?: number) => Promise<Blob | null>;

/**
 * The first encoding of `first` that fits in 2 MB: PNG; then (not the symbol) WebP at .9 and .8, then everything again a fifth smaller.
 * The browser's own type is checked (Safari answers a WebP request with a PNG). null: nothing fitted (or the picture is down to 1 px).
 */
export async function encodeFitting(first: DrawPlan, kind: BrandImageKind, enc: Encoder): Promise<{ blob: Blob; width: number; height: number } | null> {
  let p = first;
  for (let attempt = 0; attempt < 8; attempt++) {
    const png = await enc(p, 'image/png');
    if (png && png.type === 'image/png' && png.size <= MAX_UPLOAD_BYTES) return { blob: png, width: p.w, height: p.h };
    if (kind === 'symbol') break; // 512 × 512 always fits; nothing smaller is allowed
    for (const q of [0.9, 0.8]) {
      const webp = await enc(p, 'image/webp', q);
      if (webp && webp.type === 'image/webp' && webp.size <= MAX_UPLOAD_BYTES) return { blob: webp, width: p.w, height: p.h };
    }
    const s = shrink(p);
    if (s.w === p.w && s.h === p.h) break;
    p = { ...p, ...s };
  }
  return null;
}

/** the header's size of a picked file (the first 64 KB; a JPEG whose frame header lies further in: the whole file) */
async function headerSize(file: Blob): Promise<ImageSize | null> {
  const head = readImageSize(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
  if (head || file.size <= 65536) return head;
  return readImageSize(new Uint8Array(await file.arrayBuffer()));
}

/** draws `p` of `src` onto a fresh canvas of p.w × p.h (high-quality smoothing) */
function draw(src: CanvasImageSource, p: DrawPlan): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = p.w;
  c.height = p.h;
  const x = c.getContext('2d');
  if (!x) throw new Error('no 2d context');
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, p.sx, p.sy, p.sw, p.sh, 0, 0, p.w, p.h);
  return c;
}

/** the picked file as an upload: decoded, cropped or fitted, re-encoded (see the module comment) */
export async function prepareImage(file: File, kind: BrandImageKind): Promise<Prepared> {
  if (!(PICK_TYPES as readonly string[]).includes(file.type)) return { ok: false, error: 'type' };
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, error: 'large' };
  // the size from the header, before anything is decoded
  let head: ImageSize | null;
  try {
    head = await headerSize(file);
  } catch {
    head = null;
  }
  if (!head) return { ok: false, error: 'read' };
  if (head.width > MAX_SOURCE_SIDE || head.height > MAX_SOURCE_SIDE) return { ok: false, error: 'large', width: head.width, height: head.height };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { ok: false, error: 'read' };
  }
  try {
    const { width, height } = bmp;
    if (width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE) return { ok: false, error: 'large', width, height };
    const first = plan(kind, width, height);
    if ('error' in first) return { ok: false, error: 'small', width, height };
    // one canvas per size: the PNG and both WebP tries of a size share it
    let canvas: HTMLCanvasElement | null = null, drawn: DrawPlan | null = null;
    const enc: Encoder = (p, type, quality) => {
      if (!canvas || drawn !== p) { canvas = draw(bmp, p); drawn = p; }
      return encode(canvas, type, quality);
    };
    const out = await encodeFitting(first, kind, enc);
    return out ? { ok: true, ...out } : { ok: false, error: 'tooLarge' };
  } catch {
    return { ok: false, error: 'read' };
  } finally {
    bmp.close();
  }
}
