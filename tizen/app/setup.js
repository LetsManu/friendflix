// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The server setup page of the Tizen shells (app and probe; the probe gets a build-time copy of this file, setup.css and
// setup-core.js, see Task 4); setup-core.js is loaded before it, both as plain scripts. A stored server is opened at once; otherwise a TV-sized form asks for the address and checks it
// with GET /api/version before storing it.
(function () {
'use strict';
// classic script (no module loading from file://); setup-core.js is loaded before it and sets window.FFSetupCore
var core = window.FFSetupCore;
var normaliseServer = core.normaliseServer;
var checkVersionAnswer = core.checkVersionAnswer;
var watchUrl = core.watchUrl;

const SERVER_KEY = 'ff.server';
const AUTH_KEY = 'ff.authOrigin';
const RED_KEY_CODE = 403; // ColorF0Red
const RETURN_KEY_CODE = 10009;
const RED_HOLD_MS = 1000;
const OPEN_DELAY_MS = 1500; // time to hold red before the stored server is opened
const PROBE_TIMEOUT_MS = 15000;

const probe = document.body.dataset.probe === '1';
const $ = (id) => document.getElementById(id);
const opening = $('opening');
const form = $('form');
const input = $('server');
const button = $('connect');
const errorBox = $('error');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const MESSAGES = {
  empty: 'Enter the address of your FriendFlix server.',
  http: 'Plain http:// addresses are not allowed. Use an https:// address.',
  invalid: 'That does not look like a server address. Try something like friend.example.com.',
  unreachable: 'Cannot reach that server. Check the address, the TV network and that the server is running.',
  notFriendflix: 'That address answered, but it is not a FriendFlix server.',
};

function clearServer() {
  store.set(SERVER_KEY, null);
  store.set(AUTH_KEY, null);
}

function open(origin) {
  window.location.href = watchUrl(origin, probe);
}

async function askVersion(origin) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), PROBE_TIMEOUT_MS);
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

function showError(text) {
  errorBox.textContent = text;
}

async function connect() {
  showError('');
  const n = normaliseServer(input.value);
  if (!n.ok) return showError(MESSAGES[n.reason]);
  input.value = n.origin;
  button.disabled = true;
  button.textContent = 'Checking...';
  const answer = await askVersion(n.origin);
  button.disabled = false;
  button.textContent = 'Connect';
  if (!answer.ok) return showError(MESSAGES[answer.reason]);
  store.set(SERVER_KEY, n.origin);
  store.set(AUTH_KEY, answer.authOrigin);
  open(n.origin);
}

function showForm(prefill) {
  opening.hidden = true;
  form.hidden = false;
  if (prefill) input.value = prefill;
  input.focus();
}

let openTimer = null;
function showOpening(origin) {
  $('opening-text').textContent = 'Opening ' + origin;
  opening.hidden = false;
  openTimer = setTimeout(() => { openTimer = null; open(origin); }, OPEN_DELAY_MS);
}

// red key held for one second: forget the stored server
let redTimer = null;
document.addEventListener('keydown', (e) => {
  if (e.keyCode === RED_KEY_CODE) {
    if (redTimer === null) {
      redTimer = setTimeout(() => {
        redTimer = null;
        if (openTimer !== null) { clearTimeout(openTimer); openTimer = null; }
        clearServer();
        showError('');
        showForm('');
      }, RED_HOLD_MS);
    }
    e.preventDefault();
    return;
  }
  if (e.keyCode === RETURN_KEY_CODE) {
    // Return closes the TV keyboard first (blur); with the focus elsewhere it leaves the app
    if (document.activeElement === input) { input.blur(); button.focus(); e.preventDefault(); return; }
    try { window.tizen.application.getCurrentApplication().exit(); } catch { /* not on a TV */ }
    return;
  }
  if (form.hidden) return;
  // arrows move focus between the field and the button; OK on the button submits (a button click), OK on the field opens the TV IME
  if (e.key === 'ArrowDown' && document.activeElement === input) { button.focus(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' && document.activeElement === button) { input.focus(); e.preventDefault(); }
});
document.addEventListener('keyup', (e) => {
  if (e.keyCode === RED_KEY_CODE && redTimer !== null) { clearTimeout(redTimer); redTimer = null; }
});

form.addEventListener('submit', (e) => { e.preventDefault(); connect(); });

try {
  window.tizen.tvinputdevice.registerKey('ColorF0Red');
} catch { /* not on a TV */ }

const params = new URLSearchParams(window.location.search);
const stored = normaliseServer(store.get(SERVER_KEY));
if (stored.ok && params.get('change') !== '1') showOpening(stored.origin);
else showForm(stored.ok ? stored.origin : '');
})();
