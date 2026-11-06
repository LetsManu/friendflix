// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAppinfo, pngSize, ALLOWED_KEYS, run } from './check-config.mjs';

const here = (p) => new URL(p, import.meta.url);
const appDir = here('./app').pathname;
const probeDir = here('./probe').pathname;
const info = (dir) => JSON.parse(readFileSync(join(dir, 'appinfo.json'), 'utf8'));

test('the committed configs pass', () => {
  assert.deepEqual(run(), []);
  assert.deepEqual(checkAppinfo(info(appDir), appDir), []);
  assert.deepEqual(checkAppinfo(info(probeDir), probeDir), []);
});

test('each rule fails on its own', () => {
  const good = info(appDir);
  const fails = (changed, dir = appDir) => checkAppinfo(changed, dir).length > 0;
  assert.ok(fails({ ...good, id: 'com.example.tv' }));
  assert.ok(fails({ ...good, id: 'com.friendflix.tv.probe' }));
  assert.ok(fails({ ...good, version: '1.2' }));
  assert.ok(fails({ ...good, version: '1.2.3-rc1' }));
  assert.ok(!fails({ ...good, version: '2.3.0' }), 'a stamped X.Y.Z is fine');
  assert.ok(fails({ ...good, type: 'native' }));
  const noBack = { ...good };
  delete noBack.disableBackHistoryAPI;
  assert.ok(fails(noBack));
  assert.ok(fails({ ...good, bgColor: '#000000' }));
  assert.ok(fails({ ...good, unknownKey: 1 }));
  assert.ok(fails({ ...good, title: 'Other' }));
  assert.deepEqual(Object.keys(good).sort(), [...ALLOWED_KEYS].sort());
});

test('the rule set follows the declared id; an unknown id is a problem', () => {
  const good = info(appDir);
  assert.match(checkAppinfo({ ...good, id: 'com.example.tv' }, appDir)[0], /id is "com.example.tv"/);
  assert.ok(checkAppinfo({ ...good, id: 'com.friendflix.tv.probe' }, appDir).some((p) => /title/.test(p)));
  assert.deepEqual(checkAppinfo(info(probeDir), probeDir), []);
});

test('icon sizes and a missing splash are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-webos-'));
  try {
    cpSync(appDir, dir, { recursive: true });
    assert.deepEqual(checkAppinfo(info(appDir), dir), []);
    writeFileSync(join(dir, 'icon.png'), readFileSync(join(appDir, 'largeIcon.png')));
    assert.ok(checkAppinfo(info(appDir), dir).some((p) => /icon\.png/.test(p)));
    cpSync(join(appDir, 'icon.png'), join(dir, 'icon.png'));
    rmSync(join(dir, 'splash.png'));
    assert.ok(checkAppinfo(info(appDir), dir).some((p) => /splash\.png/.test(p)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pngSize reads the IHDR chunk', () => {
  assert.deepEqual(pngSize(readFileSync(join(appDir, 'icon.png'))), { width: 80, height: 80 });
  assert.deepEqual(pngSize(readFileSync(join(appDir, 'splash.png'))), { width: 1920, height: 1080 });
  assert.equal(pngSize(Buffer.from('not a png at all, not even close')), null);
});
