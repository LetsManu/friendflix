// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { creditsStart as playerCredits } from '#lib/player/nextup';
import { CAST_NS } from '#lib/cast';
import {
  CAPS_PROBES, COUNTDOWN_SECONDS, DEFAULT_STRINGS, LIVE_CARD_MS, NS, PAUSE_SHOW_MS, PROGRESS_MS, STALL_SHOW_MS, WHO_MS, activeSkip, buildCaps, createReporter, creditsStart, formatTime, initialState, liveOf, parseMessage, probeCaps, seekTarget, step, textTrackStyle, view,
} from '../../../static/cast-receiver/logic.js';
import { CAF_URL, RECEIVER_CSP, receiverHtml } from './receiverPage';
import { GET, trailingSlash } from '../../routes/cast-receiver/+server';

/** FriendFlix's own Cast receiver: its pure logic (web/static/cast-receiver/logic.js) and its page. */
const A = 'a'.repeat(32), B = 'b'.repeat(32);
const RT = 'eyJ2IjoxLCJjIjoiYWJjIn0.' + 'S'.repeat(43);

describe('receiver: messages from the sender', () => {
  it('uses the sender\'s channel name', () => expect(NS).toBe(CAST_NS));

  it('accepts a report token only in its exact shape', () => {
    expect(parseMessage(JSON.stringify({ t: 'tok', castId: A, rt: RT }))).toEqual({ t: 'tok', castId: A, rt: RT });
    expect(parseMessage({ t: 'tok', castId: A, rt: RT })).toEqual({ t: 'tok', castId: A, rt: RT });
    for (const bad of [{ t: 'tok', castId: 'x', rt: RT }, { t: 'tok', castId: A, rt: 'nope' }, { t: 'tok', castId: A }, { t: 'evil' }, null, 5, '{', 'x'.repeat(40_000)]) {
      expect(parseMessage(bad)).toBeNull();
    }
  });

  it('item: segments cleaned up (bounded, lower case, sane numbers), next episode checked', () => {
    const m = parseMessage({ t: 'item', castId: A, episode: true, segs: [{ type: 'Intro', start: 5, end: 60 }, { type: 'x', start: 9, end: 2 }, { type: 'recap', start: -1, end: 4 }, 'junk'],
      next: { castId: B, label: ' S1:E2 · Two ', auto: true, ask: 'yes' } });
    expect(m).toEqual({ t: 'item', castId: A, episode: true, segs: [{ type: 'intro', start: 5, end: 60 }], next: { castId: B, label: 'S1:E2 · Two', auto: true, ask: false } });
    expect(parseMessage({ t: 'item', castId: A, next: { castId: 'bad' } })).toMatchObject({ next: null, segs: [], episode: false });
    expect(parseMessage({ t: 'item', castId: 'bad' })).toBeNull();
  });

  it('ui: texts with fallbacks, subtitle style limited to the known choices, countdown bounded', () => {
    const m = parseMessage({ t: 'ui', strings: { next: 'Nächste Folge', startsIn: ['in 1', 'in 2'], skip: { intro: 'Intro überspringen' } }, sub: { size: 'xl', color: 'red', background: 'solid', font: 'mono' }, countdown: 999 });
    expect(m).toMatchObject({ t: 'ui', strings: { next: 'Nächste Folge', startsIn: ['in 1', 'in 2'], stillTitle: DEFAULT_STRINGS.stillTitle, skip: { intro: 'Intro überspringen', recap: 'Skip recap' } },
      sub: { size: 'xl', color: 'white', background: 'solid', font: 'mono' }, countdown: COUNTDOWN_SECONDS });
    expect(parseMessage({ t: 'ui', countdown: 5 })).toMatchObject({ countdown: 5, strings: DEFAULT_STRINGS });
  });
});

