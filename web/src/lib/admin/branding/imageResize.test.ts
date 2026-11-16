// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { IMAGE_BOX, MAX_UPLOAD_BYTES, SYMBOL_SIZE, coverCrop, encodeFitting, fitWithin, plan, shrink, type DrawPlan, type Encoder } from './imageResize';

describe('symbol: cover-crop to 512 × 512', () => {
  it('1000 × 600: the centred 600 × 600 square, drawn at 512', () => {
    expect(coverCrop(1000, 600)).toEqual({ sx: 200, sy: 0, sw: 600, sh: 600, w: 512, h: 512 });
  });
  it('600 × 1000: centred vertically', () => {
    expect(coverCrop(600, 1000)).toEqual({ sx: 0, sy: 200, sw: 600, sh: 600, w: 512, h: 512 });
  });
  it('exactly 512 is kept as is', () => {
    expect(coverCrop(512, 512)).toEqual({ sx: 0, sy: 0, sw: 512, sh: 512, w: 512, h: 512 });
  });
  it('400 × 400 is refused (under 512)', () => {
    expect(coverCrop(400, 400)).toBeNull();
    expect(coverCrop(2000, 500)).toBeNull();
    expect(plan('symbol', 400, 400)).toEqual({ error: 'small' });
  });
  it('the symbol is always 512 (the manifest icon size)', () => {
    expect(SYMBOL_SIZE).toBe(512);
    expect(plan('symbol', 3000, 2000)).toEqual({ sx: 500, sy: 0, sw: 2000, sh: 2000, w: 512, h: 512 });
  });
});

describe('logo and sign-in image: fit within their box, never upscaled', () => {
  it('the boxes are the backend\'s limits', () => {
    expect(IMAGE_BOX).toEqual({ logo: { w: 2048, h: 512 }, signIn: { w: 2560, h: 1600 } });
    expect(MAX_UPLOAD_BYTES).toBe(2 * 1024 * 1024);
  });
  it('fitWithin keeps the aspect ratio', () => {
    expect(fitWithin(4096, 1024, 2048, 512)).toEqual({ w: 2048, h: 512 });
    expect(fitWithin(1000, 1000, 2048, 512)).toEqual({ w: 512, h: 512 });
    expect(fitWithin(800, 200, 2048, 512)).toEqual({ w: 800, h: 200 });
    expect(fitWithin(5120, 2880, 2560, 1600)).toEqual({ w: 2560, h: 1440 });
    expect(fitWithin(10000, 1, 2048, 512)).toEqual({ w: 2048, h: 1 });
  });
  it('plan draws the whole picture', () => {
    expect(plan('logo', 4096, 1024)).toEqual({ sx: 0, sy: 0, sw: 4096, sh: 1024, w: 2048, h: 512 });
    expect(plan('signIn', 3000, 3000)).toEqual({ sx: 0, sy: 0, sw: 3000, sh: 3000, w: 1600, h: 1600 });
  });
  it('shrink steps down by a fifth, never below 1 px', () => {
    expect(shrink({ w: 2560, h: 1600 })).toEqual({ w: 2048, h: 1280 });
    expect(shrink({ w: 1, h: 1 })).toEqual({ w: 1, h: 1 });
  });
});

describe('encodeFitting: PNG, then WebP, then a fifth smaller (a fake encoder: bytes per pixel by type)', () => {
  /** a fake canvas encoder: `bpp` bytes per pixel per type; a type missing from it is answered as PNG (Safari without WebP) */
  function fake(bpp: { png: number; webp?: number }) {
    const calls: Array<{ w: number; h: number; type: string; q?: number }> = [];
    const enc: Encoder = async (p, type, q) => {
      calls.push({ w: p.w, h: p.h, type, ...(q === undefined ? {} : { q }) });
      const real = type === 'image/webp' && bpp.webp !== undefined ? 'image/webp' : 'image/png';
      const per = real === 'image/webp' ? bpp.webp! * (q ?? 1) : bpp.png;
      return { size: Math.round(p.w * p.h * per), type: real } as Blob;
    };
    return { enc, calls };
  }
  const logo = plan('logo', 2048, 512) as DrawPlan;
  const photo = plan('signIn', 2560, 1600) as DrawPlan;

  it('a PNG that fits is sent as PNG at full size, nothing else is tried', async () => {
    const f = fake({ png: 1, webp: 0.1 });
    const out = await encodeFitting(logo, 'logo', f.enc);
    expect(out).toMatchObject({ width: 2048, height: 512, blob: { type: 'image/png', size: 2048 * 512 } });
    expect(f.calls).toEqual([{ w: 2048, h: 512, type: 'image/png' }]);
  });
  it('a photo whose PNG is over 2 MB goes as WebP at .9 when that fits, still at full size', async () => {
    const f = fake({ png: 3, webp: 0.4 });
    const out = await encodeFitting(photo, 'signIn', f.enc);
    expect(out).toMatchObject({ width: 2560, height: 1600, blob: { type: 'image/webp' } });
    expect(out!.blob.size).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    expect(f.calls.map((c) => c.q ?? c.type)).toEqual(['image/png', 0.9]);
  });
  it('then WebP at .8', async () => {
    const f = fake({ png: 3, webp: 0.6 }); // .9: 2.2 MB, .8: 1.97 MB
    const out = await encodeFitting(photo, 'signIn', f.enc);
    expect(out).toMatchObject({ width: 2560, height: 1600, blob: { type: 'image/webp' } });
    expect(f.calls.map((c) => c.q ?? c.type)).toEqual(['image/png', 0.9, 0.8]);
  });
  it('without WebP (the browser answers PNG) the picture is drawn a fifth smaller until the PNG fits', async () => {
    const f = fake({ png: 1 });
    const out = await encodeFitting(photo, 'signIn', f.enc);
    // 2560 × 1600 (4.1 M) → 2048 × 1280 (2.6 M) → 1638 × 1024 (1.68 M ≤ 2 MB)
    expect(out).toMatchObject({ width: 1638, height: 1024, blob: { type: 'image/png' } });
    expect(f.calls.filter((c) => c.type === 'image/png').map((c) => [c.w, c.h])).toEqual([[2560, 1600], [2048, 1280], [1638, 1024]]);
    expect(f.calls.filter((c) => c.type === 'image/webp')).toHaveLength(4); // tried at both qualities for each size that did not fit
  });
  it('the symbol is never shrunk or sent as WebP: too large is refused', async () => {
    const f = fake({ png: 10, webp: 0.01 });
    expect(await encodeFitting(plan('symbol', 512, 512) as DrawPlan, 'symbol', f.enc)).toBeNull();
    expect(f.calls).toEqual([{ w: 512, h: 512, type: 'image/png' }]);
  });
  it('gives up after eight sizes, or once the picture cannot get smaller; an encoder answering null counts as too large', async () => {
    const huge = fake({ png: 1e9, webp: 1e9 });
    expect(await encodeFitting(photo, 'signIn', huge.enc)).toBeNull();
    expect(huge.calls.filter((c) => c.type === 'image/png')).toHaveLength(8);
    const tiny = fake({ png: 1e9 });
    expect(await encodeFitting({ sx: 0, sy: 0, sw: 1, sh: 1, w: 1, h: 1 }, 'logo', tiny.enc)).toBeNull();
    expect(tiny.calls.filter((c) => c.type === 'image/png')).toHaveLength(1);
    const none: Encoder = async () => null;
    expect(await encodeFitting(logo, 'logo', none)).toBeNull();
  });
});
