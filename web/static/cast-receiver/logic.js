// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
/**
 * FriendFlix's own Cast Web Receiver: the pure logic (no DOM, no Cast SDK, no timers), unit-tested from
 * web/src/lib/cast/receiver.test.ts. receiver.js wires it to the Cast Application Framework and the page.
 *
 * - parseMessage: what the sender may send on the private channel (urn:x-cast:com.friendflix.cast), strictly validated.
 * - creditsStart / activeSkip: the same rules as the web player (web/src/lib/player/nextup.ts, engine.ts atPosition).
 * - step / view: the TV's next-up card, its countdown, "still watching?", the skip button, the pause and loading screens, the sender pill and the key hint.
 * - createReporter: start / progress / stop of the playing token to /api/cast/report with its report token.
 * - probeCaps / buildCaps: what this TV (and the AVR behind it) confirms it plays, as the `caps` message the sender attaches to its cast request.
 */

export const NS = 'urn:x-cast:com.friendflix.cast';
export const LAST_SECONDS = 25;
export const COUNTDOWN_SECONDS = 10;
/** progress report cadence while the TV plays (the phone's engine reports every 10 s while it is awake) */
export const PROGRESS_MS = 15_000;
/** the pause screen shows this long after the TV paused (a quick pause / resume never flashes it) */
export const PAUSE_SHOW_MS = 1500;
/** the sender pill shows this long after a load (and as long as a card, the pause or the loading screen is up) */
export const WHO_MS = 5000;
/** a buffering stall this long mid-playback shows the paused layout with "Loading…" */
export const STALL_SHOW_MS = 3000;

const CAST_ID = /^[0-9a-f]{32}$/;
const RT = /^[A-Za-z0-9_-]{16,1024}\.[A-Za-z0-9_-]{43}$/;
const SIZES = ['s', 'm', 'l', 'xl'];
const COLORS = ['white', 'yellow', 'cyan', 'green'];
const BACKS = ['none', 'shadow', 'semi', 'solid'];
const FONTS = ['sans', 'serif', 'mono'];

/** @param {unknown} v @param {number} max */
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
/** @param {unknown} v @param {string[]} list @param {string} dflt */
const pick = (v, list, dflt) => (typeof v === 'string' && list.includes(v) ? v : dflt);

/**
 * @typedef {{ type: string, start: number, end: number }} Segment
 * @typedef {{ castId: string, label: string, auto: boolean, ask: boolean }} Next
 * @typedef {{ size: string, color: string, background: string, font: string }} SubStyle
 * @typedef {{ next: string, upNext: string, watchCredits: string, startsIn: string[], stillTitle: string, stillText: string, keepWatching: string, skip: { intro: string, recap: string },
 *   upNextIn: string[], keys: string, phoneCancel: string, stopHere: string, stillKeys: string, loading: string, stall: string, paused: string }} Strings
 * @typedef {{ title: string, line: string }} Meta
 * @typedef {{ t: 'tok', castId: string, rt: string }
 *   | { t: 'caps?' }
 *   | { t: 'item', castId: string, episode: boolean, segs: Segment[], next: Next | null, meta?: Meta | null }
 *   | { t: 'ui', strings: Strings, sub: SubStyle, countdown: number, who: string, motion: boolean }} Message
 */

/** English texts until the sender sent its own (in the viewer's language) */
export const DEFAULT_STRINGS = /** @type {Strings} */ ({
  next: 'Next episode', upNext: 'Next: {label}', watchCredits: 'Watch credits',
  startsIn: Array.from({ length: COUNTDOWN_SECONDS }, (_, i) => `Next episode starts in ${i + 1} second${i ? 's' : ''}`),
  stillTitle: 'Still there?', stillText: 'Autoplay is paused. Up next: {ep}', keepWatching: 'Continue watching',
  skip: { intro: 'Skip intro', recap: 'Skip recap' },
  upNextIn: Array.from({ length: COUNTDOWN_SECONDS }, (_, i) => `Up next in ${i + 1} s`),
  keys: 'OK plays now · Back stops here', phoneCancel: 'Cancel on your phone', stopHere: 'Stop here', stillKeys: 'OK keeps watching',
  loading: 'Getting ready…', stall: 'Loading…', paused: 'Paused',
});

