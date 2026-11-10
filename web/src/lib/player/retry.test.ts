// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { avoidTarget, backoffMs, decideRecovery, freshRecovery, isCodecError, kindOfMediaError, lowerQuality, networkStep, pickLockedLevel } from './retry';
import { AbrController } from './abr';
import { parseVolume, stepVolume } from './volume';

const hls = { isHls: true, canLowerQuality: true };
describe('backoff', () => { it('grows and caps', () => { expect([1, 2, 3, 4].map(backoffMs)).toEqual([1000, 2500, 5000, 5000]); }); });

describe('decideRecovery', () => {
  it('retries network errors 3 times with backoff, then fails', () => {
    const s = freshRecovery(); const out = [];
    for (let i = 0; i < 4; i++) { const d = decideRecovery('network', s, hls); out.push(d); if (d.do === 'retry') s.networkTries = d.attempt; }
    expect(out).toEqual([{ do: 'retry', attempt: 1, delay: 1000 }, { do: 'retry', attempt: 2, delay: 2500 }, { do: 'retry', attempt: 3, delay: 5000 }, { do: 'fail' }]);
  });
  it('media error: recoverMediaError once, then lower quality, then fail', () => {
    const s = freshRecovery();
    expect(decideRecovery('media', s, hls)).toEqual({ do: 'recover-media' }); s.mediaRecovered = true;
    expect(decideRecovery('media', s, hls)).toEqual({ do: 'lower-quality' }); s.loweredQuality = true;
    expect(decideRecovery('media', s, hls)).toEqual({ do: 'fail' });
  });
  it('no quality switcher step left: fail right after the recover attempt', () => {
    expect(decideRecovery('media', { ...freshRecovery(), mediaRecovered: true }, { isHls: true, canLowerQuality: false })).toEqual({ do: 'fail' });
  });
  it('direct play decode error falls back to HLS first', () => {
    expect(decideRecovery('media', freshRecovery(), { isHls: false, canLowerQuality: true })).toEqual({ do: 'force-hls' });
  });
  it('other errors fail', () => expect(decideRecovery('other', freshRecovery(), hls)).toEqual({ do: 'fail' }));
});

describe('decideRecovery: avoid (HEVC / surround stream fallback)', () => {
  const av = { isHls: true, canLowerQuality: true, avoidable: true, codecError: false };
  it('a codec error avoids at once, once; then lower quality, then fail', () => {
    const s = freshRecovery();
    expect(decideRecovery('media', s, { ...av, codecError: true })).toEqual({ do: 'avoid' }); s.avoided = true;
    expect(decideRecovery('media', s, { ...av, codecError: true })).toEqual({ do: 'lower-quality' }); s.loweredQuality = true;
    expect(decideRecovery('media', s, { ...av, codecError: true })).toEqual({ do: 'fail' });
    expect(decideRecovery('media', { ...freshRecovery(), avoided: true }, { ...av, canLowerQuality: false, codecError: true })).toEqual({ do: 'fail' });
  });
  it('a generic media error: recover-media, then avoid, then lower quality', () => {
    const s = freshRecovery();
    expect(decideRecovery('media', s, av)).toEqual({ do: 'recover-media' }); s.mediaRecovered = true;
    expect(decideRecovery('media', s, av)).toEqual({ do: 'avoid' }); s.avoided = true;
    expect(decideRecovery('media', s, av)).toEqual({ do: 'lower-quality' }); s.loweredQuality = true;
    expect(decideRecovery('media', s, av)).toEqual({ do: 'fail' });
  });
  it('not avoidable (plain H.264 stereo stream): unchanged, a codec error still gets recoverMediaError first', () => {
    const s = freshRecovery();
    expect(decideRecovery('media', s, { ...av, avoidable: false, codecError: true })).toEqual({ do: 'recover-media' });
    expect(decideRecovery('media', { ...s, mediaRecovered: true }, { ...av, avoidable: false })).toEqual({ do: 'lower-quality' });
  });
  it('network errors never avoid', () => { expect(decideRecovery('network', freshRecovery(), { ...av, codecError: true })).toEqual({ do: 'retry', attempt: 1, delay: 1000 }); });
  it('a fresh state has not avoided', () => expect(freshRecovery().avoided).toBe(false));
});