describe('receiver: what it claims (HEVC, Dolby) and when', () => {
  it('a caps request from the sender is accepted in its exact shape (the sender asks, the receiver answers)', () => {
    expect(parseMessage({ t: 'caps?' })).toEqual({ t: 'caps?' });
    expect(parseMessage(JSON.stringify({ t: 'caps?' }))).toEqual({ t: 'caps?' });
    expect(parseMessage({ t: 'caps?', hevc: true, evil: 1 })).toEqual({ t: 'caps?' }); // nothing from the sender is taken over
    expect(parseMessage({ t: 'caps' })).toBeNull(); // the answer is ours to send, never to receive
  });

  it('buildCaps: a claim only for what the probe answered with a plain true; the message is versioned', () => {
    expect(buildCaps({ hevc: true, hevc10: true, eac3: true, ac3: true })).toEqual({ t: 'caps', v: 1, hevc: true, hevc10: true, surround: ['eac3', 'ac3'] });
    expect(buildCaps({ hevc: true, hevc10: false, eac3: false, ac3: true })).toEqual({ t: 'caps', v: 1, hevc: true, hevc10: false, surround: ['ac3'] });
    expect(buildCaps({ hevc: false, hevc10: false, eac3: true, ac3: false })).toEqual({ t: 'caps', v: 1, hevc: false, hevc10: false, surround: ['eac3'] });
    expect(buildCaps({ hevc: false, hevc10: false, eac3: false, ac3: false })).toEqual({ t: 'caps', v: 1, hevc: false, hevc10: false, surround: [] });
  });

  it('buildCaps: Main 10 only counts together with Main; unknown, missing or not-boolean answers are "no"', () => {
    expect(buildCaps({ hevc: false, hevc10: true, eac3: false, ac3: false })).toMatchObject({ hevc: false, hevc10: false });
    expect(buildCaps({} as never)).toEqual({ t: 'caps', v: 1, hevc: false, hevc10: false, surround: [] });
    expect(buildCaps({ hevc: 'yes', hevc10: 1, eac3: 'true', ac3: {} } as never)).toEqual({ t: 'caps', v: 1, hevc: false, hevc10: false, surround: [] });
    expect(buildCaps(null as never)).toEqual({ t: 'caps', v: 1, hevc: false, hevc10: false, surround: [] });
  });

  it('probeCaps asks canDisplayType for hvc1 Main and Main 10 at 1920x1080 and for ec-3 / ac-3, and trusts only a true answer', () => {
    const asked: unknown[][] = [];
    const yes = (...a: unknown[]) => { asked.push(a); return true; };
    expect(probeCaps(yes)).toEqual({ hevc: true, hevc10: true, eac3: true, ac3: true });
    expect(asked).toEqual([CAPS_PROBES.hevc, CAPS_PROBES.hevc10, CAPS_PROBES.eac3, CAPS_PROBES.ac3]);
    expect(CAPS_PROBES.hevc).toEqual(['video/mp4', 'hvc1.1.6.L123.B0', 1920, 1080, 30]);
    expect(CAPS_PROBES.hevc10).toEqual(['video/mp4', 'hvc1.2.4.L123.B0', 1920, 1080, 30]);
    expect(CAPS_PROBES.eac3).toEqual(['audio/mp4', 'ec-3']);
    expect(CAPS_PROBES.ac3).toEqual(['audio/mp4', 'ac-3']);
    // only the Dolby Digital probe passes (an AVR without Plus): surround is ac3 alone, the picture stays H.264
    expect(buildCaps(probeCaps((_m: string, c: string) => c === 'ac-3'))).toMatchObject({ hevc: false, hevc10: false, surround: ['ac3'] });
    // "maybe", undefined, a string, a throw (no such API on this firmware): no claim
    expect(probeCaps(() => 'maybe' as never)).toEqual({ hevc: false, hevc10: false, eac3: false, ac3: false });
    expect(probeCaps(() => undefined as never)).toEqual({ hevc: false, hevc10: false, eac3: false, ac3: false });
    expect(probeCaps(() => { throw new Error('no canDisplayType'); })).toEqual({ hevc: false, hevc10: false, eac3: false, ac3: false });
    // a failing probe never stops the others
    expect(probeCaps((m: string, c: string) => { if (c.startsWith('hvc1.1')) throw new Error('x'); return c === 'ec-3'; })).toEqual({ hevc: false, hevc10: false, eac3: true, ac3: false });
  });
});

describe('receiver: the same rules as the web player', () => {
  it('credits start (Outro in the second half, else the last 25 s) like nextup.creditsStart', () => {
    const cases: Array<[Array<{ type: string; start: number; end: number }>, number]> = [
      [[], 1800], [[{ type: 'outro', start: 1700, end: 1800 }], 1800], [[{ type: 'outro', start: 100, end: 200 }], 1800],
      [[{ type: 'credits', start: 1650, end: 1800 }, { type: 'outro', start: 1600, end: 1650 }], 1800], [[], 0], [[], 10],
    ];
    for (const [segs, d] of cases) expect(creditsStart(segs, d)).toBe(playerCredits(segs, d));
  });

  it('skip intro / recap inside the segment only (not in its last second)', () => {
    const segs = [{ type: 'recap', start: 0, end: 30 }, { type: 'intro', start: 40, end: 100 }, { type: 'outro', start: 1700, end: 1800 }];
    expect(activeSkip(segs, 5)).toEqual({ type: 'recap', end: 30 });
    expect(activeSkip(segs, 99.5)).toBeNull();
    expect(activeSkip(segs, 1750)).toBeNull();
  });

  it('subtitle style from the user\'s prefs as a CAF TextTrackStyle', () => {
    expect(textTrackStyle({ size: 'l', color: 'yellow', background: 'semi', font: 'serif' })).toEqual({
      foregroundColor: '#FFEB3BFF', backgroundColor: '#000000A0', windowType: 'NONE', edgeType: 'NONE', edgeColor: '#000000FF', fontScale: 1.25, fontGenericFamily: 'SERIF' });
    expect(textTrackStyle({ size: 's', color: 'white', background: 'shadow', font: 'mono' })).toMatchObject({ backgroundColor: '#00000000', edgeType: 'DROP_SHADOW', fontScale: 0.8, fontGenericFamily: 'MONOSPACED_SANS_SERIF' });
    expect(textTrackStyle({ size: 'xl', color: 'x', background: 'solid', font: 'sans' })).toMatchObject({ foregroundColor: '#FFFFFFFF', backgroundColor: '#000000FF', fontScale: 1.5 });
  });
});

