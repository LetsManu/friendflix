// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { creditsStart as playerCredits } from '#lib/player/nextup';
import { CAST_NS } from '#lib/cast';
import {
  COUNTDOWN_SECONDS, DEFAULT_STRINGS, NS, PROGRESS_MS, activeSkip, createReporter, creditsStart, initialState, parseMessage, step, textTrackStyle, view,
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
    expect(v).toMatchObject({ mode: 'next', title: 'Next: S1:E2 · Two', text: 'Next episode starts in 6 seconds', primary: 'Next episode', secondary: 'Watch credits' });
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
    expect(view(st, DEFAULT_STRINGS).card).toMatchObject({ text: '', progress: 0 });
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
