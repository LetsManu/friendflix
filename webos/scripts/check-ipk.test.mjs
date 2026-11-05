// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-ipk.sh', import.meta.url));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** a directory with one crafted .ipk (ar of data.tar.gz holding the given files) */
function craft(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ff-webos-ipk-'));
  dirs.push(dir);
  const data = join(dir, 'data');
  mkdirSync(join(data, 'usr/palm/applications/x'), { recursive: true });
  for (const f of files) writeFileSync(join(data, 'usr/palm/applications/x', f), 'x');
  const out = join(dir, 'out');
  mkdirSync(out);
  const run = (cmd, args, cwd) => assert.equal(spawnSync(cmd, args, { cwd }).status, 0, cmd);
  run('tar', ['czf', join(dir, 'data.tar.gz'), '-C', data, 'usr'], dir);
  writeFileSync(join(dir, 'debian-binary'), '2.0\n');
  run('ar', ['rc', join(out, 'x.ipk'), 'debian-binary', 'data.tar.gz'], dir);
  return out;
}
const ALL = ['appinfo.json', 'index.html', 'setup.js', 'setup-core.js', 'icon.png'];

test('check-ipk passes when every required file is present', () => {
  const r = spawnSync('bash', [script, craft(ALL)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('check-ipk fails naming a missing file', () => {
  const r = spawnSync('bash', [script, craft(ALL.filter((f) => f !== 'setup-core.js'))], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /setup-core\.js missing in x\.ipk/);
});

test('check-ipk fails on a directory without .ipk files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-webos-ipk-'));
  dirs.push(dir);
  assert.equal(spawnSync('bash', [script, dir], { encoding: 'utf8' }).status, 1);
});