describe('receiver: next-up card, countdown, still watching', () => {
  type St = ReturnType<typeof initialState>;
  const item = (next: { castId: string; label: string; auto: boolean; ask: boolean } | null, segs = [{ type: 'intro', start: 10, end: 70 }]) =>
    ({ type: 'item' as const, msg: { t: 'item' as const, castId: A, episode: true, segs, next } });
  const time = (pos: number, playing = true, dt = 1000) => ({ type: 'time' as const, pos, dur: 1800, playing, dt });
  /** runs events, collecting the actions */
  const run = (st: St, evs: Parameters<typeof step>[1][]) => {
    const actions: unknown[] = [];
    for (const e of evs) { const r = step(st, e); st = r.st; actions.push(...r.actions); }
    return { st, actions };
  };
  const NEXT = { castId: B, label: 'S1:E2 · Two', auto: true, ask: false };

  it('the card shows at the credits and the countdown (only while playing) moves on to the queued episode once', () => {
    let { st } = run(initialState(), [{ type: 'media', castId: A }, item(NEXT), time(60)]);
    expect(view(st, DEFAULT_STRINGS).skip).toEqual({ end: 70, text: 'Skip intro' });
    expect(view(st, DEFAULT_STRINGS).card).toBeNull();
    ({ st } = run(st, [time(1776), time(1777, true, 3000)]));
    const v = view(st, DEFAULT_STRINGS).card!;
    expect(v).toMatchObject({ mode: 'next', title: 'Up next in 6 s', name: 'S1:E2 · Two', hint: 'Cancel on your phone', buttons: false, text: 'Next episode starts in 6 seconds', primary: 'Play now', secondary: 'Watch credits' });
    expect(v.progress).toBeCloseTo(0.4);
    ({ st } = run(st, [time(1778, false, 60_000)])); // paused: the countdown waits
    expect(view(st, DEFAULT_STRINGS).card!.progress).toBeCloseTo(0.4);
    const last = run(st, [time(1779, true, 3000), time(1782, true, 3000), time(1783, true, 1000)]);
    st = last.st;
    expect(last.actions).toEqual(['jump']);
    expect(view(st, DEFAULT_STRINGS).card).toBeNull();
    expect(run(st, [time(1790)]).actions).toEqual([]);
  });

  it('without autoplay the card has no countdown; Play now moves on; cancel tells the phone; seeking back withdraws it', () => {
    let { st, actions } = run(initialState(), [{ type: 'media', castId: A }, item({ ...NEXT, auto: false }), time(1780), time(1790, true, 20_000)]);
    expect(actions).toEqual([]);
    expect(view(st, DEFAULT_STRINGS).card).toMatchObject({ title: 'Up next', text: '', progress: 0 }); // no countdown: still "Up next" (spec §5), not "Next episode"
    expect(run(st, [{ type: 'playNow' }]).actions).toEqual(['jump', 'send-interaction']);
    ({ st, actions } = run(st, [{ type: 'cancel' }]));
    expect(actions).toEqual(['send-cancel']);
    expect(view(st, DEFAULT_STRINGS).card).toBeNull();
    ({ st } = run(st, [time(1000), time(1780)])); // back out and in again: offered again
    expect(view(st, DEFAULT_STRINGS).card).not.toBeNull();
    // no queued episode / not an episode: nothing
    expect(view(run(initialState(), [{ type: 'media', castId: A }, item(null), time(1790)]).st, DEFAULT_STRINGS).card).toBeNull();
  });

  it('still watching at the credits: no countdown until answered; answered, the countdown runs', () => {
    let { st, actions } = run(initialState(), [{ type: 'media', castId: A }, item({ ...NEXT, ask: true }), time(1780), time(1790, true, 20_000)]);
    expect(actions).toEqual([]);
    expect(view(st, DEFAULT_STRINGS).card).toMatchObject({ mode: 'still', title: 'Still there?', text: 'Autoplay is paused. Up next: S1:E2 · Two', primary: 'Continue watching', secondary: '' });
    ({ st, actions } = run(st, [{ type: 'confirm' }]));
    expect(actions).toEqual(['send-interaction']);
    ({ actions } = run(st, [time(1791, true, 10_000)]));
    expect(actions).toEqual(['jump']);
  });

  it('still watching unanswered at the end: the queued episode waits paused under the question; OK or PLAY plays it', () => {
    let { st, actions } = run(initialState(), [{ type: 'media', castId: A }, item({ ...NEXT, ask: true }), time(1795), { type: 'media', castId: B }]);
    expect(actions).toEqual(['pause']);
    expect(view(st, DEFAULT_STRINGS).still).toEqual({ title: 'Still there?', text: 'Autoplay is paused. Up next: S1:E2 · Two', primary: 'Continue watching' });
    expect(view(st, DEFAULT_STRINGS).skip).toBeNull();
    ({ st, actions } = run(st, [{ type: 'confirm' }]));
    expect(actions).toEqual(['play', 'send-interaction']);
    expect(view(st, DEFAULT_STRINGS).still).toBeNull();
    // played from the phone instead: answered as well
    ({ st } = run(initialState(), [{ type: 'media', castId: A }, item({ ...NEXT, ask: true }), { type: 'media', castId: B }, time(1, true)]));
    expect(st.still).toBe(false);
    // an answered ask does not stop the next one
    ({ actions } = run(initialState(), [{ type: 'media', castId: A }, item({ ...NEXT, ask: true }), time(1780), { type: 'confirm' }, { type: 'media', castId: B }]));
    expect(actions).toEqual(['send-interaction']);
  });

  it('skip from the TV seeks past the segment; an item message for another token is ignored', () => {
    const { st, actions } = run(initialState(), [{ type: 'media', castId: A }, item(NEXT), time(20), { type: 'skip' }]);
    expect(actions).toEqual([{ seek: 70 }, 'send-interaction']);
    expect(run(st, [{ type: 'item', msg: { t: 'item', castId: B, episode: false, segs: [], next: null } }]).st.next).toEqual(NEXT);
    expect(run(st, [time(100), { type: 'skip' }]).actions).toEqual([]);
    expect(run(st, [{ type: 'countdown', seconds: 5 }]).st.countdown).toBe(5);
  });
});

