// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkConfig, privilegesOf, stripComments, APPS, run } from './check-config.mjs';

const xml = (dir) => readFileSync(new URL(`./${dir}/config.xml`, import.meta.url), 'utf8');

test('the shipped config.xml files pass', () => {
  assert.deepEqual(run(), []);
});

test('check-config catches missing pieces', () => {
  const app = APPS[0];
  const good = xml('app');
  const bad = (from, to) => checkConfig(good.replace(from, to), app);
  assert.ok(bad('required_version="6.5"', 'required_version="6.0"').length > 0);
  assert.ok(bad('http://developer.samsung.com/privilege/avplay', 'x').length > 0);
  assert.ok(bad('id="FrFlixTV01.FriendFlix"', 'id="short.FriendFlix"').length > 0);
  assert.ok(bad('<icon src="icon.png"/>', '').length > 0);
  assert.ok(bad('<tizen:allow-navigation>*</tizen:allow-navigation>', '<tizen:allow-navigation>friend.example.com</tizen:allow-navigation>').length > 0);
  assert.ok(bad(' version="0.0.0"', ' version="x"').length > 0);
});

test('the probe (and only the probe) declares the productinfo privilege', () => {
  const PI = 'http://developer.samsung.com/privilege/productinfo';
  const [app, probe] = APPS;
  assert.ok(privilegesOf(xml('probe')).has(PI));
  assert.ok(!privilegesOf(xml('app')).has(PI));
  // the app must not carry it, the probe must
  const addTo = (x) => x.replace('</widget>', `  <tizen:privilege name="${PI}"/>\n</widget>`);
  assert.ok(checkConfig(addTo(xml('app')), app).includes(`unexpected privilege: ${PI}`));
  assert.ok(checkConfig(xml('probe').replace(`<tizen:privilege name="${PI}"/>`, ''), probe).includes(`privilege missing: ${PI}`));
});

test('the Opening screen lasts well beyond the 1 s red-key hold', () => {
  const js = readFileSync(new URL('./app/setup.js', import.meta.url), 'utf8');
  const hold = Number(/RED_HOLD_MS = (\d+)/.exec(js)?.[1]);
  const open = Number(/OPEN_DELAY_MS = (\d+)/.exec(js)?.[1]);
  assert.equal(hold, 1000);
  assert.ok(open >= 3000, `OPEN_DELAY_MS is ${open}`);
});

test('comments are stripped until none is left, also when one hides inside another', () => {
  assert.equal(stripComments('a<!-- x -->b'), 'ab');
  assert.equal(stripComments('a<!<!-- -->-- y -->b'), 'ab');
  assert.deepEqual([...privilegesOf('<!-- <tizen:privilege name="p1"/> --><tizen:privilege name="p2"/>')], ['p2']);
});
