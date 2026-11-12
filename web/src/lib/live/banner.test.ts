// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BANNER_HOLD_MS, bannerVisible } from './banner';

type S = Parameters<typeof bannerVisible>[0];
const s = (o: Partial<S> = {}): S => ({ starting: false, switchingAt: null, firstFrameAt: null, controlsVisible: false, error: false, ...o });

describe('bannerVisible', () => {
  it('holds 4 s (ruling 49)', () => {
    expect(BANNER_HOLD_MS).toBe(4000);
  });
  it('starting → true', () => {
    expect(bannerVisible(s({ starting: true }), 0)).toBe(true);
    expect(bannerVisible(s({ starting: true, switchingAt: 1000 }), 999_999)).toBe(true);
  });
  it('first frame at t after a switch → true at t + 3 999, false at t + 4 000', () => {
    const t = 50_000;
    expect(bannerVisible(s({ switchingAt: t - 1500, firstFrameAt: t }), t)).toBe(true);
    expect(bannerVisible(s({ switchingAt: t - 1500, firstFrameAt: t }), t + 3999)).toBe(true);
    expect(bannerVisible(s({ switchingAt: t - 1500, firstFrameAt: t }), t + 4000)).toBe(false);
  });
  it('the first open counts like a switch', () => {
    const t = 7000;
    expect(bannerVisible(s({ firstFrameAt: t }), t + 3999)).toBe(true);
    expect(bannerVisible(s({ firstFrameAt: t }), t + 4000)).toBe(false);
  });
  it('a switch with no first frame yet keeps it (an older first frame belongs to the previous channel)', () => {
    expect(bannerVisible(s({ switchingAt: 10_000 }), 60_000)).toBe(true);
    expect(bannerVisible(s({ switchingAt: 10_000, firstFrameAt: 2000 }), 60_000)).toBe(true);
  });
  it('controls visible → true', () => {
    expect(bannerVisible(s({ controlsVisible: true, firstFrameAt: 0 }), 600_000)).toBe(true);
  });
  it('error → false, whatever else holds it', () => {
    expect(bannerVisible(s({ error: true, starting: true }), 0)).toBe(false);
    expect(bannerVisible(s({ error: true, controlsVisible: true }), 0)).toBe(false);
    expect(bannerVisible(s({ error: true, switchingAt: 0, firstFrameAt: 10 }), 20)).toBe(false);
  });
});
