// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AVOID_KEY, AVOID_MS, applyAvoid, avoidedOf, castCapsBody, noteAvoid, parseReceiverCaps, usedFeatures, type CastDelivery } from './caps';
import type { Store } from './resume';

/** the sender's side of the receiver's claims: what it accepts, what it sends with the cast request, and what a failure makes it forget */
const mem = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const NOW = 1_800_000_000_000;

describe('parseReceiverCaps (the receiver\'s caps message)', () => {
  it('takes the exact shape and nothing else in it', () => {
    expect(parseReceiverCaps({ t: 'caps', v: 1, hevc: true, hevc10: true, surround: ['eac3', 'ac3'], evil: 1 })).toEqual({ hevc: true, hevc10: true, surround: ['eac3', 'ac3'] });
    expect(parseReceiverCaps({ t: 'caps', v: 1, hevc: false, hevc10: false, surround: [] })).toEqual({ hevc: false, hevc10: false, surround: [] });
  });
  it('Main 10 only together with Main; unknown codecs dropped, doubles merged, Dolby Digital Plus first', () => {
    expect(parseReceiverCaps({ t: 'caps', v: 1, hevc: false, hevc10: true, surround: [] })).toMatchObject({ hevc: false, hevc10: false });
    expect(parseReceiverCaps({ t: 'caps', v: 1, hevc: true, hevc10: false, surround: ['ac3', 'dts', 'eac3', 'ac3', 5] })).toEqual({ hevc: true, hevc10: false, surround: ['eac3', 'ac3'] });
  });
  it('another version, another type or not-boolean answers claim nothing', () => {
    for (const bad of [null, 'caps', 5, [], { t: 'tok' }, { t: 'caps', v: 2, hevc: true, hevc10: false, surround: [] }, { t: 'caps', hevc: true, surround: [] },
      { t: 'caps', v: 1, hevc: 'true', hevc10: false, surround: [] }, { t: 'caps', v: 1, hevc: true, hevc10: 1, surround: [] }, { t: 'caps', v: 1, hevc: true, hevc10: false, surround: 'eac3' },
      { t: 'caps', v: 1, hevc: true, hevc10: false }]) expect(parseReceiverCaps(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('castCapsBody (what POST /api/cast/session carries)', () => {
  it('nothing claimed = no caps at all (the request stays as the Default Media Receiver\'s)', () => {
    expect(castCapsBody(null)).toBeUndefined();
    expect(castCapsBody({ hevc: false, hevc10: false, surround: [] })).toBeUndefined();
  });
  it('the claims, Main 10 only with Main', () => {
    expect(castCapsBody({ hevc: true, hevc10: true, surround: ['eac3'] })).toEqual({ hevc: true, hevc10: true, surround: ['eac3'] });
    expect(castCapsBody({ hevc: true, hevc10: false, surround: [] })).toEqual({ hevc: true, hevc10: false, surround: [] });
    expect(castCapsBody({ hevc: false, hevc10: false, surround: ['ac3'] })).toEqual({ hevc: false, hevc10: false, surround: ['ac3'] });
  });
});

describe('ff-cast-avoid (a failed feature is forgotten per device name for 30 days)', () => {
  it('an avoid entry removes the matching feature only, for that device only', () => {
    const s = mem();
    const caps = { hevc: true, hevc10: true, surround: ['eac3', 'ac3'] as Array<'eac3' | 'ac3'> };
    expect(avoidedOf(s, 'Wohnzimmer-TV', NOW)).toEqual({ hevc: false, surround: false });
    noteAvoid(s, 'Wohnzimmer-TV', ['hevc'], NOW);
    expect(applyAvoid(caps, avoidedOf(s, 'Wohnzimmer-TV', NOW))).toEqual({ hevc: false, hevc10: false, surround: ['eac3', 'ac3'] });
    expect(applyAvoid(caps, avoidedOf(s, 'Küchen-TV', NOW))).toEqual(caps);
    noteAvoid(s, 'Wohnzimmer-TV', ['surround'], NOW + 1000);
    expect(applyAvoid(caps, avoidedOf(s, 'Wohnzimmer-TV', NOW + 2000))).toEqual({ hevc: false, hevc10: false, surround: [] });
    expect(castCapsBody(applyAvoid(caps, avoidedOf(s, 'Wohnzimmer-TV', NOW + 2000)))).toBeUndefined(); // nothing left to claim: a plain cast
  });
  it('30 days, then the feature is tried again; each feature has its own clock', () => {
    const s = mem();
    noteAvoid(s, 'TV', ['hevc'], NOW);
    noteAvoid(s, 'TV', ['surround'], NOW + 10 * 86_400_000);
    expect(AVOID_MS).toBe(30 * 86_400_000);
    expect(avoidedOf(s, 'TV', NOW + AVOID_MS - 1)).toEqual({ hevc: true, surround: true });
    expect(avoidedOf(s, 'TV', NOW + AVOID_MS + 1)).toEqual({ hevc: false, surround: true });
    expect(avoidedOf(s, 'TV', NOW + 10 * 86_400_000 + AVOID_MS + 1)).toEqual({ hevc: false, surround: false });
    expect(s.data.get(AVOID_KEY)).toBeDefined();
  });
  it('keeps at most 20 devices (the oldest go), names are trimmed, an empty name is never stored', () => {
    const s = mem();
    for (let i = 0; i < 25; i++) noteAvoid(s, `TV ${i}`, ['hevc'], NOW + i);
    noteAvoid(s, '   ', ['hevc'], NOW);
    expect(Object.keys(JSON.parse(s.data.get(AVOID_KEY)!)).length).toBe(20);
    expect(avoidedOf(s, 'TV 0', NOW + 30).hevc).toBe(false);
    expect(avoidedOf(s, ' TV 24 ', NOW + 30).hevc).toBe(true);
  });
  it('blocked or broken storage and bad data are never an error (no avoid then)', () => {
    expect(avoidedOf(null, 'TV', NOW)).toEqual({ hevc: false, surround: false });
    expect(() => noteAvoid(null, 'TV', ['hevc'], NOW)).not.toThrow();
    const throwing: Store = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => undefined };
    expect(avoidedOf(throwing, 'TV', NOW)).toEqual({ hevc: false, surround: false });
    expect(() => noteAvoid(throwing, 'TV', ['hevc'], NOW)).not.toThrow();
    for (const bad of ['{', '[]', '"x"', '{"TV":5}', '{"TV":{"hevc":"x"}}']) {
      const s = mem(); s.data.set(AVOID_KEY, bad);
      expect(avoidedOf(s, 'TV', NOW)).toEqual({ hevc: false, surround: false });
    }
  });
});

describe('usedFeatures (what a cast really carried, from the server\'s fixed codes)', () => {
  const d = (o: Partial<CastDelivery>): CastDelivery => ({ video: 'copy', videoCodec: 'h264', audio: 'copy', audioCodec: 'aac', channels: 2, why: [], ...o });
  it('HEVC in the picture, more than two channels in the sound, both or neither', () => {
    expect(usedFeatures(d({ videoCodec: 'hevc' }))).toEqual(['hevc']);
    expect(usedFeatures(d({ audio: 'surround', channels: 6 }))).toEqual(['surround']);
    expect(usedFeatures(d({ audio: 'copy', channels: 6, videoCodec: 'hevc', video: 'hevc' }))).toEqual(['hevc', 'surround']);
    expect(usedFeatures(d({}))).toEqual([]);
  });
  it('no delivery (a cast without caps, an older server) = nothing to forget', () => {
    expect(usedFeatures(undefined)).toEqual([]);
    expect(usedFeatures({} as never)).toEqual([]);
  });
});
