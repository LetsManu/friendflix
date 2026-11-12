// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Cast Application Framework (CAF v3) global `cast` has no types here (not type-checked); the logic lives in logic.js (tested)
/* global cast, document, fetch, setInterval, performance, location, URL */
/**
 * FriendFlix's own Cast Web Receiver (served at /cast-receiver/, registered as CAST_RECEIVER_APP_ID in the Google Cast console).
 *
 * The TV has no FriendFlix session and never gets one. What it may do:
 * - play the token URLs the sender loads or queues (the same /media/c/<token>/ flow as the Default Media Receiver);
 * - report start / progress / stop of the playing token to /api/cast/report with that token's report token, which the sender
 *   hands over on the private channel (logic.js NS). The report token is never logged, never put into the page or metadata;
 * - show the next-up card, its countdown and "still watching?" for the episode the SENDER queued (it never asks the server for
 *   another title: the queue + `next: true` token flow stays the boundary), the intro / recap skip button, the pause and loading screens
 *   and the sender pill. Everything the sender wrote (names, titles, lines) is put on the page with textContent only, never as HTML;
 * - show a live channel the sender loads (`customData.ui.live`, live TV spec §13): its channel card (logo, name, the *Jetzt* line) on load
 *   and for a few seconds after the first frame, the LIVE badge, and no progress bar. A live channel has no report token (the stream's
 *   own fetches keep its token and viewer alive);
 * - state what this TV (and the AVR behind it) confirms it plays (HEVC, Dolby Digital / Digital Plus) on the same channel as `caps`, when a
 *   sender connects and when it asks (`caps?`). The sender attaches that to its cast request; nothing is claimed before a positive probe.
 */
import { NS, DEFAULT_STRINGS, buildCaps, createReporter, formatTime, initialState, liveOf, parseMessage, probeCaps, seekTarget, step, textTrackStyle, view } from './logic.js';

const fw = cast.framework;
const context = fw.CastReceiverContext.getInstance();
const pm = context.getPlayerManager();
const $ = (id) => document.getElementById(id);
const video = $('v');
pm.setMediaElement(video);

let strings = DEFAULT_STRINGS;
let st = initialState();
let lastTick = performance.now();

