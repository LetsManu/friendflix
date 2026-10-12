import { describe, expect, it } from 'vitest';
import { canRenderEarly, earlyProfile, gateHref, hintOf, needsProfileGate, parseHint } from './gate';

describe('needsProfileGate', () => {
  const multi = { profileCount: 3, profileChosen: true };
  it('single-profile accounts are never gated', () => {
    expect(needsProfileGate({ profileCount: 1, profileChosen: true }, '/', false)).toBe(false);
    expect(needsProfileGate({ profileCount: 0 }, '/', false)).toBe(false);
  });
  it('server says no profile chosen: gate everywhere but /profiles', () => {
    expect(needsProfileGate({ profileRequired: true }, '/watch/x', true)).toBe(true);
    expect(needsProfileGate({ profileCount: 2, profileChosen: false }, '/remote', true)).toBe(true);
    expect(needsProfileGate({ profileRequired: true }, '/profiles', false)).toBe(false);
  });
  it('several profiles: once per browser session', () => {
    expect(needsProfileGate(multi, '/', false)).toBe(true);
    expect(needsProfileGate(multi, '/watch/abc', false)).toBe(true); // deep links continue via ?next=
    expect(needsProfileGate(multi, '/', true)).toBe(false);
  });
  it('no session gate on televisions and the remote control', () => {
    expect(needsProfileGate({ ...multi, tv: true }, '/', false)).toBe(false);
    expect(needsProfileGate(multi, '/remote', false)).toBe(false);
    expect(needsProfileGate(multi, '/remote/x', false)).toBe(false);
    expect(needsProfileGate(multi, '/remotely', false)).toBe(true);
  });
});

describe('boot hint', () => {
  it('round-trips and rejects junk', () => {
    const h = hintOf({ deviceApproved: true, profileCount: 2, tv: false });
    expect(h).toEqual({ approved: true, multi: true, tv: false });
    expect(parseHint(JSON.stringify(h))).toEqual(h);
    expect(parseHint('{"approved":1}')).toBeNull();
    expect(parseHint('nope')).toBeNull();
    expect(parseHint(null)).toBeNull();
  });
  it('renders early only when nothing has to happen first', () => {
    const ok = { approved: true, multi: false, tv: false };
    expect(canRenderEarly(ok, false, '/')).toBe(true);
    expect(canRenderEarly(null, true, '/')).toBe(false);
    expect(canRenderEarly({ ...ok, approved: false }, true, '/')).toBe(false);
    expect(canRenderEarly({ ...ok, tv: true }, true, '/')).toBe(false);
    expect(canRenderEarly({ ...ok, multi: true }, false, '/')).toBe(false);
    expect(canRenderEarly({ ...ok, multi: true }, true, '/')).toBe(true);
    expect(canRenderEarly(ok, true, '/profiles')).toBe(false);
    expect(canRenderEarly(ok, true, '/', null)).toBe(false); // profile of this tab unknown
    expect(canRenderEarly(ok, true, '/', 'p1', true)).toBe(false); // reloading after a profile switch elsewhere
  });
  it('early profile: the tab\'s own, else the only profile of the account', () => {
    const single = hintOf({ deviceApproved: true, profileCount: 1, profile: { id: 'p1' } });
    expect(single.profile).toBe('p1');
    expect(parseHint(JSON.stringify(single))).toEqual(single);
    expect(earlyProfile(single, null)).toBe('p1');
    expect(earlyProfile(single, 'p9')).toBe('p9');
    const multi = hintOf({ deviceApproved: true, profileCount: 3, profile: { id: 'p1' } });
    expect(multi.profile).toBeUndefined(); // several profiles: never guessed
    expect(earlyProfile(multi, null)).toBeNull();
  });
  it('gate link keeps the deep link', () => {
    expect(gateHref('/watch/1?t=30')).toBe('/profiles?next=%2Fwatch%2F1%3Ft%3D30');
  });
});
