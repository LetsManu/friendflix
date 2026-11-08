// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone home carousel: the soft glow behind it, coloured from the centred poster. */

export type Rgb = [number, number, number];

/** sample size: 16×16 pixels are plenty for an average and cost nothing */
const SAMPLE = 16;

/**
 * Average colour of an already-loaded image (a 16×16 canvas sample, weighted by alpha). Null when the image is not decoded
 * yet, has no visible pixels, or the canvas is tainted (a cross-origin image without CORS): the glow then stays neutral.
 */
export function averageColor(img: HTMLImageElement): Rgb | null {
  try {
    if (!img.complete || !img.naturalWidth) return null;
    const c = document.createElement('canvas');
    c.width = SAMPLE; c.height = SAMPLE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const d = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data; // throws on a tainted canvas
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]! / 255;
      r += d[i]! * a; g += d[i + 1]! * a; b += d[i + 2]! * a; w += a;
    }
    if (w < 1) return null;
    return [Math.round(r / w), Math.round(g / w), Math.round(b / w)];
  } catch {
    return null;
  }
}

/** the page background (--bg) the glow fades into */
const BG = '#101418';

/**
 * CSS background for the glow layer: a radial bloom around the centred card over a vertical wash into the page. Without a
 * colour a neutral dark glow (no colour of its own, only hex greys).
 */
export function glowCss(rgb: Rgb | null): string {
  if (!rgb) return `radial-gradient(70% 55% at 50% 32%, #2a313aa6, transparent 70%), linear-gradient(180deg, #1a2027, ${BG} 85%)`;
  const c = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(',');
  return `radial-gradient(70% 55% at 50% 32%, rgba(${c},.65), transparent 70%), linear-gradient(180deg, rgba(${c},.25), ${BG} 85%)`;
}