const reporter = createReporter({
  now: () => Date.now(),
  // same origin as the page; no cookie exists on the TV (credentials: 'omit' makes sure none would be sent)
  post: (body) => fetch('/api/cast/report', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
    .then((r) => r.status, () => 0),
});

const castIdOf = (info) => {
  const id = info?.customData?.ff?.castId;
  return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? id : '';
};
const playing = () => pm.getPlayerState() === fw.messages.PlayerState.PLAYING;

/** tell the senders (the phone) about input on the TV */
const toSenders = (t) => { try { context.sendCustomMessage(NS, undefined, { t }); } catch { /* no sender connected */ } };

/** what this TV confirms right now (asked again every time: the HDMI sink can change); a framework without canDisplayType claims nothing */
const capsMessage = () => buildCaps(probeCaps((...args) => context.canDisplayType(...args)));
/** @param {string | undefined} to a sender id (the asker); undefined = every connected sender */
function sendCaps(to) { try { context.sendCustomMessage(NS, to, capsMessage()); } catch { /* no sender connected */ } }

function jump() {
  try {
    const req = new fw.messages.QueueUpdateRequestData();
    req.requestType = fw.messages.MessageType.QUEUE_UPDATE;
    req.jump = 1;
    pm.sendLocalMediaRequest(req);
  } catch {
    // TODO verify on hardware: if the local queue request is not available, play to the end (the queue's autoplay moves on)
    const d = pm.getDurationSec();
    if (d > 1) pm.seek(d - 0.5);
  }
}

function run(ev) {
  const r = step(st, ev);
  st = r.st;
  for (const a of r.actions) {
    if (a === 'jump') jump();
    else if (a === 'pause') pm.pause();
    else if (a === 'play') pm.play();
    else if (a === 'send-cancel') toSenders('cancel');
    else if (a === 'send-interaction') toSenders('interaction');
    else if (typeof a === 'object' && 'seek' in a) pm.seek(a.seek);
  }
  render();
}

// ---- UI ----
const nowMs = () => performance.now();
/** a text only when it changed (render runs every 250 ms); `textContent`, never HTML: the texts come from the sender */
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
/** screens and panels fade by the .on class (so closing animates), they never flip [hidden] */
const show = (el, on) => { el.classList.toggle('on', on); el.setAttribute('aria-hidden', on ? 'false' : 'true'); };

/** the media of a LOAD request that is on its way (its poster belongs on the loading screen, not the previous one's) */
let loadingMedia = null;
/** the first image of the media metadata (the poster token), same origin only; '' = none */
function posterUrl() {
  const u = (loadingMedia ?? pm.getMediaInformation())?.metadata?.images?.[0]?.url;
  if (typeof u !== 'string' || !u || u.length > 2048) return '';
  try { const x = new URL(u, location.href); return x.origin === location.origin ? x.href : ''; } catch { return ''; }
}
/** @param {HTMLImageElement} img */
function setArt(img, url) {
  if (!url) { img.hidden = true; if (img.getAttribute('src')) img.removeAttribute('src'); return; }
  if (img.getAttribute('src') !== url) img.src = url;
  img.hidden = false;
}

let focus = 0; // 0 = primary, 1 = secondary touch button of the card
function render() {
  const v = view(st, strings);
  const poster = posterUrl();
  document.body.classList.toggle('still', !st.motion);

  // the card (up next / still watching)
  show($('card'), Boolean(v.card));
  if (v.card) { // when it closes, its last content stays while it fades
    $('card').dataset.mode = v.card.mode;
    setText($('card-title'), v.card.title);
    setText($('card-name'), v.card.name);
    setText($('card-hint'), v.card.hint);
    $('card-hint').hidden = !v.card.hint;
    $('card-buttons').hidden = !v.card.buttons;
    setText($('card-primary'), v.card.primary);
    setText($('card-secondary'), v.card.secondary);
    $('card-secondary').hidden = !v.card.secondary;
    if (!v.card.secondary) focus = 0;
    $('card-primary').classList.toggle('focus', focus === 0);
    $('card-secondary').classList.toggle('focus', focus === 1);
    $('card').style.setProperty('--p', String(v.card.progress));
    setArt($('card-img'), poster);
  }

  // paused (and a stall longer than 3 s)
  show($('pause'), Boolean(v.pause));
  show($('scrim'), Boolean(v.pause));
  if (v.pause) {
    setText($('pause-label'), v.pause.label);
    setText($('pause-title'), v.pause.title);
    setText($('pause-line'), v.pause.line);
    $('pause-title').hidden = !v.pause.title;
    $('pause-line').hidden = !v.pause.line;
    setText($('pause-pos'), formatTime(v.pause.pos));
    setText($('pause-dur'), formatTime(v.pause.dur));
    $('pause').style.setProperty('--p', String(v.pause.dur > 0 ? Math.min(1, v.pause.pos / v.pause.dur) : 0));
    $('pause').classList.toggle('live', Boolean(v.pause.live)); // a live channel: no progress bar, no times
  }

  // loading, until the first frame
  show($('load'), Boolean(v.load));
  if (v.load) {
    setText($('load-title'), v.load.title);
    setText($('load-line'), v.load.line);
    setText($('load-label'), v.load.label);
    $('load-title').hidden = !v.load.title;
    $('load-line').hidden = !v.load.line;
    $('load').classList.toggle('live', Boolean(v.load.live)); // the channel's logo, not a poster
    setArt($('load-art'), poster);
  }

  // a live channel: the LIVE badge, and its card after the first frame
  show($('badge'), Boolean(v.live));
  if (v.live) setText($('badge-text'), v.live.badge);
  show($('lcard'), Boolean(v.live?.card));
  if (v.live?.card) {
    setText($('lcard-name'), v.live.card.name);
    setText($('lcard-now'), v.live.card.now);
    setArt($('lcard-img'), poster);
  }

  // "Still there?" while the queued episode waits paused
  show($('still'), Boolean(v.still));
  if (v.still) {
    setText($('still-title'), v.still.title);
    setText($('still-text'), v.still.text);
    setText($('still-hint'), st.touch ? '' : strings.stillKeys);
    setText($('still-primary'), v.still.primary);
    $('still-primary').hidden = !st.touch;
  }

  // the sender pill
  show($('who'), Boolean(v.who));
  if (v.who) setText($('who'), v.who);

  const skip = $('skip');
  skip.hidden = !v.skip || Boolean(v.card) || Boolean(v.still) || Boolean(v.load);
  if (v.skip) setText(skip, v.skip.text);
  document.body.classList.toggle('idle', !pm.getMediaInformation());
}

function activate(which, resume = false) {
  const v = view(st, strings);
  // the Play/Pause key resumes a paused picture, even under an up-next card (OK / Enter still plays the next episode)
  if (resume && (v.pause || st.paused) && !v.still) { pm.play(); return run({ type: 'pause', paused: false, at: nowMs() }); }
  if (v.still) return run({ type: 'confirm' });
  if (v.card) {
    if (v.card.mode === 'still') return run({ type: 'confirm' });
    return run(which === 1 ? { type: 'cancel' } : { type: 'playNow' });
  }
  if (v.pause) { pm.play(); return run({ type: 'pause', paused: false, at: nowMs() }); }
  if (v.skip) return run({ type: 'skip' });
}

/** ←/→ on the pause screen: ±10 s */
function seekBy(dir) {
  const to = seekTarget(pm.getCurrentTimeSec(), pm.getDurationSec(), dir);
  pm.seek(to);
  run({ type: 'time', pos: to, dur: pm.getDurationSec(), playing: false, dt: 0 });
}

// TV remote (D-pad / OK / Back where the device delivers key events; TODO verify per device) and touch (Nest Hub)
document.addEventListener('keydown', (e) => {
  const k = e.key;
  run({ type: 'key' }); // from now on the hint says what the remote's keys do
  const v = view(st, strings);
  const arrow = k === 'ArrowLeft' || k === 'ArrowRight';
  if (arrow && v.card?.buttons) { focus = focus ? 0 : 1; render(); }
  else if (arrow && v.pause && !v.card && !v.still) seekBy(k === 'ArrowLeft' ? -1 : 1);
  else if (k === 'Enter' || k === ' ' || k === 'MediaPlayPause') {
    if (!v.card && !v.still && !v.pause && !v.skip && !st.paused) return;
    // during an intro the player's own Play/Pause pauses; OK skips
    if (k === 'MediaPlayPause' && !v.card && !v.still && !v.pause && !st.paused) return;
    activate(focus, k === 'MediaPlayPause');
  }
  else if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') run({ type: 'cancel' });
  else return;
  e.preventDefault();
});
document.addEventListener('touchstart', () => { if (!st.touch) run({ type: 'touch' }); }, { passive: true });
$('card-primary').addEventListener('click', () => activate(0));
$('card-secondary').addEventListener('click', () => activate(1));
$('still-primary').addEventListener('click', () => activate(0));
$('skip').addEventListener('click', () => run({ type: 'skip' }));

// ---- the sender's private channel ----
context.addCustomMessageListener(NS, (e) => {
  const m = parseMessage(e.data);
  if (!m) return;
  if (m.t === 'caps?') sendCaps(typeof e.senderId === 'string' ? e.senderId : undefined);
  else if (m.t === 'tok') reporter.token(m.castId, m.rt);
  else if (m.t === 'item') run({ type: 'item', msg: m });
  else if (m.t === 'ui') {
    strings = m.strings;
    run({ type: 'ui', who: m.who, motion: m.motion });
    run({ type: 'countdown', seconds: m.countdown });
    try {
      const style = new fw.messages.TextTrackStyle();
      Object.assign(style, textTrackStyle(m.sub));
      pm.getTextTracksManager().setTextTrackStyle(style);
    } catch { /* no text tracks yet: applied again with the next ui message */ }
  }
});

// a PLAY from the remote / the phone answers "still watching?"
pm.setMessageInterceptor(fw.messages.MessageType.PLAY, (req) => {
  if (st.still) run({ type: 'confirm' });
  return req;
});
// a LOAD starts the loading screen (until the first frame); a queue advance has none and starts it with its media change
pm.setMessageInterceptor(fw.messages.MessageType.LOAD, (req) => {
  run({ type: 'clock', now: nowMs() });
  loadingMedia = req?.media ?? null;
  const live = liveOf(req?.media);
  if (live) reporter.media(''); // a live channel replaces a title: that one is stopped, nothing is reported for the channel
  run({ type: 'load', at: nowMs(), live });
  return req;
});

// ---- playback events ----
const E = fw.events.EventType;
function current() {
  const id = castIdOf(pm.getMediaInformation());
  if (id && id !== st.castId) { loadingMedia = null; run({ type: 'clock', now: nowMs() }); reporter.media(id); run({ type: 'media', castId: id }); }
}
pm.addEventListener(E.PLAYER_LOAD_COMPLETE, () => {
  current();
  // a load without autoplay (the phone re-loads while paused) fires no PAUSE: say so, or the loading screen would stay up
  if (pm.getPlayerState() === fw.messages.PlayerState.PAUSED) run({ type: 'pause', paused: true, at: nowMs() });
});
// a failed LOAD must not leave "Getting ready…" up
pm.addEventListener(E.ERROR, () => run({ type: 'firstFrame' }));
pm.addEventListener(E.MEDIA_STATUS, current);
pm.addEventListener([E.TIME_UPDATE, E.PLAYING, E.PAUSE], () => {
  current();
  const now = nowMs(), dt = now - lastTick;
  lastTick = now;
  const pos = pm.getCurrentTimeSec(), dur = pm.getDurationSec();
  // playing = the first frame is there; paused = the pause screen's clock
  if (playing()) run({ type: 'firstFrame' });
  run({ type: 'pause', paused: pm.getPlayerState() === fw.messages.PlayerState.PAUSED, at: now });
  run({ type: 'time', pos, dur, playing: playing(), dt: Math.min(dt, 2000) });
  reporter.time(pos, !playing());
});
pm.addEventListener(E.BUFFERING, (e) => run({ type: 'buffering', on: e?.isBuffering === true, at: nowMs() }));
pm.addEventListener(E.MEDIA_FINISHED, (e) => {
  reporter.end(Number(e?.currentMediaTime) || pm.getDurationSec() || st.pos);
  render();
});
// the clock of the pause / stall / pill timers (250 ms); the countdown also moves while no time update arrives (some players send them rarely)
setInterval(() => {
  const now = nowMs();
  run({ type: 'clock', now });
  if (playing()) { const dt = now - lastTick; if (dt > 900) { lastTick = now; run({ type: 'time', pos: pm.getCurrentTimeSec(), dur: pm.getDurationSec(), playing: true, dt }); } }
}, 250);

// a sender that connects gets the caps at once (it asks again with `caps?` when it joined before this page loaded)
try { context.addEventListener(fw.system.EventType.SENDER_CONNECTED, (e) => sendCaps(typeof e?.senderId === 'string' ? e.senderId : undefined)); } catch { /* older framework: the sender asks */ }

const options = new fw.CastReceiverOptions();
options.customNamespaces = { [NS]: fw.system.MessageType.JSON };
options.disableIdleTimeout = false;
context.start(options);
render();
