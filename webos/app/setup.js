// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The server setup page of the webOS shells (app and probe; the probe gets build-time copies of this file, setup.css and
// setup-core.js). setup-core.js is loaded before it, both as plain scripts. A stored server is checked with GET /api/version
// and opened; if that fails an error card offers Retry and Change server. Without a stored server (or on Change server /
// a back navigation) a TV-sized form asks for the address and checks it before storing it.
(function () {
'use strict';
// classic script (no module loading from file://); setup-core.js is loaded before it and sets window.FFSetupCore
var core = window.FFSetupCore;
var normaliseServer = core.normaliseServer;
var checkVersionAnswer = core.checkVersionAnswer;
var watchUrl = core.watchUrl;

const SERVER_KEY = 'ff.server';
const AUTH_KEY = 'ff.authOrigin';
const HOME_KEY = 'ff.homeTest'; // sessionStorage: the probe left this page for the server and expects to come back
const BACK_KEY_CODE = 461;
const PROBE_TIMEOUT_MS = 15000;

const probe = document.body.dataset.probe === '1';
const $ = (id) => document.getElementById(id);
const sections = { checking: $('checking'), failure: $('failure'), form: $('form') };
const input = $('server');
const button = $('connect');
const retry = $('retry');
const change = $('change');
const errorBox = $('error');

function makeStore(area) {
  return {
    get(k) { try { return area().getItem(k); } catch { return null; } },
    set(k, v) { try { if (v === null) area().removeItem(k); else area().setItem(k, v); } catch { /* storage unavailable */ } },
  };
}
const store = makeStore(function () { return localStorage; });
const session = makeStore(function () { return sessionStorage; });

const MESSAGES = {
  empty: 'Enter the address of your FriendFlix server.',
  http: 'Plain http:// addresses are not allowed. Use an https:// address.',
  invalid: 'That does not look like a server address. Try something like friend.example.com.',
  unreachable: 'Cannot reach that server. Check the address, the TV network and that the server is running.',
  notFriendflix: 'That address answered, but it is not a FriendFlix server.',
};

/** which page to start in: the form, or a check of the stored server */
function startMode(navType, stored, params) {
  if (navType === 'back_forward') return 'form';
  if (params.get('change') === '1') return 'form';
  if (!normaliseServer(stored).ok) return 'form';
  return 'check';
}
window.FFWebosSetup = { startMode: startMode };

function show(name) {
  Object.keys(sections).forEach(function (k) { sections[k].hidden = k !== name; });
}

function open(origin, extra) {
  // the probe's server half hands control back here with history.go(); remember that we are expecting it
  if (probe && !extra) session.set(HOME_KEY, '1');
  window.location.href = watchUrl(origin, probe, 'webos') + (extra || '');
}

async function askVersion(origin) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(function () { if (ctl) ctl.abort(); }, PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(origin + '/api/version', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ctl ? ctl.signal : undefined });
    if (r.status !== 200) return { ok: false, reason: 'notFriendflix' };
    let json;
    try { json = await r.json(); } catch { return { ok: false, reason: 'notFriendflix' }; }
    const answer = checkVersionAnswer(json);
    return answer.ok ? answer : { ok: false, reason: 'notFriendflix' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function showForm(prefill) {
  show('form');
  if (prefill) input.value = prefill;
  input.focus();
}

let failedOrigin = '';
function showFailure(origin, reason) {
  failedOrigin = origin;
  $('failure-text').textContent = MESSAGES[reason];
  show('failure');
  retry.focus();
}

/** check the stored server; open it, or show the error card */
async function checkStored(origin) {
  $('checking-text').textContent = 'Opening ' + origin;
  show('checking');
  const answer = await askVersion(origin);
  if (!answer.ok) return showFailure(origin, answer.reason);
  store.set(AUTH_KEY, answer.authOrigin);
  open(origin);
}

async function connect() {
  errorBox.textContent = '';
  const n = normaliseServer(input.value);
  if (!n.ok) { errorBox.textContent = MESSAGES[n.reason]; return; }
  input.value = n.origin;
  button.disabled = true;
  button.textContent = 'Checking...';
  const answer = await askVersion(n.origin);
  button.disabled = false;
  button.textContent = 'Connect';
  if (!answer.ok) { errorBox.textContent = MESSAGES[answer.reason]; return; }
  store.set(SERVER_KEY, n.origin);
  store.set(AUTH_KEY, answer.authOrigin);
  open(n.origin);
}

function exitApp() {
  try {
    if (window.PalmSystem && typeof window.PalmSystem.platformBack === 'function') window.PalmSystem.platformBack();
    else window.close();
  } catch { /* not on a TV */ }
}

document.addEventListener('keydown', function (e) {
  if (e.keyCode === BACK_KEY_CODE) {
    // Back closes the TV keyboard first (blur); with the focus elsewhere it leaves the app
    if (!sections.form.hidden && document.activeElement === input) { input.blur(); button.focus(); e.preventDefault(); return; }
    exitApp();
    return;
  }
  const active = document.activeElement;
  if (!sections.form.hidden) {
    // arrows move focus between the field and the button; OK on the button submits, OK on the field opens the TV keyboard
    if (e.key === 'ArrowDown' && active === input) { button.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && active === button) { input.focus(); e.preventDefault(); }
  } else if (!sections.failure.hidden) {
    if ((e.key === 'ArrowRight' || e.key === 'ArrowDown') && active === retry) { change.focus(); e.preventDefault(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && active === change) { retry.focus(); e.preventDefault(); }
  }
});

sections.form.addEventListener('submit', function (e) { e.preventDefault(); connect(); });
retry.addEventListener('click', function () { checkStored(failedOrigin); });
change.addEventListener('click', function () { errorBox.textContent = ''; showForm(failedOrigin); });

function navigationType() {
  try {
    const entries = performance.getEntriesByType('navigation');
    return entries && entries[0] ? entries[0].type : '';
  } catch { return ''; }
}

const navType = navigationType();
const params = new URLSearchParams(window.location.search);
const storedText = store.get(SERVER_KEY);
const stored = normaliseServer(storedText);
if (probe && navType === 'back_forward' && stored.ok && session.get(HOME_KEY) === '1') {
  // the server-side probe sent us back here (Task 9 contract): open it again, marked as the home-button test result
  session.set(HOME_KEY, null);
  open(stored.origin, '&home=ok');
} else if (startMode(navType, storedText, params) === 'check') {
  checkStored(stored.origin);
} else {
  showForm(stored.ok ? stored.origin : '');
}
})();