describe('receiver: pause, loading, sender pill, key hints', () => {
  type Ev = Parameters<typeof step>[1];
  const run = (evs: Ev[], st = initialState()) => { for (const e of evs) st = step(st, e).st; return st; };
  const meta = { title: 'Dunmoor', line: 'Season 1 · Episode 4 · The Lantern Road' };
  const item: Ev = { type: 'item', msg: { t: 'item', castId: A, episode: true, segs: [], next: null, meta } };
  const T = 100_000;
  const base = (): ReturnType<typeof initialState> => run([{ type: 'ui', who: 'Cast from Anna\'s phone', motion: true }, { type: 'media', castId: A }, { type: 'clock', now: T }, { type: 'load' }, item, { type: 'firstFrame' },
    { type: 'time', pos: 754, dur: 2640, playing: true, dt: 250 }]);

  it('the new state starts quiet', () => {
    expect(initialState()).toMatchObject({ paused: false, pausedAt: null, loading: null, firstFrame: false, stallAt: null, keySeen: false, touch: false, meta: null, who: '', whoUntil: 0, motion: true });
    expect([PAUSE_SHOW_MS, WHO_MS, STALL_SHOW_MS]).toEqual([1500, 5000, 3000]);
  });

  it('pause screen only after 1.5 s of pause', () => {
    let st = run([{ type: 'pause', paused: true, at: T + 10_000 }], base());
    expect(view(run([{ type: 'clock', now: T + 10_000 + PAUSE_SHOW_MS - 1 }], st), DEFAULT_STRINGS).pause).toBeNull();
    st = run([{ type: 'clock', now: T + 10_000 + PAUSE_SHOW_MS }], st);
    expect(view(st, DEFAULT_STRINGS).pause).toEqual({ label: 'Paused', title: 'Dunmoor', line: meta.line, pos: 754, dur: 2640 });
    // a repeated pause does not restart the timer; play hides at once; a quick pause / resume never shows
    expect(view(run([{ type: 'pause', paused: true, at: T + 20_000 }], st), DEFAULT_STRINGS).pause).not.toBeNull();
    expect(view(run([{ type: 'pause', paused: false, at: T + 11_600 }], st), DEFAULT_STRINGS).pause).toBeNull();
    const quick = run([{ type: 'pause', paused: true, at: T + 30_000 }, { type: 'pause', paused: false, at: T + 30_400 }, { type: 'clock', now: T + 40_000 }], base());
    expect(view(quick, DEFAULT_STRINGS).pause).toBeNull();
  });

  it('loading screen until the first frame; a 3 s stall shows Loading…', () => {
    let st = run([{ type: 'media', castId: A }, { type: 'clock', now: T }, { type: 'load' }, item]); // the item message follows the LOAD (a LOAD clears the old meta)
    expect(view(st, DEFAULT_STRINGS).load).toEqual({ title: 'Dunmoor', line: meta.line, label: 'Getting ready…' });
    st = run([{ type: 'firstFrame' }], st);
    expect(view(st, DEFAULT_STRINGS).load).toBeNull();
    expect(view(st, DEFAULT_STRINGS).pause).toBeNull();
    st = run([{ type: 'buffering', on: true, at: T + 60_000 }, { type: 'clock', now: T + 60_000 + STALL_SHOW_MS - 1 }], st);
    expect(view(st, DEFAULT_STRINGS).pause).toBeNull();
    st = run([{ type: 'clock', now: T + 60_000 + STALL_SHOW_MS }], st);
    expect(view(st, DEFAULT_STRINGS).pause).toMatchObject({ label: 'Loading…', title: 'Dunmoor' });
    expect(view(run([{ type: 'buffering', on: false, at: T + 64_000 }], st), DEFAULT_STRINGS).pause).toBeNull();
    // buffering before the first frame stays the loading screen, no stall
    const first = run([{ type: 'media', castId: A }, { type: 'clock', now: T }, { type: 'load' }, { type: 'buffering', on: true, at: T }, { type: 'clock', now: T + 9000 }]);
    expect(view(first, DEFAULT_STRINGS)).toMatchObject({ pause: null, load: { label: 'Getting ready…' } });
  });

  it('a load before the media change and the media change itself both start on the loading screen; clock, keys and sender stay', () => {
    const st = run([{ type: 'ui', who: 'Anna', motion: false }, { type: 'key' }, { type: 'clock', now: T }, { type: 'load' }, { type: 'media', castId: B }]);
    expect(st).toMatchObject({ loading: 'first', whoUntil: T + WHO_MS, who: 'Anna', motion: false, keySeen: true, now: T, castId: B });
    expect(view(st, DEFAULT_STRINGS).load).not.toBeNull();
  });

  it('queue advance (no LOAD): the new item shows the loading screen, its first buffering is no stall', () => {
    let st = run([{ type: 'media', castId: A }, item, { type: 'clock', now: T }, { type: 'load' }, { type: 'firstFrame' }], base());
    st = run([{ type: 'clock', now: T + 60_000 }, { type: 'media', castId: B }, { type: 'buffering', on: true, at: T + 60_000 }, { type: 'clock', now: T + 64_000 }], st);
    expect(view(st, DEFAULT_STRINGS)).toMatchObject({ pause: null, load: { label: 'Getting ready…' }, who: expect.any(String) });
    st = run([{ type: 'firstFrame' }], st);
    expect(view(st, DEFAULT_STRINGS).load).toBeNull();
  });

  it('"Still there?" hold: the centred card only, no pause or loading screen on top', () => {
    const next = { castId: B, label: 'S1:E5 · Wrenfield Pier', auto: true, ask: true };
    let st = run([{ type: 'media', castId: A }, { type: 'item', msg: { t: 'item', castId: A, episode: true, segs: [], next, meta } }, { type: 'media', castId: B }]);
    expect(view(st, DEFAULT_STRINGS)).toMatchObject({ still: expect.anything(), load: null });
    st = run([{ type: 'pause', paused: true, at: T }, { type: 'clock', now: T + PAUSE_SHOW_MS }], st);
    expect(view(st, DEFAULT_STRINGS)).toMatchObject({ still: expect.anything(), pause: null, load: null });
  });

  it('sender pill for 5 s after a load and with any overlay', () => {
    const st = base();
    expect(view(st, DEFAULT_STRINGS).who).toBe('Cast from Anna\'s phone');
    const later = run([{ type: 'clock', now: T + WHO_MS }], st);
    expect(view(later, DEFAULT_STRINGS).who).toBeNull();
    expect(view(run([{ type: 'clock', now: T + WHO_MS - 1 }], st), DEFAULT_STRINGS).who).not.toBeNull();
    const paused = run([{ type: 'pause', paused: true, at: T + 20_000 }, { type: 'clock', now: T + 21_500 }], later);
    expect(view(paused, DEFAULT_STRINGS).who).toBe('Cast from Anna\'s phone');
    expect(view(run([{ type: 'pause', paused: false, at: T + 22_000 }], paused), DEFAULT_STRINGS).who).toBeNull();
    // loading shows it too; no sender text, no pill
    expect(view(run([{ type: 'load' }], later), DEFAULT_STRINGS).who).not.toBeNull();
    expect(view(run([{ type: 'ui', who: '', motion: true }, { type: 'load' }], later), DEFAULT_STRINGS).who).toBeNull();
  });

  it('key hint appears only after a key; touch shows buttons', () => {
    const NEXT = { castId: B, label: 'S1:E5 · Wrenfield Pier', auto: true, ask: false };
    const card = (extra: Ev[]) => run([{ type: 'media', castId: A }, { type: 'item', msg: { t: 'item', castId: A, episode: true, segs: [], next: NEXT, meta } }, { type: 'time', pos: 2630, dur: 2640, playing: true, dt: 1000 }, ...extra]);
    expect(view(card([]), DEFAULT_STRINGS)).toMatchObject({ hint: 'phone', card: { hint: 'Cancel on your phone', buttons: false, name: 'S1:E5 · Wrenfield Pier', secondary: 'Watch credits' } });
    expect(view(card([{ type: 'key' }]), DEFAULT_STRINGS)).toMatchObject({ hint: 'keys', card: { hint: 'OK plays now · Back stops here', buttons: false } });
    const t = view(card([{ type: 'touch' }]), DEFAULT_STRINGS);
    expect(t).toMatchObject({ hint: 'touch', card: { hint: '', buttons: true, secondary: 'Stop here' } });
    // "Stop here" is the existing cancel; Play now the existing playNow
    expect(step(card([{ type: 'touch' }]), { type: 'cancel' }).actions).toEqual(['send-cancel']);
  });

  it('pausing during the up-next card gives both the card and the pause screen (the page lays them out side by side)', () => {
    const NEXT = { castId: B, label: 'S1:E5 · Wrenfield Pier', auto: true, ask: false };
    const st = run([{ type: 'media', castId: A }, { type: 'item', msg: { t: 'item', castId: A, episode: true, segs: [], next: NEXT, meta } }, { type: 'clock', now: T }, { type: 'firstFrame' },
      { type: 'time', pos: 2630, dur: 2640, playing: true, dt: 1000 }, { type: 'pause', paused: true, at: T }, { type: 'clock', now: T + PAUSE_SHOW_MS }]);
    const v = view(st, DEFAULT_STRINGS);
    expect(v.card).toMatchObject({ mode: 'next', name: 'S1:E5 · Wrenfield Pier' });
    expect(v.pause).toMatchObject({ label: 'Paused', title: 'Dunmoor', pos: 2630, dur: 2640 });
    expect(v.card!.progress).toBe(0.1); // the countdown stands while paused
    expect(view(run([{ type: 'time', pos: 2630, dur: 2640, playing: false, dt: 5000 }], st), DEFAULT_STRINGS).card!.progress).toBe(0.1);
  });

  it('the card without a countdown is titled "Up next" in the sender\'s language', () => {
    const t = { ...DEFAULT_STRINGS, upNextTitle: 'Als Nächstes', next: 'Nächste Folge' };
    const NEXT = { castId: B, label: 'E5', auto: false, ask: false };
    const st = run([{ type: 'media', castId: A }, { type: 'item', msg: { t: 'item', castId: A, episode: true, segs: [], next: NEXT, meta } }, { type: 'time', pos: 2630, dur: 2640, playing: true, dt: 1000 }]);
    expect(view(st, t).card!.title).toBe('Als Nächstes');
  });

  it('answering "Still there?" shows no loading screen: the held item\'s frame is already up', () => {
    const NEXT = { castId: B, label: 'E5', auto: true, ask: true };
    let st = run([{ type: 'media', castId: A }, { type: 'item', msg: { t: 'item', castId: A, episode: true, segs: [], next: NEXT, meta } }, { type: 'clock', now: T }, { type: 'firstFrame' },
      { type: 'time', pos: 2630, dur: 2640, playing: true, dt: 1000 }, { type: 'media', castId: B }, { type: 'pause', paused: true, at: T }]);
    expect(view(st, DEFAULT_STRINGS).still).not.toBeNull();
    st = step(st, { type: 'confirm' }).st;
    st = run([{ type: 'clock', now: T + 3000 }], st);
    expect(view(st, DEFAULT_STRINGS)).toMatchObject({ load: null, still: null });
  });

  it('a paused re-load (no autoplay) ends the loading screen and shows the pause screen', () => {
    const st = run([{ type: 'load', at: 0 }, { type: 'media', castId: B }, { type: 'pause', paused: true, at: 100 }, { type: 'clock', now: 1600 }]);
    const v = view(st, DEFAULT_STRINGS);
    expect(v.load).toBeNull();
    expect(v.pause).toMatchObject({ label: 'Paused' });
  });

  it('a LOAD clears the previous title; a queue advance takes the queued episode\'s own title and line', () => {
    const NEXT = { castId: B, label: 'S1:E5 · Wrenfield Pier', auto: true, ask: false, meta: { title: 'Dunmoor', line: 'Season 1 · Episode 5 · Wrenfield Pier' } };
    const playing = run([{ type: 'media', castId: A }, { type: 'item', msg: { t: 'item', castId: A, episode: true, segs: [], next: NEXT, meta } }, { type: 'firstFrame' }]);
    expect(view(step(playing, { type: 'load' }).st, DEFAULT_STRINGS).load).toMatchObject({ title: '', line: '' });
    expect(view(step(playing, { type: 'media', castId: B }).st, DEFAULT_STRINGS).load).toMatchObject({ title: 'Dunmoor', line: 'Season 1 · Episode 5 · Wrenfield Pier' });
  });

  it('item.next.meta is parsed with the same caps', () => {
    const m = parseMessage({ t: 'item', castId: A, next: { castId: B, label: 'x', meta: { title: 'Dunmoor', line: 'l' } } }) as { next: { meta?: unknown } };
    expect(m.next.meta).toEqual({ title: 'Dunmoor', line: 'l' });
    expect((parseMessage({ t: 'item', castId: A, next: { castId: B, label: 'x', meta: { title: 'x'.repeat(201) } } }) as { next: { meta?: unknown } }).next.meta).toBeUndefined();
  });

  it('formatTime and the ±10 s seek target', () => {
    expect([formatTime(0), formatTime(59.9), formatTime(754), formatTime(2640), formatTime(3723), formatTime(-5), formatTime(NaN)]).toEqual(['0:00', '0:59', '12:34', '44:00', '1:02:03', '0:00', '0:00']);
    expect([seekTarget(754, 2640, 1), seekTarget(754, 2640, -1), seekTarget(4, 2640, -1), seekTarget(2635, 2640, 1), seekTarget(30, 0, 1)]).toEqual([764, 744, 0, 2639, 40]);
  });

  it('the item message carries meta, the ui message who and motion; oversized or wrong types are dropped', () => {
    expect(parseMessage({ t: 'item', castId: A, meta: { title: ' Dunmoor ', line: meta.line } })).toMatchObject({ meta });
    expect(parseMessage({ t: 'item', castId: A, meta: { title: 'Saltwater Almanac', line: 5 } })).toMatchObject({ meta: { title: 'Saltwater Almanac', line: '' } });
    expect(parseMessage({ t: 'item', castId: A, meta: { title: 'x'.repeat(201), line: 'ok' } })).not.toHaveProperty('meta');
    expect(parseMessage({ t: 'item', castId: A, meta: 'Dunmoor' })).not.toHaveProperty('meta');
  });

  it('parseMessage refuses an oversized who and non-boolean motion', () => {
    expect(parseMessage({ t: 'ui', who: 'Cast from Anna\'s phone', motion: false })).toMatchObject({ who: 'Cast from Anna\'s phone', motion: false });
    expect(parseMessage({ t: 'ui', who: 'x'.repeat(81) })).toMatchObject({ who: '', motion: true });
    expect(parseMessage({ t: 'ui', who: 'x'.repeat(80), motion: 'no' })).toMatchObject({ who: 'x'.repeat(80), motion: true });
    expect(parseMessage({ t: 'ui', who: 7, motion: 0 })).toMatchObject({ who: '', motion: true });
  });

  it('ui: the new strings with English fallbacks, upNextIn per second', () => {
    const m = parseMessage({ t: 'ui', strings: { upNextIn: ['In 1 s', 'In 2 s'], keys: 'OK', paused: 'Pausiert', loading: 5 } }) as { strings: typeof DEFAULT_STRINGS };
    expect(m.strings).toMatchObject({ upNextIn: ['In 1 s', 'In 2 s'], keys: 'OK', paused: 'Pausiert', loading: 'Getting ready…', stall: 'Loading…', phoneCancel: 'Cancel on your phone', stopHere: 'Stop here', stillKeys: 'OK keeps watching' });
    expect(DEFAULT_STRINGS.upNextIn).toHaveLength(COUNTDOWN_SECONDS);
    expect(DEFAULT_STRINGS.upNextIn[9]).toBe('Up next in 10 s');
    expect(DEFAULT_STRINGS.upNextTitle).toBe('Up next');
  });
});

