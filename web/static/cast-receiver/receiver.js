// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Cast Application Framework (CAF v3) global `cast` has no types here (not type-checked); the logic lives in logic.js (tested)
/* global cast, document, fetch, setInterval, performance */
/**
 * FriendFlix's own Cast Web Receiver (served at /cast-receiver/, registered as CAST_RECEIVER_APP_ID in the Google Cast console).
 *
 * The TV has no FriendFlix session and never gets one. What it may do:
 * - play the token URLs the sender loads or queues (the same /media/c/<token>/ flow as the Default Media Receiver);
 * - report start / progress / stop of the playing token to /api/cast/report with that token's report token, which the sender
 *   hands over on the private channel (logic.js NS). The report token is never logged, never put into the page or metadata;
 * - show the next-up card, its countdown and "still watching?" for the episode the SENDER queued (it never asks the server for
 *   another title: the queue + `next: true` token flow stays the boundary), and the intro / recap skip button.
 */
import { NS, DEFAULT_STRINGS, createReporter, initialState, parseMessage, step, textTrackStyle, view } from './logic.js';

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
let focus = 0; // 0 = primary, 1 = secondary button of the card
function render() {
  const v = view(st, strings);
  const card = $('card'), still = $('still'), skip = $('skip');
  card.hidden = !v.card;
  if (v.card) {
    card.dataset.mode = v.card.mode;
    $('card-title').textContent = v.card.title;
    $('card-text').textContent = v.card.text;
    $('card-primary').textContent = v.card.primary;
    $('card-secondary').textContent = v.card.secondary;
    $('card-secondary').hidden = !v.card.secondary;
    if (!v.card.secondary) focus = 0;
    $('card-primary').classList.toggle('focus', focus === 0);
    $('card-secondary').classList.toggle('focus', focus === 1);
    card.style.setProperty('--p', String(v.card.progress));
  }
  still.hidden = !v.still;
  if (v.still) { $('still-title').textContent = v.still.title; $('still-text').textContent = v.still.text; $('still-primary').textContent = v.still.primary; }
  skip.hidden = !v.skip || Boolean(v.card) || Boolean(v.still);
  if (v.skip) skip.textContent = v.skip.text;
  document.body.classList.toggle('idle', !pm.getMediaInformation());
}

function activate(which) {
  const v = view(st, strings);
  if (v.still) return run({ type: 'confirm' });
  if (v.card) {
    if (v.card.mode === 'still') return run({ type: 'confirm' });
    return run(which === 1 ? { type: 'cancel' } : { type: 'playNow' });
  }
  if (v.skip) return run({ type: 'skip' });
}

// TV remote (D-pad / OK / Back where the device delivers key events; TODO verify per device) and touch (Nest Hub)
document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'ArrowRight') { focus = focus ? 0 : 1; render(); }
  else if (k === 'Enter' || k === ' ' || k === 'MediaPlayPause') activate(focus);
  else if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') run({ type: 'cancel' });
  else return;
  e.preventDefault();
});
$('card-primary').addEventListener('click', () => activate(0));
$('card-secondary').addEventListener('click', () => activate(1));
$('still-primary').addEventListener('click', () => activate(0));
$('skip').addEventListener('click', () => run({ type: 'skip' }));

// ---- the sender's private channel ----
context.addCustomMessageListener(NS, (e) => {
  const m = parseMessage(e.data);
  if (!m) return;
  if (m.t === 'tok') reporter.token(m.castId, m.rt);
  else if (m.t === 'item') run({ type: 'item', msg: m });
  else if (m.t === 'ui') {
    strings = m.strings;
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

// ---- playback events ----
const E = fw.events.EventType;
function current() {
  const id = castIdOf(pm.getMediaInformation());
  if (id && id !== st.castId) { reporter.media(id); run({ type: 'media', castId: id }); }
}
pm.addEventListener(E.PLAYER_LOAD_COMPLETE, current);
pm.addEventListener(E.MEDIA_STATUS, current);
pm.addEventListener([E.TIME_UPDATE, E.PLAYING, E.PAUSE], () => {
  current();
  const now = performance.now(), dt = now - lastTick;
  lastTick = now;
  const pos = pm.getCurrentTimeSec(), dur = pm.getDurationSec();
  run({ type: 'time', pos, dur, playing: playing(), dt: Math.min(dt, 2000) });
  reporter.time(pos, !playing());
});
pm.addEventListener(E.MEDIA_FINISHED, (e) => {
  reporter.end(Number(e?.currentMediaTime) || pm.getDurationSec() || st.pos);
  render();
});
// the countdown also moves while no time update arrives (some players send them rarely)
setInterval(() => { if (playing()) { const now = performance.now(); const dt = now - lastTick; if (dt > 900) { lastTick = now; run({ type: 'time', pos: pm.getCurrentTimeSec(), dur: pm.getDurationSec(), playing: true, dt }); } } }, 1000);

const options = new fw.CastReceiverOptions();
options.customNamespaces = { [NS]: fw.system.MessageType.JSON };
options.disableIdleTimeout = false;
context.start(options);
render();
