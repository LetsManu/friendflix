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
 * in steps of a fifth, until it fits. The size maths is pure and unit-tested; `prepareImage` needs a browser.
 */

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
    let p = first;
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = draw(bmp, p);
      const png = await encode(canvas, 'image/png');
      if (png && png.type === 'image/png' && png.size <= MAX_UPLOAD_BYTES) return { ok: true, blob: png, width: p.w, height: p.h };
      if (kind === 'symbol') break; // 512 × 512 always fits; nothing smaller is allowed
      for (const q of [0.9, 0.8]) {
        const webp = await encode(canvas, 'image/webp', q);
        if (webp && webp.type === 'image/webp' && webp.size <= MAX_UPLOAD_BYTES) return { ok: true, blob: webp, width: p.w, height: p.h };
      }
      const s = shrink(p);
      if (s.w === p.w && s.h === p.h) break;
      p = { ...p, ...s };
    }
    return { ok: false, error: 'tooLarge' };
  } catch {
    return { ok: false, error: 'read' };
  } finally {
    bmp.close();
  }
}
