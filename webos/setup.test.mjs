// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';

const coreSrc = readFileSync(new URL('../tv-shared/setup-core.js', import.meta.url), 'utf8');
const setupSrc = readFileSync(new URL('./app/setup.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const memoryStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

function makeEl(id) {
  const listeners = {};
  return {
    id, hidden: false, textContent: '', value: '', disabled: false, listeners,
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    focus() { this.doc.activeElement = this; },
    blur() { if (this.doc.activeElement === this) this.doc.activeElement = null; },
    click() { for (const f of listeners.click || []) f({ preventDefault() {} }); },
  };
}

/** evaluates setup-core.js and setup.js against a stand-in page */
function boot({ probe = false, local = {}, session = {}, search = '', navType = 'navigate', fetchImpl, palm = null } = {}) {
  const ids = ['opening', 'opening-text', 'form', 'server', 'connect', 'error', 'checking', 'checking-text', 'failure', 'failure-text', 'retry', 'change'];
  const els = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));
  const docListeners = {};
  const doc = {
    activeElement: null,
    body: { dataset: { probe: probe ? '1' : '0' } },
    getElementById: (id) => els[id] || null,
    addEventListener(t, f) { (docListeners[t] ||= []).push(f); },
  };
  for (const e of Object.values(els)) e.doc = doc;
  const calls = { fetch: [], closed: 0, back: 0 };
  const location = { href: 'file:///start/index.html', search };
  const win = {
    location, close() { calls.closed++; },
    PalmSystem: palm === false ? undefined : { platformBack() { calls.back++; } },
  };
  const fetchFn = (url, opts) => { calls.fetch.push(url); return fetchImpl(url, opts); };
  new Function('window', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', coreSrc)(win, fetchFn, AbortController, setTimeout, clearTimeout);
  const localStorage = memoryStore(local);
  const sessionStorage = memoryStore(session);
  const performance = { getEntriesByType: () => [{ type: navType }] };
  new Function('window', 'document', 'localStorage', 'sessionStorage', 'performance', 'fetch', 'AbortController', 'URLSearchParams', 'setTimeout', 'clearTimeout', setupSrc)(
    win, doc, localStorage, sessionStorage, performance, fetchFn, AbortController, URLSearchParams, setTimeout, clearTimeout);
  const key = (keyCode, key2 = '') => {
    const ev = { keyCode, key: key2, prevented: false, preventDefault() { this.prevented = true; } };
    for (const f of docListeners.keydown || []) f(ev);
    return ev;
  };
  return { els, doc, win, location, calls, localStorage, sessionStorage, key, setup: win.FFWebosSetup };
}

const goodAnswer = { sha: 'abc1234', version: '2.3.0', codename: 'Brezel', build: 'x', channel: 'stable', label: '2.3.0' };
const okFetch = async () => ({ status: 200, json: async () => goodAnswer });
const failFetch = async () => { throw new Error('network'); };
const SERVER = 'https://friend.example.com';

test('startMode', () => {
  const { setup } = boot({ fetchImpl: okFetch });
  const p = (s = '') => new URLSearchParams(s);
  assert.equal(setup.startMode('navigate', SERVER, p()), 'check');
  assert.equal(setup.startMode('reload', SERVER, p()), 'check');
  assert.equal(setup.startMode('back_forward', SERVER, p()), 'form');
  assert.equal(setup.startMode('navigate', SERVER, p('change=1')), 'form');
  assert.equal(setup.startMode('navigate', null, p()), 'form');
  assert.equal(setup.startMode('navigate', 'http://friend.example.com', p()), 'form');
  assert.equal(setup.startMode('navigate', 'garbage value', p()), 'form');
});

test('a stored server is checked and opened as the webOS TV page', async () => {
  const t = boot({ local: { 'ff.server': SERVER }, fetchImpl: okFetch });
  await flush();
  assert.deepEqual(t.calls.fetch, [SERVER + '/api/version']);
  assert.equal(t.location.href, SERVER + '/tv?ff_app=webos');
  assert.equal(t.localStorage.getItem('ff.server'), SERVER);
});

test('unreachable stored server shows the error card', async () => {
  const t = boot({ local: { 'ff.server': SERVER }, fetchImpl: failFetch });
  await flush();
  assert.equal(t.els.failure.hidden, false);
  assert.equal(t.els.form.hidden, true);
  assert.equal(t.els.checking.hidden, true);
  for (const page of ['app', 'probe']) {
    const html = readFileSync(new URL(`./${page}/index.html`, import.meta.url), 'utf8');
    assert.match(html, /<button id="retry"[^>]*>Retry<\/button>/);
    assert.match(html, /<button id="change"[^>]*>Change server<\/button>/);
  }
  assert.match(t.els['failure-text'].textContent, /Cannot reach/);
  assert.equal(t.doc.activeElement, t.els.retry);
  assert.equal(t.location.href, 'file:///start/index.html');
  assert.equal(t.localStorage.getItem('ff.server'), SERVER, 'the stored server is kept');
});

test('a non-FriendFlix answer shows the error card too', async () => {
  const t = boot({ local: { 'ff.server': SERVER }, fetchImpl: async () => ({ status: 200, json: async () => ({ hello: 1 }) }) });
  await flush();
  assert.equal(t.els.failure.hidden, false);
  assert.match(t.els['failure-text'].textContent, /not a FriendFlix server/);
});

test('Retry calls fetch again and opens the server when it answers', async () => {
  let n = 0;
  const t = boot({ local: { 'ff.server': SERVER }, fetchImpl: async () => (n++ === 0 ? failFetch() : okFetch()) });
  await flush();
  assert.equal(t.calls.fetch.length, 1);
  t.els.retry.click();
  await flush();
  assert.equal(t.calls.fetch.length, 2);
  assert.equal(t.location.href, SERVER + '/tv?ff_app=webos');
});

test('a second Retry during a running check does not fetch again', async () => {
  let n = 0;
  const t = boot({ local: { 'ff.server': SERVER }, fetchImpl: () => (n++ === 0 ? failFetch() : new Promise(() => {})) });
  await flush();
  t.els.retry.click();
  await flush();
  t.els.retry.click();
  await flush();
  assert.equal(t.calls.fetch.length, 2);
});

test('Change server shows the form prefilled with the stored address', async () => {
  const t = boot({ local: { 'ff.server': SERVER }, fetchImpl: failFetch });
  await flush();
  t.els.change.click();
  assert.equal(t.els.form.hidden, false);
  assert.equal(t.els.failure.hidden, true);
  assert.equal(t.els.server.value, SERVER);
  assert.equal(t.doc.activeElement, t.els.server);
});

test('no stored server and back_forward show the form', () => {
  const a = boot({ fetchImpl: okFetch });
  assert.equal(a.els.form.hidden, false);
  assert.equal(a.calls.fetch.length, 0);
  const b = boot({ local: { 'ff.server': SERVER }, navType: 'back_forward', fetchImpl: okFetch });
  assert.equal(b.els.form.hidden, false);
  assert.equal(b.els.server.value, SERVER);
  assert.equal(b.calls.fetch.length, 0);
  const c = boot({ local: { 'ff.server': SERVER }, search: '?change=1', fetchImpl: okFetch });
  assert.equal(c.els.form.hidden, false);
  assert.equal(c.calls.fetch.length, 0);
});

test('the form validates, checks and stores the server, then opens it', async () => {
  const t = boot({ fetchImpl: async () => ({ status: 200, json: async () => ({ ...goodAnswer, authOrigin: 'https://auth.example.com' }) }) });
  t.els.server.value = 'http://friend.example.com';
  t.els.form.listeners.submit[0]({ preventDefault() {} });
  assert.match(t.els.error.textContent, /Plain http/);
  t.els.server.value = 'Friend.Example.com';
  t.els.form.listeners.submit[0]({ preventDefault() {} });
  await flush();
  assert.equal(t.localStorage.getItem('ff.server'), SERVER);
  assert.equal(t.localStorage.getItem('ff.authOrigin'), 'https://auth.example.com');
  assert.equal(t.location.href, SERVER + '/tv?ff_app=webos');
});

test('Back (461) on the field moves focus to Connect instead of exiting', () => {
  const t = boot({ fetchImpl: okFetch });
  t.els.server.focus();
  const ev = t.key(461);
  assert.equal(t.doc.activeElement, t.els.connect);
  assert.equal(ev.prevented, true);
  assert.equal(t.calls.back, 0);
  assert.equal(t.calls.closed, 0);
});

test('Back elsewhere calls PalmSystem.platformBack, else closes the window', async () => {
  const t = boot({ fetchImpl: okFetch });
  t.els.connect.focus();
  t.key(461);
  assert.equal(t.calls.back, 1);
  const f = boot({ local: { 'ff.server': SERVER }, fetchImpl: failFetch });
  await flush();
  f.key(461);
  assert.equal(f.calls.back, 1);
  const g = boot({ palm: false, fetchImpl: okFetch });
  g.els.connect.focus();
  g.key(461);
  assert.equal(g.calls.closed, 1);
});

test('arrows move between the field and Connect, and between the error card buttons', async () => {
  const t = boot({ fetchImpl: okFetch });
  t.els.server.focus();
  t.key(40, 'ArrowDown');
  assert.equal(t.doc.activeElement, t.els.connect);
  t.key(38, 'ArrowUp');
  assert.equal(t.doc.activeElement, t.els.server);
  const f = boot({ local: { 'ff.server': SERVER }, fetchImpl: failFetch });
  await flush();
  f.key(39, 'ArrowRight');
  assert.equal(f.doc.activeElement, f.els.change);
  f.key(37, 'ArrowLeft');
  assert.equal(f.doc.activeElement, f.els.retry);
});

test('probe: leaving for the server is remembered, the way back re-opens it with home=ok', () => {
  const first = boot({ probe: true, local: { 'ff.server': SERVER }, fetchImpl: okFetch });
  return flush().then(() => {
    assert.equal(first.location.href, SERVER + '/tv?ff_app=webos&probe=1');
    assert.equal(first.sessionStorage.getItem('ff.homeTest'), '1');
    const back = boot({ probe: true, local: { 'ff.server': SERVER }, session: { 'ff.homeTest': '1' }, navType: 'back_forward', fetchImpl: failFetch });
    assert.equal(back.location.href, SERVER + '/tv?ff_app=webos&probe=1&home=ok');
    assert.equal(back.calls.fetch.length, 0);
    assert.equal(back.sessionStorage.getItem('ff.homeTest'), null);
    const again = boot({ probe: true, local: { 'ff.server': SERVER }, navType: 'back_forward', fetchImpl: okFetch });
    assert.equal(again.els.form.hidden, false, 'without the flag a back navigation shows the form');
  });
});

test('the app page ignores the home flag and shows the form on back_forward', () => {
  const t = boot({ local: { 'ff.server': SERVER }, session: { 'ff.homeTest': '1' }, navType: 'back_forward', fetchImpl: okFetch });
  assert.equal(t.els.form.hidden, false);
  assert.equal(t.location.href, 'file:///start/index.html');
});