describe('receiver: a live channel (customData.ui.live)', () => {
  type Ev = Parameters<typeof step>[1];
  const run = (evs: Ev[], st = initialState()) => { for (const e of evs) st = step(st, e).st; return st; };
  const T = 200_000;
  /** the sender's LOAD, as the web engine and the Android app send it */
  const media = { contentId: 'https://friend.example.com/media/l/tok/index.m3u8', contentType: 'application/x-mpegURL', streamType: 'LIVE',
    metadata: { title: 'Nordlicht TV', subtitle: 'Die Leuchtturmwärter', images: [{ url: 'https://friend.example.com/api/livetv/logos/ab?exp=1&sig=x' }] }, customData: { ui: { live: true } } };
  const t = { ...DEFAULT_STRINGS, now: 'Jetzt', live: 'LIVE' };

  it('liveOf reads only a live load, with bounded texts', () => {
    expect(liveOf(media)).toEqual({ name: 'Nordlicht TV', now: 'Die Leuchtturmwärter' });
    expect(liveOf({ ...media, metadata: { title: 'Hafenkanal' } })).toEqual({ name: 'Hafenkanal', now: '' });
    expect(liveOf({ ...media, metadata: { title: 'x'.repeat(201), subtitle: 5 } })).toEqual({ name: '', now: '' });
    for (const no of [null, 'x', { customData: { ff: { castId: 'a'.repeat(32) } } }, { customData: { ui: { live: 'yes' } } }, { metadata: { title: 'Film' } }]) expect(liveOf(no)).toBeNull();
    expect(parseMessage({ t: 'ui', strings: { now: 'Jetzt', live: 'LIVE' } })).toMatchObject({ strings: { now: 'Jetzt', live: 'LIVE' } });
    expect(DEFAULT_STRINGS).toMatchObject({ now: 'Now', live: 'LIVE' });
  });

  it('ui.live shows the channel card and the Jetzt line, no progress bar', () => {
    let st = run([{ type: 'clock', now: T }, { type: 'load', at: T, live: liveOf(media) }]);
    // the channel card on load: the loading screen names the channel and its Jetzt line; the LIVE badge from the start
    expect(view(st, t)).toMatchObject({ load: { title: 'Nordlicht TV', line: 'Jetzt: Die Leuchtturmwärter', label: t.loading, live: true }, live: { badge: 'LIVE', card: null }, card: null });
    // first frame: the card (logo, name, Jetzt) for LIVE_CARD_MS, the badge stays
    st = run([{ type: 'firstFrame' }, { type: 'time', pos: 3, dur: Infinity, playing: true, dt: 250 }], st);
    expect(view(st, t)).toMatchObject({ load: null, live: { badge: 'LIVE', card: { name: 'Nordlicht TV', now: 'Jetzt: Die Leuchtturmwärter' } } });
    expect(view(run([{ type: 'clock', now: T + LIVE_CARD_MS - 1 }], st), t).live?.card).not.toBeNull();
    st = run([{ type: 'clock', now: T + LIVE_CARD_MS }], st);
    expect(view(st, t)).toMatchObject({ live: { badge: 'LIVE', card: null }, card: null, skip: null });
    // paused: the pause screen names the channel, without a progress bar or times
    st = run([{ type: 'pause', paused: true, at: T + 10_000 }, { type: 'clock', now: T + 10_000 + PAUSE_SHOW_MS }], st);
    expect(view(st, t).pause).toEqual({ label: 'Paused', title: 'Nordlicht TV', line: 'Jetzt: Die Leuchtturmwärter', pos: 0, dur: 0, live: true });
    // no programme: no Jetzt line
    const bare = run([{ type: 'load', at: T, live: { name: 'Sternwarte 24', now: '' } }]);
    expect(view(bare, t).load).toMatchObject({ title: 'Sternwarte 24', line: '' });
    // a title loaded after the channel: no badge, the title's own pause screen with its progress
    const film = run([{ type: 'load', at: T }, { type: 'media', castId: A }, { type: 'firstFrame' }, { type: 'time', pos: 754, dur: 2640, playing: true, dt: 250 }, { type: 'pause', paused: true, at: T }, { type: 'clock', now: T + PAUSE_SHOW_MS }], st);
    expect(view(film, t).live).toBeNull();
    expect(view(film, t).pause).toMatchObject({ pos: 754, dur: 2640 });
    expect(view(film, t).pause).not.toHaveProperty('live');
  });

  it('the page has the badge and the channel card; the script draws them and drops the progress bar for a channel', async () => {
    const html = receiverHtml();
    for (const id of ['badge', 'badge-text', 'lcard', 'lcard-img', 'lcard-name', 'lcard-now']) expect(html, id).toContain(`id="${id}"`);
    const { readFileSync } = await import('node:fs');
    const js = readFileSync(new URL('../../../static/cast-receiver/receiver.js', import.meta.url), 'utf8');
    expect(js).toContain("run({ type: 'load', at: nowMs(), live });");
    expect(js).toContain("$('pause').classList.toggle('live', Boolean(v.pause.live))");
    const css = readFileSync(new URL('../../../static/cast-receiver/receiver.css', import.meta.url), 'utf8');
    expect(css).toContain('.pause.live .pbar, .pause.live .times { display: none; }');
  });
});