/**
 * A message from the sender, or null when it is not one we accept (anything else is ignored).
 * @param {unknown} raw string (CAF delivers the JSON text) or an already parsed object
 * @returns {Message | null}
 */
export function parseMessage(raw) {
  let m = raw;
  if (typeof raw === 'string') {
    if (raw.length > 32_768) return null;
    try { m = JSON.parse(raw); } catch { return null; }
  }
  if (!m || typeof m !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (m);
  if (o.t === 'caps?') return { t: 'caps?' }; // the sender asks what this TV plays; nothing in it is taken over
  if (o.t === 'tok') {
    const castId = str(o.castId, 32), rt = str(o.rt, 1100);
    return castId && CAST_ID.test(castId) && rt && RT.test(rt) ? { t: 'tok', castId, rt } : null;
  }
  if (o.t === 'item') {
    const castId = str(o.castId, 32);
    if (!castId || !CAST_ID.test(castId)) return null;
    /** @type {Segment[]} */
    const segs = [];
    for (const x of Array.isArray(o.segs) ? o.segs.slice(0, 20) : []) {
      const s = /** @type {Record<string, unknown>} */ (x ?? {});
      const type = str(s.type, 20), start = num(s.start), end = num(s.end);
      if (type && start !== null && end !== null && end > start) segs.push({ type: type.toLowerCase(), start, end });
    }
    const n = /** @type {Record<string, unknown> | null} */ (o.next && typeof o.next === 'object' ? o.next : null);
    const nid = n ? str(n.castId, 32) : null;
    const next = n && nid && CAST_ID.test(nid) ? { castId: nid, label: (str(n.label, 200) ?? '').trim(), auto: n.auto === true, ask: n.ask === true } : null;
    const mo = /** @type {Record<string, unknown> | null} */ (o.meta && typeof o.meta === 'object' ? o.meta : null);
    const title = mo ? str(mo.title, 200) : null;
    const meta = mo && title !== null ? { title: title.trim(), line: (str(mo.line, 200) ?? '').trim() } : null;
    return { t: 'item', castId, episode: o.episode === true, segs, next, ...(meta ? { meta } : {}) };
  }
  if (o.t === 'ui') {
    const s = /** @type {Record<string, unknown>} */ (o.strings && typeof o.strings === 'object' ? o.strings : {});
    /** @param {string} k @param {string} d */
    const text = (k, d) => str(s[k], 300) ?? d;
    const skip = /** @type {Record<string, unknown>} */ (s.skip && typeof s.skip === 'object' ? s.skip : {});
    /** @param {unknown} v @param {string[]} d */
    const list = (v, d) => (Array.isArray(v) && v.length && v.length <= 60 && v.every((x) => str(x, 300) !== null) ? /** @type {string[]} */ (v) : d);
    const startsIn = list(s.startsIn, DEFAULT_STRINGS.startsIn);
    const sub = /** @type {Record<string, unknown>} */ (o.sub && typeof o.sub === 'object' ? o.sub : {});
    const cd = num(o.countdown);
    return {
      t: 'ui',
      strings: {
        next: text('next', DEFAULT_STRINGS.next), upNext: text('upNext', DEFAULT_STRINGS.upNext), watchCredits: text('watchCredits', DEFAULT_STRINGS.watchCredits),
        startsIn, stillTitle: text('stillTitle', DEFAULT_STRINGS.stillTitle), stillText: text('stillText', DEFAULT_STRINGS.stillText),
        keepWatching: text('keepWatching', DEFAULT_STRINGS.keepWatching),
        skip: { intro: str(skip.intro, 100) ?? DEFAULT_STRINGS.skip.intro, recap: str(skip.recap, 100) ?? DEFAULT_STRINGS.skip.recap },
        upNextIn: list(s.upNextIn, DEFAULT_STRINGS.upNextIn), keys: text('keys', DEFAULT_STRINGS.keys), phoneCancel: text('phoneCancel', DEFAULT_STRINGS.phoneCancel),
        stopHere: text('stopHere', DEFAULT_STRINGS.stopHere), stillKeys: text('stillKeys', DEFAULT_STRINGS.stillKeys), loading: text('loading', DEFAULT_STRINGS.loading),
        stall: text('stall', DEFAULT_STRINGS.stall), paused: text('paused', DEFAULT_STRINGS.paused),
      },
      sub: { size: pick(sub.size, SIZES, 'm'), color: pick(sub.color, COLORS, 'white'), background: pick(sub.background, BACKS, 'semi'), font: pick(sub.font, FONTS, 'sans') },
      countdown: cd !== null && cd >= 3 && cd <= 60 ? Math.round(cd) : COUNTDOWN_SECONDS,
      // the profile's display name in a sentence, nothing else; too long = none. motion is false only when the sender says so (calm mode)
      who: str(o.who, 80)?.trim() ?? '',
      motion: o.motion !== false,
    };
  }
  return null;
}

/**
 * The `canDisplayType(mimeType, codecs, width, height, framerate)` questions (CAF `CastReceiverContext`). HEVC is asked as `hvc1` (the tag Jellyfin
 * writes for every HEVC stream, so an `hev1`-only answer would not help) Main and Main 10, Level 4.1, 1920x1080. Dolby as `ec-3` / `ac-3`, which the
 * framework answers from the HDMI sink the TV reports (the AVR). TODO verify on hardware: the exact answers per device (docs/cast-receiver.md).
 */
export const CAPS_PROBES = {
  hevc: ['video/mp4', 'hvc1.1.6.L123.B0', 1920, 1080, 30],
  hevc10: ['video/mp4', 'hvc1.2.4.L123.B0', 1920, 1080, 30],
  eac3: ['audio/mp4', 'ec-3'],
  ac3: ['audio/mp4', 'ac-3'],
};

/**
 * Runs the probes. Only a plain `true` is a yes: unknown, "maybe", undefined or a throw (no such API on this firmware) is a no, and one failing
 * probe never stops the others.
 * @param {(...args: any[]) => unknown} canDisplay `context.canDisplayType` bound to the context
 */
export function probeCaps(canDisplay) {
  /** @param {any[]} args */
  const ask = (args) => { try { return canDisplay(...args) === true; } catch { return false; } };
  return { hevc: ask(CAPS_PROBES.hevc), hevc10: ask(CAPS_PROBES.hevc10), eac3: ask(CAPS_PROBES.eac3), ac3: ask(CAPS_PROBES.ac3) };
}

/**
 * The `caps` message for the private channel. Never a claim before a positive answer: Main 10 only counts together with Main.
 * @param {{ hevc?: unknown, hevc10?: unknown, eac3?: unknown, ac3?: unknown } | null | undefined} probe answers of probeCaps
 */
export function buildCaps(probe) {
  const p = probe ?? {};
  const hevc = p.hevc === true;
  return { t: /** @type {const} */ ('caps'), v: /** @type {const} */ (1), hevc, hevc10: hevc && p.hevc10 === true, surround: [...(p.eac3 === true ? ['eac3'] : []), ...(p.ac3 === true ? ['ac3'] : [])] };
}

/**
 * Second at which the credits begin: the Outro/Credits segment (in the second half), else the last 25 s; Infinity while the
 * duration is unknown. Same rule as web/src/lib/player/nextup.ts creditsStart.
 * @param {Segment[]} segments @param {number} duration
 */
export function creditsStart(segments, duration) {
  if (!(duration > 0)) return Infinity;
  const fallback = Math.max(0, duration - LAST_SECONDS);
  const seg = segments.filter((s) => (s.type === 'outro' || s.type === 'credits') && s.start > 0 && s.start < duration).sort((a, b) => a.start - b.start)[0];
  return seg && seg.start >= duration / 2 ? seg.start : fallback;
}

/**
 * The intro / recap the TV is in (its skip button seeks to `end`), else null. Same rule as the cast engine (atPosition).
 * @param {Segment[]} segments @param {number} pos
 */
export function activeSkip(segments, pos) {
  const s = segments.find((x) => (x.type === 'intro' || x.type === 'recap') && pos >= x.start && pos < x.end - 1);
  return s ? { type: s.type, end: s.end } : null;
}

/** the WebVTT window colours of the web player's subtitle settings (#RRGGBBAA, CAF TextTrackStyle) */
const FG = { white: '#FFFFFFFF', yellow: '#FFEB3BFF', cyan: '#4DD0E1FF', green: '#69F0AEFF' };
const SCALE = { s: 0.8, m: 1, l: 1.25, xl: 1.5 };
/**
 * The user's subtitle style as a CAF TextTrackStyle (plain fields; receiver.js copies them onto the SDK object).
 * @param {SubStyle} sub
 */
export function textTrackStyle(sub) {
  const bg = sub.background;
  return {
    foregroundColor: FG[/** @type {keyof typeof FG} */ (sub.color)] ?? FG.white,
    backgroundColor: bg === 'solid' ? '#000000FF' : bg === 'semi' ? '#000000A0' : '#00000000',
    windowType: 'NONE',
    edgeType: bg === 'shadow' || bg === 'none' ? 'DROP_SHADOW' : 'NONE',
    edgeColor: '#000000FF',
    fontScale: SCALE[/** @type {keyof typeof SCALE} */ (sub.size)] ?? 1,
    fontGenericFamily: sub.font === 'serif' ? 'SERIF' : sub.font === 'mono' ? 'MONOSPACED_SANS_SERIF' : 'SANS_SERIF',
  };
}

/**
 * @typedef {{
 *   castId: string, pos: number, dur: number, playing: boolean,
 *   segs: Segment[], episode: boolean, next: Next | null, countdown: number,
 *   credits: boolean, elapsed: number, dismissed: boolean, answered: boolean, jumped: boolean,
 *   still: boolean, prevNext: Next | null,
 *   now: number, paused: boolean, pausedAt: number | null, loading: 'first' | 'stall' | null, firstFrame: boolean, stallAt: number | null,
 *   keySeen: boolean, touch: boolean, meta: Meta | null, who: string, whoUntil: number, motion: boolean
 * }} State
 * @typedef {{ type: 'time', pos: number, dur: number, playing: boolean, dt: number }
 *   | { type: 'media', castId: string }
 *   | { type: 'item', msg: Extract<Message, { t: 'item' }> }
 *   | { type: 'countdown', seconds: number }
 *   | { type: 'load', at?: number } | { type: 'firstFrame' } | { type: 'buffering', on: boolean, at: number } | { type: 'pause', paused: boolean, at: number }
 *   | { type: 'key' } | { type: 'touch' } | { type: 'clock', now: number } | { type: 'ui', who: string, motion: boolean }
 *   | { type: 'cancel' } | { type: 'playNow' } | { type: 'confirm' } | { type: 'skip' }} Event
 * @typedef {'jump' | 'pause' | 'play' | 'send-cancel' | 'send-interaction' | { seek: number }} Action
 */

/** @returns {State} */
export function initialState() {
  return { castId: '', pos: 0, dur: 0, playing: false, segs: [], episode: false, next: null, countdown: COUNTDOWN_SECONDS,
    credits: false, elapsed: 0, dismissed: false, answered: false, jumped: false, still: false, prevNext: null,
    now: 0, paused: false, pausedAt: null, loading: null, firstFrame: false, stallAt: null, keySeen: false, touch: false, meta: null, who: '', whoUntil: 0, motion: true };
}

/**
 * One event for the TV UI: the new state and what receiver.js must do (jump to the queued episode, pause, seek, tell the sender).
 * The countdown only runs while the TV plays (like the web player's), the queued episode only starts by itself when the sender
 * allowed it (`next.auto`) and "still watching?" (`next.ask`) was answered.
 * @param {State} st @param {Event} ev @returns {{ st: State, actions: Action[] }}
 */
export function step(st, ev) {
  /** @type {Action[]} */
  const actions = [];
  let s = { ...st };
  switch (ev.type) {
    case 'media': {
      if (ev.castId === s.castId) break;
      // the receiver moved on: to the queued episode that waits for "still watching?" -> it stays paused under the question
      const waiting = Boolean(s.next && s.next.castId === ev.castId && s.next.ask && !s.answered);
      // what belongs to the TV session (clock, keys, touch, sender pill, motion) and a load that just started (LOAD comes before the media change) stay
      s = { ...initialState(), countdown: s.countdown, castId: ev.castId, still: waiting, prevNext: s.next,
        now: s.now, keySeen: s.keySeen, touch: s.touch, who: s.who, whoUntil: s.whoUntil, motion: s.motion, loading: s.loading === 'first' ? 'first' : null, firstFrame: s.firstFrame && s.loading !== 'first' };
      if (waiting) actions.push('pause');
      break;
    }
    case 'item':
      if (ev.msg.castId !== s.castId) break;
      s.segs = ev.msg.segs; s.episode = ev.msg.episode; s.meta = ev.msg.meta ?? null;
      if (!sameNext(s.next, ev.msg.next)) { s.next = ev.msg.next; s.elapsed = 0; s.jumped = false; s.answered = false; }
      break;
    case 'countdown':
      s.countdown = ev.seconds;
      break;
    case 'time': {
      s.pos = ev.pos; s.dur = ev.dur > 0 ? ev.dur : s.dur; s.playing = ev.playing;
      if (s.still && ev.playing) s.still = false; // played from the phone / another sender: answered
      const at = creditsStart(s.segs, s.dur);
      if (!s.credits && s.episode && s.pos >= at) s.credits = true;
      else if (s.credits && s.pos < at - 2) { s.credits = false; s.elapsed = 0; s.dismissed = false; s.jumped = false; }
      if (counting(s)) {
        s.elapsed = Math.min(s.countdown * 1000, s.elapsed + Math.max(0, ev.dt));
        if (s.elapsed >= s.countdown * 1000 && !s.jumped) { s.jumped = true; actions.push('jump'); }
      }
      break;
    }
    case 'load': // new media: the loading screen until the first frame, the sender pill for WHO_MS
      s.now = ev.at ?? s.now;
      s.loading = 'first'; s.firstFrame = false; s.stallAt = null; s.paused = false; s.pausedAt = null; s.whoUntil = s.now + WHO_MS;
      break;
    case 'firstFrame':
      s.firstFrame = true;
      if (s.loading === 'first') s.loading = null;
      break;
    case 'buffering':
      s.now = Math.max(s.now, ev.at);
      if (ev.on) { if (s.loading === null) { s.loading = 'stall'; s.stallAt = ev.at; } } // while the first frame is awaited the loading screen already shows
      else if (s.loading === 'stall') { s.loading = null; s.stallAt = null; }
      break;
    case 'pause':
      s.now = Math.max(s.now, ev.at);
      if (ev.paused) { if (!s.paused) { s.paused = true; s.pausedAt = ev.at; } } else { s.paused = false; s.pausedAt = null; }
      break;
    case 'key': s.keySeen = true; break;
    case 'touch': s.touch = true; break;
    case 'clock': s.now = ev.now; break;
    case 'ui': s.who = ev.who; s.motion = ev.motion; break;
    case 'cancel':
      if (cardOf(s)) { s.dismissed = true; s.elapsed = 0; actions.push('send-cancel'); }
      break;
    case 'playNow':
      if (cardOf(s) && s.next && !s.jumped) { s.jumped = true; actions.push('jump', 'send-interaction'); }
      break;
    case 'confirm':
      if (s.still) { s.still = false; actions.push('play', 'send-interaction'); }
      else if (cardOf(s)?.mode === 'still') { s.answered = true; s.elapsed = 0; actions.push('send-interaction'); }
      break;
    case 'skip': {
      const k = activeSkip(s.segs, s.pos);
      if (k) actions.push({ seek: k.end }, 'send-interaction');
      break;
    }
  }
  return { st: s, actions };
}

/** @param {Next | null} a @param {Next | null} b */
const sameNext = (a, b) => (a === null || b === null ? a === b : a.castId === b.castId && a.auto === b.auto && a.ask === b.ask && a.label === b.label);
/** @param {State} s */
const counting = (s) => { const c = cardOf(s); return Boolean(c && c.mode === 'next' && c.auto && s.playing); };

/**
 * The card in the credits: 'still' = "still watching?" (no countdown), 'next' = the queued episode (countdown when auto).
 * @param {State} s @returns {{ mode: 'next' | 'still', auto: boolean } | null}
 */
function cardOf(s) {
  if (!s.credits || !s.next || s.dismissed || s.still || s.jumped) return null;
  if (s.next.ask && !s.answered) return { mode: 'still', auto: false };
  return { mode: 'next', auto: s.next.auto };
}

/**
 * What the TV shows for a state.
 * @param {State} s @param {Strings} t
 */
export function view(s, t) {
  const c = cardOf(s);
  const k = s.still ? null : activeSkip(s.segs, s.pos);
  const left = Math.max(0, Math.ceil((s.countdown * 1000 - s.elapsed) / 1000));
  const label = s.next?.label ?? '';
  const prev = s.prevNext?.label ?? '';
  const hint = /** @type {'keys' | 'phone' | 'touch'} */ (s.touch ? 'touch' : s.keySeen ? 'keys' : 'phone');
  const hintText = hint === 'keys' ? t.keys : hint === 'phone' ? t.phoneCancel : '';
  const stalled = s.loading === 'stall' && s.stallAt !== null && s.now - s.stallAt >= STALL_SHOW_MS;
  const paused = s.paused && s.pausedAt !== null && s.now - s.pausedAt >= PAUSE_SHOW_MS;
  const pause = s.loading !== 'first' && (stalled || paused)
    ? { label: stalled ? t.stall : t.paused, title: s.meta?.title ?? '', line: s.meta?.line ?? '', pos: s.pos, dur: s.dur } : null;
  const load = s.loading === 'first' ? { title: s.meta?.title ?? '', line: s.meta?.line ?? '', label: t.loading } : null;
  return {
    pause, load,
    who: s.who && (s.now < s.whoUntil || pause || load || c || s.still) ? s.who : null,
    hint,
    skip: k ? { end: k.end, text: k.type === 'recap' ? t.skip.recap : t.skip.intro } : null,
    card: c ? {
      mode: c.mode,
      title: c.mode === 'still' ? t.stillTitle : c.auto && left > 0 ? (t.upNextIn[left - 1] ?? t.next) : t.next,
      /** the queued episode's name ("E5 · Wrenfield Pier") */
      name: c.mode === 'still' ? t.stillText.replace('{ep}', label) : label,
      /** the key hint line; empty on touch devices (they get buttons) */
      hint: c.mode === 'still' ? (s.touch ? '' : t.stillKeys) : hintText,
      /** touch devices (Nest Hub) get "Play now" and "Stop here" buttons instead of a key hint */
      buttons: s.touch,
      text: c.mode === 'still' ? t.stillText.replace('{ep}', label) : c.auto && left > 0 ? (t.startsIn[left - 1] ?? '') : '',
      primary: c.mode === 'still' ? t.keepWatching : t.next,
      secondary: c.mode === 'still' ? '' : s.touch ? t.stopHere : t.watchCredits,
      /** 0..1 of the countdown ring (0 without a countdown) */
      progress: c.auto ? Math.min(1, s.elapsed / (s.countdown * 1000)) : 0,
    } : null,
    still: s.still ? { title: t.stillTitle, text: t.stillText.replace('{ep}', prev), primary: t.keepWatching } : null,
  };
}

/**
 * Report state of the receiver: which token plays, whether its `start` went through, the queue of posts (kept in order: the
 * ended token's stop before the next one's start, which the server refuses while the ended one still plays).
 * @param {{ post: (body: { rt: string, event: 'start' | 'progress' | 'stop', positionTicks: number, isPaused: boolean }) => Promise<number>, now: () => number }} io
 *   post resolves the HTTP status (0 = network error); it never sees anything but the report token and the position
 */
export function createReporter(io) {
  /** @type {Map<string, string>} castId -> report token (the playing one and a queued one) */
  const tokens = new Map();
  /** @type {{ castId: string, started: boolean, stopped: boolean, last: number, pos: number, paused: boolean } | null} */
  let cur = null;
  let chain = Promise.resolve();
  /** @param {string} castId @param {'start' | 'progress' | 'stop'} event @param {number} pos @param {boolean} paused */
  const send = (castId, event, pos, paused) => {
    const rt = tokens.get(castId);
    if (!rt) return chain;
    const c = cur;
    chain = chain.then(() => io.post({ rt, event, positionTicks: Math.max(0, Math.round(pos * 10_000_000)), isPaused: paused }).catch(() => 0)).then((status) => {
      if (event === 'start' && c && c.castId === castId && status >= 200 && status < 300) c.started = true;
      if (status === 401 || status === 404) tokens.delete(castId); // revoked / expired / feature off: nothing more to report with it
    });
    return chain;
  };
  return {
    /** a report token arrived for `castId` (a queued one is kept for later) */
    token(/** @type {string} */ castId, /** @type {string} */ rt) {
      // the first token for a castId stays (another sender on the TV's network cannot swap it for a bogus one)
      if (!tokens.has(castId)) tokens.set(castId, rt);
      while (tokens.size > 4) tokens.delete(/** @type {string} */ (tokens.keys().next().value));
      if (cur && cur.castId === castId && !cur.started && !cur.paused && cur.last > 0) return send(castId, 'start', cur.pos, false);
      return chain;
    },
    /** another token is current on the TV: the previous one is stopped (once) at its last position */
    media(/** @type {string} */ castId) {
      if (cur?.castId === castId) return chain;
      const prev = cur;
      cur = { castId, started: false, stopped: false, last: 0, pos: 0, paused: true };
      if (prev && prev.started && !prev.stopped) { prev.stopped = true; send(prev.castId, 'stop', prev.pos, true); }
      return chain;
    },
    /** a position update of the current token: start (first time it plays), progress (cadence, pause change) */
    time(/** @type {number} */ pos, /** @type {boolean} */ paused) {
      const c = cur;
      if (!c || c.stopped) return chain;
      const changed = c.paused !== paused;
      c.pos = pos; c.paused = paused;
      const now = io.now();
      if (!c.started) {
        if (!paused && (c.last === 0 || now - c.last >= PROGRESS_MS)) { c.last = now; return send(c.castId, 'start', pos, false); }
        return chain;
      }
      if (changed || now - c.last >= PROGRESS_MS) { c.last = now; return send(c.castId, 'progress', pos, paused); }
      return chain;
    },
    /** the current token ended / was stopped on the TV */
    end(/** @type {number} */ pos) {
      const c = cur;
      if (!c || c.stopped) return chain;
      c.stopped = true;
      if (c.started) send(c.castId, 'stop', pos, true);
      return chain;
    },
    /** tests */
    get current() { return cur ? { ...cur } : null; },
  };
}
