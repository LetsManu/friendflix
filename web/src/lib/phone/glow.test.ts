// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { averageColor, glowCss } from './glow';

describe('glowCss', () => {
  it('neutral dark glow without a colour: a radial + linear gradient, no rgba() colour', () => {
    const css = glowCss(null);
    expect(css).not.toContain('rgba(');
    expect(css).toMatch(/^radial-gradient\(.+\), linear-gradient\(180deg, .+\)$/);
    // balanced parentheses: a valid gradient list
    expect(css.split('(').length).toBe(css.split(')').length);
  });

  it('uses the colour in both layers', () => {
    const css = glowCss([200, 100, 50]);
    expect(css).toContain('200,100,50');
    expect(css.match(/rgba\(200,100,50,/g)).toHaveLength(2);
    expect(css).toMatch(/^radial-gradient\(.+\), linear-gradient\(180deg, .+\)$/);
  });

  it('clamps and rounds out-of-range values', () => {
    expect(glowCss([300, -4, 12.6])).toContain('255,0,13');
  });
});

/** `document` stand-in whose canvas answers getImageData with `read` */
function fakeCanvas(read: () => { data: Uint8ClampedArray }) {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => {}, getImageData: read }) }) });
}

describe('averageColor', () => {
  afterEach(() => vi.unstubAllGlobals());
  const loaded = { complete: true, naturalWidth: 10 } as HTMLImageElement;

  it('null for an image that is not loaded', () => {
    fakeCanvas(() => ({ data: new Uint8ClampedArray(16 * 16 * 4).fill(255) }));
    expect(averageColor({ complete: false, naturalWidth: 0 } as HTMLImageElement)).toBeNull();
  });

  it('null when the canvas is tainted (getImageData throws)', () => {
    fakeCanvas(() => { throw new Error('SecurityError: tainted'); });
    expect(averageColor(loaded)).toBeNull();
  });

  it('null without a 2d context or without visible pixels', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    expect(averageColor(loaded)).toBeNull();
    fakeCanvas(() => ({ data: new Uint8ClampedArray(16 * 16 * 4) }));
    expect(averageColor(loaded)).toBeNull();
  });

  it('alpha-weighted average of the sampled pixels', () => {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) data.set(i < data.length / 2 ? [200, 100, 50, 255] : [0, 0, 0, 0], i); // the transparent half does not count
    fakeCanvas(() => ({ data }));
    expect(averageColor(loaded)).toEqual([200, 100, 50]);
  });
});