describe('receiver: progress reports with the report token', () => {
  function rig() {
    let now = 1_000_000;
    const posts: Array<{ rt: string; event: string; positionTicks: number; isPaused: boolean }> = [];
    let status = 200;
    const r = createReporter({ now: () => now, post: vi.fn(async (b) => { posts.push(b); return status; }) });
    return { r, posts, tick: (ms: number) => { now += ms; }, setStatus: (s: number) => { status = s; } };
  }

  it('start once it plays, progress on the cadence and on pause, stop at the end; never without a token', async () => {
    const { r, posts, tick } = rig();
    r.media(A);
    await r.time(5, false); // no token yet: nothing
    expect(posts).toEqual([]);
    await r.token(A, RT); // the token arrives while it plays: start now
    expect(posts.map((p) => p.event)).toEqual(['start']);
    expect(posts[0]).toEqual({ rt: RT, event: 'start', positionTicks: 50_000_000, isPaused: false });
    tick(1000); await r.time(6, false);
    expect(posts).toHaveLength(1);
    tick(1000); await r.time(7, true); // paused: at once
    tick(PROGRESS_MS); await r.time(8, false);
    expect(posts.map((p) => [p.event, p.isPaused])).toEqual([['start', false], ['progress', true], ['progress', false]]);
    await r.end(1800);
    await r.time(1801, false);
    expect(posts.at(-1)).toMatchObject({ event: 'stop', positionTicks: 18_000_000_000, isPaused: true });
    expect(posts).toHaveLength(4);
  });

  it('moving on: the ended token\'s stop goes before the next one\'s start; a refused start (409) is tried again later', async () => {
    const { r, posts, tick, setStatus } = rig();
    r.token(A, RT); r.token(B, RT.replace('eyJ', 'eyK'));
    r.media(A);
    await r.time(10, false);
    r.media(B); // the receiver moved on to the queued token (no MEDIA_FINISHED seen)
    setStatus(409);
    await r.time(0, false);
    expect(posts.map((p) => [p.event, p.rt === RT ? 'A' : 'B'])).toEqual([['start', 'A'], ['stop', 'A'], ['start', 'B']]);
    expect(r.current).toMatchObject({ castId: B, started: false });
    setStatus(200);
    tick(1000); await r.time(1, false);
    expect(posts).toHaveLength(3);
    tick(PROGRESS_MS); await r.time(16, false);
    expect(posts.at(-1)).toMatchObject({ event: 'start' });
    expect(r.current).toMatchObject({ started: true });
  });

  it('a revoked token (401) is dropped: nothing more is sent with it', async () => {
    const { r, posts, tick, setStatus } = rig();
    r.token(A, RT); r.media(A);
    setStatus(401);
    await r.time(1, false);
    tick(PROGRESS_MS); await r.time(20, false);
    expect(posts).toHaveLength(1);
  });
});

