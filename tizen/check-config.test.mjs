// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkConfig, APPS, run } from './check-config.mjs';

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
