// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';

// setup-core.js is a classic script that fills window.FFSetupCore; evaluate it here with a stand-in window
const win = {};
new Function('window', 'URL', readFileSync(new URL('./setup-core.js', import.meta.url), 'utf8'))(win, URL);
const { normaliseServer, checkVersionAnswer, watchUrl, askVersion } = win.FFSetupCore;

test('normalise_addresses', () => {
  assert.deepEqual(normaliseServer('  Friend.Example.com/ '), { ok: true, origin: 'https://friend.example.com' });
  assert.deepEqual(normaliseServer('friend.example.com:8443/path'), { ok: true, origin: 'https://friend.example.com:8443' });
  assert.deepEqual(normaliseServer('https://friend.example.com/x?y=1#z'), { ok: true, origin: 'https://friend.example.com' });
  assert.deepEqual(normaliseServer('https://friend.example.com:443'), { ok: true, origin: 'https://friend.example.com' });
  assert.deepEqual(normaliseServer('192.0.2.7:8443'), { ok: true, origin: 'https://192.0.2.7:8443' });
  assert.deepEqual(normaliseServer('http://friend.example.com'), { ok: false, reason: 'http' });
  assert.deepEqual(normaliseServer('HTTP://friend.example.com'), { ok: false, reason: 'http' });
  assert.deepEqual(normaliseServer(''), { ok: false, reason: 'empty' });
  assert.deepEqual(normaliseServer('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(normaliseServer('not a host'), { ok: false, reason: 'invalid' });
  assert.deepEqual(normaliseServer('ftp://friend.example.com'), { ok: false, reason: 'invalid' });
  assert.deepEqual(normaliseServer('user@friend.example.com'), { ok: false, reason: 'invalid' });
  assert.deepEqual(normaliseServer('friend.example.com:99999'), { ok: false, reason: 'invalid' });
  assert.deepEqual(normaliseServer(undefined), { ok: false, reason: 'empty' });
});

const answer = { sha: 'abc1234', version: '2.3.0', codename: 'Brezel', build: 'x', channel: 'stable', label: '2.3.0' };

test('checkVersionAnswer accepts a FriendFlix answer', () => {
  assert.deepEqual(checkVersionAnswer(answer), { ok: true, authOrigin: null });
  assert.deepEqual(checkVersionAnswer({ ...answer, authOrigin: 'https://auth.example.com' }), { ok: true, authOrigin: 'https://auth.example.com' });
  assert.deepEqual(checkVersionAnswer({ ...answer, authOrigin: 'https://auth.example.com/' }), { ok: true, authOrigin: 'https://auth.example.com' });
  assert.deepEqual(checkVersionAnswer({ ...answer, authOrigin: 'https://auth.example.com:8443' }), { ok: true, authOrigin: 'https://auth.example.com:8443' });
});

test('checkVersionAnswer refuses foreign JSON', () => {
  for (const j of [null, undefined, 'x', 5, [], {}, { version: '1.0.0' },
    { ...answer, sha: '' }, { ...answer, codename: '' }, { ...answer, version: '2.3' }, { ...answer, version: '2.3.0-rc1' }, { ...answer, version: 2 }]) {
    assert.deepEqual(checkVersionAnswer(j), { ok: false });
  }
});

test('checkVersionAnswer: authOrigin must be https host only, else null', () => {
  for (const a of ['http://auth.example.com', 'https://auth.example.com/realm', 'https://auth.example.com/?x=1', 'https://auth.example.com#f',
    'https://u:p@auth.example.com', 'javascript:alert(1)', 'auth.example.com', '', 5, null, 'https://']) {
    assert.deepEqual(checkVersionAnswer({ ...answer, authOrigin: a }), { ok: true, authOrigin: null }, String(a));
  }
});

test('watchUrl', () => {
  assert.equal(watchUrl('https://friend.example.com', false), 'https://friend.example.com/tv?ff_app=tizen');
  assert.equal(watchUrl('https://friend.example.com', true), 'https://friend.example.com/tv?ff_app=tizen&probe=1');
});

test('watchUrl: app marker defaults to tizen', () => {
  assert.equal(win.FFSetupCore.watchUrl('https://friend.example.com', false), 'https://friend.example.com/tv?ff_app=tizen');
});

test('watchUrl: webos marker, probe flag', () => {
  assert.equal(win.FFSetupCore.watchUrl('https://friend.example.com', true, 'webos'), 'https://friend.example.com/tv?ff_app=webos&probe=1');
});

const reply = (status, body) => ({ status, json: async () => { if (body instanceof Error) throw body; return body; } });

test('askVersion: a 200 with a valid answer is ok', async () => {
  const urls = [];
  const fetch = async (url, opts) => { urls.push([url, opts.redirect, opts.credentials]); return reply(200, { ...answer, authOrigin: 'https://auth.example.com' }); };
  assert.deepEqual(await askVersion('https://friend.example.com', { fetch }), { ok: true, authOrigin: 'https://auth.example.com' });
  assert.deepEqual(urls, [['https://friend.example.com/api/version', 'error', 'omit']]);
});

test('askVersion: non-200, bad JSON and foreign JSON are notFriendflix', async () => {
  const notFf = { ok: false, reason: 'notFriendflix' };
  assert.deepEqual(await askVersion('https://x.example.com', { fetch: async () => reply(404, answer) }), notFf);
  assert.deepEqual(await askVersion('https://x.example.com', { fetch: async () => reply(200, new Error('bad json')) }), notFf);
  assert.deepEqual(await askVersion('https://x.example.com', { fetch: async () => reply(200, { hello: 1 }) }), notFf);
});

test('askVersion: a fetch error is unreachable', async () => {
  assert.deepEqual(await askVersion('https://x.example.com', { fetch: async () => { throw new Error('network'); } }), { ok: false, reason: 'unreachable' });
});

test('askVersion: a fetch that never settles is unreachable after 15 s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let aborted = false;
    const fetch = (url, opts) => { opts.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); };
    const pending = askVersion('https://x.example.com', { fetch });
    mock.timers.tick(14999);
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.deepEqual(await pending, { ok: false, reason: 'unreachable' });
    assert.equal(aborted, true);
  } finally {
    mock.timers.reset();
  }
});

test('MESSAGES covers every reason', () => {
  for (const k of ['empty', 'http', 'invalid', 'unreachable', 'notFriendflix']) assert.ok(win.FFSetupCore.MESSAGES[k]);
});
