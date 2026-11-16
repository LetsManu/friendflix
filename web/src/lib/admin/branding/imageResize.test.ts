// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { IMAGE_BOX, MAX_UPLOAD_BYTES, SYMBOL_SIZE, coverCrop, fitWithin, plan, shrink } from './imageResize';

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
