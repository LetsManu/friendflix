// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_BOX, MAX_UPLOAD_BYTES, SYMBOL_SIZE, coverCrop, encodeFitting, fitWithin, plan, prepareImage, shrink, type DrawPlan, type Encoder } from './imageResize';

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

describe('prepareImage (browser doubles: createImageBitmap, a canvas that records its draws)', () => {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  /** a PNG file that is only its header: enough for the size check, decoded by the double below */
  function pngFile(w: number, h: number, type = 'image/png', pad = 0): File {
    const b = new Uint8Array(33 + pad);
    b.set(PNG_SIG, 0);
    const v = new DataView(b.buffer);
    v.setUint32(8, 13); b.set([73, 72, 68, 82], 12); v.setUint32(16, w); v.setUint32(20, h);
    return new File([b], 'x.png', { type });
  }
  /** a JPEG whose frame header lies past the first 64 KB (a large EXIF block before it) */
  function jpegFile(w: number, h: number): File {
    const app: number[] = [];
    for (let i = 0; i < 2; i++) app.push(0xff, 0xe1, 0xff, 0xff, ...new Array(0xfffd).fill(0));
    const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    return new File([new Uint8Array([0xff, 0xd8, ...app, ...sof])], 'x.jpg', { type: 'image/jpeg' });
  }
  let decoded = 0, closed = 0;
  const draws: Array<{ w: number; h: number; sx: number; sy: number; sw: number; sh: number }> = [];
  /** stubs the browser: the bitmap has the header's size (or `bitmap`), the canvas encodes `bytesPerPixel` per type */
  function browser(opts: { bitmap?: { width: number; height: number }; bytesPerPixel?: { png: number; webp?: number }; fail?: boolean } = {}) {
    decoded = 0; closed = 0; draws.length = 0;
    vi.stubGlobal('createImageBitmap', async (f: File) => {
      decoded++;
      if (opts.fail) throw new Error('decode');
      const v = new DataView(await f.slice(0, 24).arrayBuffer());
      const size = opts.bitmap ?? { width: v.getUint32(16), height: v.getUint32(20) };
      return { ...size, close: () => { closed++; } };
    });
    const bpp = opts.bytesPerPixel ?? { png: 0.1 };
    vi.stubGlobal('document', {
      createElement: () => {
        const c = {
          width: 0, height: 0,
          getContext: () => ({ imageSmoothingEnabled: false, imageSmoothingQuality: 'low', drawImage: (_s: unknown, sx: number, sy: number, sw: number, sh: number) => { draws.push({ w: c.width, h: c.height, sx, sy, sw, sh }); } }),
          toBlob: (cb: (b: Blob | null) => void, type: string) => {
            const real = type === 'image/webp' && bpp.webp !== undefined ? 'image/webp' : 'image/png';
            cb({ size: Math.round(c.width * c.height * (real === 'image/webp' ? bpp.webp! : bpp.png)), type: real } as Blob);
          },
        };
        return c;
      },
    });
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  it('the symbol: a 1000 × 600 pick is decoded, cropped from the centre and sent as a 512 × 512 PNG', async () => {
    browser();
    const r = await prepareImage(pngFile(1000, 600), 'symbol');
    expect(r).toMatchObject({ ok: true, width: 512, height: 512, blob: { type: 'image/png' } });
    expect(draws).toEqual([{ w: 512, h: 512, sx: 200, sy: 0, sw: 600, sh: 600 }]);
    expect(closed).toBe(1);
  });
  it('a side over 12 000 px in the header is refused before anything is decoded', async () => {
    browser();
    expect(await prepareImage(pngFile(13_000, 100), 'logo')).toEqual({ ok: false, error: 'large', width: 13_000, height: 100 });
    expect(await prepareImage(jpegFile(100, 12_001), 'signIn')).toEqual({ ok: false, error: 'large', width: 100, height: 12_001 });
    expect(decoded).toBe(0);
  });
  it('a file the header cannot be read from, a refused type or a source over 25 MB is not decoded either', async () => {
    browser();
    expect(await prepareImage(new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }), 'logo')).toEqual({ ok: false, error: 'read' });
    expect(await prepareImage(pngFile(10, 10, 'image/svg+xml'), 'logo')).toEqual({ ok: false, error: 'type' });
    const huge = { type: 'image/png', size: 26 * 1024 * 1024 } as File;
    expect(await prepareImage(huge, 'logo')).toEqual({ ok: false, error: 'large' });
    expect(decoded).toBe(0);
  });
  it('a decoder that fails, a bitmap bigger than its header said, a symbol under 512: refused (the bitmap is closed)', async () => {
    browser({ fail: true });
    expect(await prepareImage(pngFile(800, 200), 'logo')).toEqual({ ok: false, error: 'read' });
    browser({ bitmap: { width: 20_000, height: 10 } });
    expect(await prepareImage(pngFile(800, 200), 'logo')).toEqual({ ok: false, error: 'large', width: 20_000, height: 10 });
    browser({ bitmap: { width: 400, height: 400 } });
    expect(await prepareImage(jpegFile(400, 400), 'symbol')).toEqual({ ok: false, error: 'small', width: 400, height: 400 });
    expect(closed).toBe(1);
  });
  it('a photo over 2 MB as PNG goes as WebP; one canvas per size serves the PNG and both WebP tries', async () => {
    browser({ bytesPerPixel: { png: 3, webp: 0.3 } });
    const r = await prepareImage(pngFile(2560, 1600), 'signIn');
    expect(r).toMatchObject({ ok: true, width: 2560, height: 1600, blob: { type: 'image/webp' } });
    expect(draws).toHaveLength(1);
  });
  it('nothing fits: tooLarge', async () => {
    browser({ bytesPerPixel: { png: 1e6 } });
    expect(await prepareImage(pngFile(600, 600), 'symbol')).toEqual({ ok: false, error: 'tooLarge' });
  });
});
