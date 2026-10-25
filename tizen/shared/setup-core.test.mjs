// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// setup-core.js is a classic script that fills window.FFSetupCore; evaluate it here with a stand-in window
const win = {};
new Function('window', 'URL', readFileSync(new URL('./setup-core.js', import.meta.url), 'utf8'))(win, URL);
const { normaliseServer, checkVersionAnswer, watchUrl } = win.FFSetupCore;

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
