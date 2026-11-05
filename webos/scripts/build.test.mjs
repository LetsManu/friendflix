// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ipkName, stage } from '../build.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const buildScript = join(root, 'webos/build.mjs');
const version = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8')).version;
const made = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ff-webos-build-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** a directory holding a fake `ares-package` that writes the given file names into its -o directory */
function fakeAres(ipks) {
  const dir = tmp();
  const script = join(dir, 'ares-package');
  const writes = ipks.map((n) => `fs.writeFileSync(path.join(out, ${JSON.stringify(n)}), 'x');`).join('\n');
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
fs.mkdirSync(out, { recursive: true });
${writes}
`);
  chmodSync(script, 0o755);
  return dir;
}

test('ipkName', () => {
  assert.equal(ipkName('app', '2.3.0'), 'FriendFlix-2.3.0.ipk');
  assert.equal(ipkName('probe', '2.3.0'), 'FriendFlix-probe-2.3.0.ipk');
});

test('stage(probe) holds the shared and app scripts and the stamped version', () => {
  const dir = stage('probe', tmp());
  for (const f of ['setup.js', 'setup-core.js', 'setup.css', 'appinfo.json', 'index.html']) assert.ok(existsSync(join(dir, f)), f);
  assert.equal(JSON.parse(readFileSync(join(dir, 'appinfo.json'), 'utf8')).version, version);
});

test('stage leaves the tracked appinfo.json untouched', () => {
  const path = join(root, 'webos/app/appinfo.json');
  const before = readFileSync(path, 'utf8');
  stage('app', tmp());
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('CLI prints the renamed path', () => {
  const ares = fakeAres(['com.friendflix.tv_2.3.0_all.ipk']);
  const out = join(tmp(), 'o');
  const r = spawnSync(process.execPath, [buildScript, 'app', out, '--ares', ares], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(out, `FriendFlix-${version}.ipk`));
  assert.ok(existsSync(join(out, `FriendFlix-${version}.ipk`)));
});

test('CLI fails when ares-package writes two .ipk files', () => {
  const ares = fakeAres(['a.ipk', 'b.ipk']);
  const r = spawnSync(process.execPath, [buildScript, 'probe', join(tmp(), 'o'), '--ares', ares], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /one \.ipk/);
});

test('CLI fails on an unknown package name', () => {
  const r = spawnSync(process.execPath, [buildScript, 'nope', tmp()], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown package/);
});
