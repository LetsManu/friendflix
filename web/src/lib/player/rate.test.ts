// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { applyRate, reapplyRate } from './rate';

/** the part of a media element that matters here: a load resets playbackRate to defaultPlaybackRate */
class FakeMedia {
  playbackRate = 1;
  defaultPlaybackRate = 1;
  load() { this.playbackRate = this.defaultPlaybackRate; }
}

describe('playback speed across a new source', () => {
  it('the chosen speed survives a reload (track / quality switch, retry)', () => {
    const v = new FakeMedia();
    applyRate(v, 1.5);
    expect(v.playbackRate).toBe(1.5);
    v.load();
    expect(v.playbackRate).toBe(1.5);
  });

  it('setting only playbackRate fell back to 1x on reload (the old bug), reapplyRate restores it', () => {
    const v = new FakeMedia();
    v.playbackRate = 1.25;
    v.load();
    expect(v.playbackRate).toBe(1);
    expect(reapplyRate(v, 1.25, false)).toBe(true);
    expect(v.playbackRate).toBe(1.25);
    v.load();
    expect(v.playbackRate).toBe(1.25);
    expect(reapplyRate(v, 1.25, false)).toBe(false); // nothing to do
  });

  it('leaves the rate alone in a watch party and without an element', () => {
    const v = new FakeMedia();
    v.playbackRate = 1.05; // the party drift correction
    expect(reapplyRate(v, 1, true)).toBe(false);
    expect(v.playbackRate).toBe(1.05);
    expect(reapplyRate(null, 1.5, false)).toBe(false);
  });

  it('ignores invalid rates and a refusing element', () => {
    const v = new FakeMedia();
    applyRate(v, 0);
    applyRate(v, Number.NaN);
    expect(v).toMatchObject({ playbackRate: 1, defaultPlaybackRate: 1 });
    const refusing = { get playbackRate() { return 1; }, set playbackRate(_x: number) { throw new Error('NotSupportedError'); }, defaultPlaybackRate: 1 };
    expect(() => applyRate(refusing, 16)).not.toThrow();
  });
});