describe('codec errors and the variant lock', () => {
  it('hls.js codec error details', () => {
    for (const d of ['bufferAddCodecError', 'bufferIncompatibleCodecsError', 'manifestIncompatibleCodecsError']) expect(isCodecError(d)).toBe(true);
    for (const d of ['bufferStalledError', 'fragLoadError', undefined]) expect(isCodecError(d)).toBe(false);
  });
  it('avoidTarget: the audio buffer is surround, the video buffer hevc, anything else both; narrowed to what the stream carried', () => {
    const both = { hevc: true, surround: true };
    expect(avoidTarget({ sourceBufferName: 'audio' }, both)).toBe('surround');
    expect(avoidTarget({ mimeType: 'audio/mp4;codecs=ec-3' }, both)).toBe('surround');
    expect(avoidTarget({ sourceBufferName: 'video' }, both)).toBe('hevc');
    expect(avoidTarget({ mimeType: 'video/mp4;codecs=hvc1.1.6.L153.B0' }, both)).toBe('hevc');
    expect(avoidTarget({ sourceBufferName: 'audiovideo' }, both)).toBe('both');
    expect(avoidTarget({}, both)).toBe('both');
    expect(avoidTarget({}, { hevc: true, surround: false })).toBe('hevc');
    expect(avoidTarget({}, { hevc: false, surround: true })).toBe('surround');
    expect(avoidTarget({ sourceBufferName: 'audio' }, { hevc: true, surround: false })).toBe('both'); // the report does not match the plan: drop both
  });
  const lv = (bitrate: number, videoCodec: string | undefined) => ({ bitrate, videoCodec });
  it('picks the highest-bitrate level of the planned codec; one level or no match: -1 (no lock)', () => {
    const levels = [lv(8e6, 'avc1.640028'), lv(8e6, 'hvc1.1.6.L150.B0'), lv(7e6, 'hev1.1.6.L120.B0'), lv(6e6, 'avc1.4d401f')];
    expect(pickLockedLevel(levels, true)).toBe(1);
    expect(pickLockedLevel(levels, false)).toBe(0);
    expect(pickLockedLevel([lv(1, 'hvc1.1')], true)).toBe(-1);
    expect(pickLockedLevel([lv(8e6, 'avc1.640028'), lv(9e6, 'avc1.640028')], true)).toBe(-1);
    expect(pickLockedLevel([lv(1, undefined), lv(2, 'avc1.64')], false)).toBe(1);
  });
});

describe('helpers', () => {
  it('MediaError codes', () => { expect(kindOfMediaError(2)).toBe('network'); expect(kindOfMediaError(3)).toBe('media'); expect(kindOfMediaError(4)).toBe('media'); expect(kindOfMediaError(1)).toBe('other'); });
  it('lowerQuality picks the next ladder step below the current', () => {
    const ladder = [8_000_000, 4_000_000, 1_500_000, 800_000];
    expect(lowerQuality(ladder, 4_000_000, 0)).toBe(1_500_000); expect(lowerQuality(ladder, 0, 6_000_000)).toBe(4_000_000);
    expect(lowerQuality(ladder, 800_000, 0)).toBeNull();
  });
  it('volume parsing and stepping', () => {
    expect(parseVolume('0.4')).toBe(0.4); expect(parseVolume(null)).toBeNull(); expect(parseVolume('')).toBeNull(); expect(parseVolume('2')).toBeNull(); expect(parseVolume('abc')).toBeNull(); expect(parseVolume('0')).toBe(0);
    expect(stepVolume(0.95, 0.1)).toBe(1); expect(stepVolume(0.05, -0.1)).toBe(0); expect(stepVolume(0.3, 0.1)).toBe(0.4);
  });
});

describe('networkStep (network error after the first failed retry)', () => {
  it('steps down, waits during the cooldown without spending the retry budget, gives up only at the lowest rung', () => {
    let t = 0;
    const c = new AbrController({ now: () => t, cap: 8e6, start: 1_500_000 });
    expect(networkStep(c.onNetworkError())).toBe('switch'); // 480p -> 360p
    t = 3000;
    const rec = freshRecovery(); rec.networkTries = 1;
    expect(networkStep(c.onNetworkError())).toBe('wait'); // cooldown
    expect(rec.networkTries).toBe(1); // the budget stays untouched
    t = 11_000;
    expect(networkStep(c.onNetworkError())).toBe('giveup'); // at 360p after the cooldown
  });
});
