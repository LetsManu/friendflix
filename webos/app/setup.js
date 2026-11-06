// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The server setup page of the webOS shells (app and probe; the probe gets build-time copies of this file, setup.css and
// setup-core.js). setup-core.js is loaded before it, both as plain scripts. A stored server is checked with GET /api/version
// and opened; if that fails an error card offers Retry and Change server. In the app (not the probe) the logo with "Blue key:
// change server" shows for 1.5 s first; the blue key (406) in that window opens the form instead. Without a stored server (or on
// Change server / a back navigation, also a page restored from the back/forward cache) a TV-sized form asks for the address and
// checks it before storing it.
(function () {
'use strict';
// classic script (no module loading from file://); setup-core.js is loaded before it and sets window.FFSetupCore
var core = window.FFSetupCore;
var normaliseServer = core.normaliseServer;
var watchUrl = core.watchUrl;

const SERVER_KEY = 'ff.server';
const AUTH_KEY = 'ff.authOrigin';
const HOME_KEY = 'ff.homeTest'; // sessionStorage: the probe left this page for the server and expects to come back
const BACK_KEY_CODE = 461;
const BLUE_KEY_CODE = 406;
/** the blue-key window before a stored server is checked and opened (app only) */
const BLUE_WINDOW_MS = 1500;

const probe = document.body.dataset.probe === '1';
const $ = (id) => document.getElementById(id);
// the probe page has no #opening section (it never waits for the blue key)
const sections = { opening: $('opening'), checking: $('checking'), failure: $('failure'), form: $('form') };
if (!sections.opening) delete sections.opening;
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

const MESSAGES = core.MESSAGES;
const askVersion = core.askVersion;

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

let blueTimer = null;
function endBlueWindow() {
  if (blueTimer !== null) clearTimeout(blueTimer);
  blueTimer = null;
}
/** app start with a stored server: the logo and the blue-key hint, then the check */
function showOpening(origin) {
  if (!sections.opening) { checkStored(origin); return; }
  $('opening-text').textContent = 'Blue key: change server';
  show('opening');
  endBlueWindow();
  blueTimer = setTimeout(function () { blueTimer = null; checkStored(origin); }, BLUE_WINDOW_MS);
}

function showForm(prefill) {
  endBlueWindow();
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
let checking = false;
async function checkStored(origin) {
  if (checking) return;
  checking = true;
  try { await runCheck(origin); } finally { checking = false; }
}
async function runCheck(origin) {
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
  if (e.keyCode === BLUE_KEY_CODE && blueTimer !== null) {
    // the blue key while the logo shows: change server instead of opening it
    e.preventDefault();
    showForm(stored.ok ? stored.origin : '');
    return;
  }
  if (e.keyCode === BACK_KEY_CODE) {
    endBlueWindow(); // Back while the logo shows leaves the app, the server is not opened
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
function route(type) {
  if (probe && type === 'back_forward' && stored.ok && session.get(HOME_KEY) === '1') {
    // the server-side probe sent us back here (Task 9 contract): open it again, marked as the home-button test result
    session.set(HOME_KEY, null);
    open(stored.origin, '&home=ok');
  } else if (startMode(type, storedText, params) === 'check') {
    if (probe) checkStored(stored.origin); // the probe opens at once
    else showOpening(stored.origin);
  } else {
    showForm(stored.ok ? stored.origin : '');
  }
}
route(navType);
// a page restored from the back/forward cache does not run this script again: route it like a back navigation
window.addEventListener('pageshow', function (e) { if (e && e.persisted) route('back_forward'); });
})();