describe('receiver page', () => {
  it('has every element the script renders into; the script puts sender texts on the page as text only', async () => {
    const html = receiverHtml();
    for (const id of ['who', 'card', 'card-img', 'card-title', 'card-name', 'card-hint', 'card-buttons', 'card-primary', 'card-secondary', 'pause', 'pause-label', 'pause-title', 'pause-line', 'pause-pos', 'pause-dur',
      'load', 'load-art', 'load-title', 'load-line', 'load-label', 'skip', 'still', 'still-title', 'still-text', 'still-hint', 'still-primary', 'scrim']) expect(html, id).toContain(`id="${id}"`);
    expect(html).not.toMatch(/\sstyle=|\son\w+=/);
    const { readFileSync } = await import('node:fs');
    const js = readFileSync(new URL('../../../static/cast-receiver/receiver.js', import.meta.url), 'utf8');
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/);
    expect(js).not.toContain('card-text'); // the temporary "Als Nächstes: <episode>" bridge is gone
    expect(js).not.toMatch(/strings\.upNext\.replace/);
  });

  it('loads Google\'s receiver framework and its own static files; nothing else', () => {
    const html = receiverHtml();
    expect(html).toContain(`<script src="${CAF_URL}"></script>`);
    expect(html).toContain('<script type="module" src="/cast-receiver/receiver.js"></script>');
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(CAF_URL.startsWith('https://www.gstatic.com/cast/sdk/libs/')).toBe(true);
  });

  it('is served at /cast-receiver/ with its own strict CSP that allows the Cast libraries only there', async () => {
    expect(trailingSlash).toBe('always');
    const res = await (GET as unknown as () => Response)();
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toBe(RECEIVER_CSP);
    expect(csp).toContain("script-src 'self' https://www.gstatic.com/cast/sdk/libs/");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|\*/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await res.text()).toBe(receiverHtml());
  });
});
