// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// webos/install.sh against fake ares-* tools (--ares-dir) that log argv and stdin, and a local fake GitHub release
// server (/releases/latest redirects to /releases/tag/<tag>, files under /releases/download/<tag>/).
// install.ps1 gets a parser check, and the same install cases, when pwsh is on PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const webosDir = join(here, '..');
const work = mkdtempSync(join(tmpdir(), 'ff-webos-install-'));
const aresDir = join(work, 'ares');
const fakeNode = join(work, 'oldnode');
const log = join(work, 'calls.log');
const PASS = 's3cret-Pass';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const releases = {};
for (const tag of ['v1.2.3', 'v1.2.0']) {
  const v = tag.slice(1);
  const files = { [`FriendFlix-${v}.ipk`]: Buffer.from(`app ${v}`), [`FriendFlix-probe-${v}.ipk`]: Buffer.from(`probe ${v}`) };
  files['SHA256SUMS-webos.txt'] = Buffer.from(Object.entries(files).map(([n, b]) => `${sha(b)}  ${n}\n`).join(''));
  releases[tag] = files;
}
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/releases/latest') {
      res.writeHead(302, { location: '/releases/tag/v1.2.3' }).end();
    } else if (url.pathname.startsWith('/releases/tag/')) {
      res.writeHead(200).end('release page');
    } else {
      const m = /^\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      const body = m && releases[m[1]]?.[m[2]];
      if (body) res.writeHead(200).end(body);
      else res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/releases`;

  mkdirSync(aresDir);
  const fake = (name, body) => {
    writeFileSync(join(aresDir, name), `#!/usr/bin/env bash\necho "${name} $*" >> "$SHIM_LOG"\n${body}\n`);
    chmodSync(join(aresDir, name), 0o755);
  };
  // the real tool exits non-zero when the device is unknown
  fake('ares-setup-device', `if [ "$1" = --remove ]; then echo "not found: friendflix-tv" >&2; exit 1; fi\nexit 0`);
  fake('ares-novacom', `echo "stdin: $(cat)" >> "$SHIM_LOG"\nexit "\${GETKEY_RC:-0}"`);
  fake('ares-install', 'exit 0');
  fake('ares-launch', 'exit 0');
  // a node that reports version 18 for the version probe
  mkdirSync(fakeNode);
  writeFileSync(join(fakeNode, 'node'), '#!/usr/bin/env bash\necho 18\n');
  chmodSync(join(fakeNode, 'node'), 0o755);
});

after(() => {
  server?.close();
  rmSync(work, { recursive: true, force: true });
});

// checked synchronously while the file loads: a top-level await here would let the earlier tests finish and the `after`
// hook delete the work dir before this test is registered
let hasPwsh = false;
try { execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }); hasPwsh = true; } catch { /* not installed */ }

function run(cmd, args, env = {}) {
  rmSync(log, { force: true });
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: work, env: { ...process.env, SHIM_LOG: log, ...env } }, (err, stdout, stderr) => {
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr, out: stdout + stderr, calls });
    });
  });
}
const installSh = (args, env) => run('bash', [join(webosDir, 'install.sh'), ...args, '--ares-dir', aresDir, '--base-url', base], env);

test('install.sh: bash -n', () => {
  execFileSync('bash', ['-n', join(webosDir, 'install.sh')]);
});

test('install.ps1: parses (pwsh)', { skip: !hasPwsh && 'pwsh not on PATH' }, () => {
  const script = join(webosDir, 'install.ps1').replace(/'/g, "''");
  execFileSync('pwsh', ['-NoProfile', '-Command',
    `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { Write-Error $_.Message }; exit 1 }`]);
});

test('install.sh: usage errors exit 2 without calling ares', async () => {
  for (const args of [[], ['--probe'], ['not-an-ip', PASS], ['192.0.2.300', PASS], ['192.0.2.10', PASS, '--version'], ['192.0.2.10', PASS, '--version', '1.2'], ['192.0.2.10', PASS, '--bogus'], ['192.0.2.10', PASS, 'extra'], ['192.0.2.10', PASS, '--ipk']]) {
    const r = await installSh(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, /Usage:/);
    assert.deepEqual(r.calls, []);
    assert.ok(!r.out.includes(PASS));
  }
});

test('install.sh: Node older than 20 stops with the download hint', async () => {
  const r = await installSh(['192.0.2.10', PASS], { PATH: `${fakeNode}:${process.env.PATH}` });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Node\.js 20 or newer is needed: https:\/\/nodejs\.org\//);
  assert.deepEqual(r.calls, []);
});

test('install.sh: happy path runs remove, add, getkey, install, launch in order', async () => {
  const r = await installSh(['192.0.2.10', PASS]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls.slice(0, 3), [
    'ares-setup-device --remove friendflix-tv',
    'ares-setup-device --add friendflix-tv -i host=192.0.2.10 -i port=9922 -i username=prisoner',
    'ares-novacom --device friendflix-tv --getkey',
  ]);
  assert.equal(r.calls[3], `stdin: ${PASS}`);
  assert.match(r.calls[4], /^ares-install --device friendflix-tv \S*FriendFlix-1\.2\.3\.ipk$/);
  assert.equal(r.calls[5], 'ares-launch --device friendflix-tv com.friendflix.tv');
  assert.equal(r.calls.length, 6);
  assert.match(r.out, /Installed FriendFlix\. Developer Mode expires after 50 hours: press Extend in the Developer Mode app\./);
});

test('install.sh: --probe installs the test app; --version picks the release', async () => {
  let r = await installSh(['192.0.2.10', PASS, '--probe', '--version', 'v1.2.0']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls.at(-2), /FriendFlix-probe-1\.2\.0\.ipk$/);
  assert.equal(r.calls.at(-1), 'ares-launch --device friendflix-tv com.friendflix.tv.probe');
  assert.match(r.out, /Installed FriendFlix Test\./);
  r = await installSh(['--version', '1.2.0', '192.0.2.10', PASS]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls.at(-2), /FriendFlix-1\.2\.0\.ipk$/);
});

test('install.sh: --ipk uses the given file without downloading', async () => {
  const ipk = join(work, 'local build.ipk');
  writeFileSync(ipk, 'local');
  const r = await run('bash', [join(webosDir, 'install.sh'), '192.0.2.10', PASS, '--ipk', ipk, '--ares-dir', aresDir, '--base-url', 'http://127.0.0.1:9/none']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.at(-2), `ares-install --device friendflix-tv ${ipk}`);
  const missing = await run('bash', [join(webosDir, 'install.sh'), '192.0.2.10', PASS, '--ipk', join(work, 'nope.ipk'), '--ares-dir', aresDir]);
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.calls, []);
});

test('install.sh: a wrong or missing checksum, or a missing release, runs no ares command', async () => {
  let r = await installSh(['192.0.2.10', PASS, '--version', 'v9.9.9']);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.calls, []);
  releases['v1.2.0']['FriendFlix-1.2.0.ipk'] = Buffer.from('tampered');
  try {
    r = await installSh(['192.0.2.10', PASS, '--version', 'v1.2.0']);
    assert.equal(r.code, 1);
    assert.match(r.out, /SHA-256 mismatch/);
    assert.deepEqual(r.calls, []);
  } finally {
    releases['v1.2.0']['FriendFlix-1.2.0.ipk'] = Buffer.from('app 1.2.0');
  }
  const sums = releases['v1.2.0']['SHA256SUMS-webos.txt'];
  releases['v1.2.0']['SHA256SUMS-webos.txt'] = Buffer.from(`${'0'.repeat(64)}  other.ipk\n`);
  try {
    r = await installSh(['192.0.2.10', PASS, '--version', 'v1.2.0']);
    assert.equal(r.code, 1);
    assert.match(r.out, /no SHA-256 for FriendFlix-1\.2\.0\.ipk/);
    assert.deepEqual(r.calls, []);
  } finally {
    releases['v1.2.0']['SHA256SUMS-webos.txt'] = sums;
  }
});

test('install.sh: the passphrase appears only on the getkey stdin', async () => {
  for (const extra of [{}, { GETKEY_RC: '1' }]) {
    const r = await installSh(['192.0.2.10', PASS], extra);
    assert.ok(!r.stdout.includes(PASS), 'stdout');
    assert.ok(!r.stderr.includes(PASS), 'stderr');
    const hits = r.calls.filter((c) => c.includes(PASS));
    assert.deepEqual(hits, [`stdin: ${PASS}`]);
    assert.ok(!r.calls.some((c) => c.startsWith('ares-') && c.includes(PASS)), 'argv');
  }
});

test('install.sh: a failing getkey stops before install, with a hint', async () => {
  const r = await installSh(['192.0.2.10', PASS], { GETKEY_RC: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /Developer Mode/);
  assert.ok(!r.calls.some((c) => c.startsWith('ares-install') || c.startsWith('ares-launch')));
});

test('install.sh: an existing device entry is replaced (remove failing is ignored, reruns repeat the sequence)', async () => {
  const first = await installSh(['192.0.2.10', PASS]);
  assert.equal(first.code, 0, first.out);
  const second = await installSh(['192.0.2.10', PASS]);
  assert.equal(second.code, 0, second.out);
  const norm = (calls) => calls.map((c) => c.replace(/\S*\/(FriendFlix-)/, '$1'));
  assert.deepEqual(norm(second.calls), norm(first.calls));
  assert.equal(first.calls[0], 'ares-setup-device --remove friendflix-tv');
  assert.match(first.calls[1], /^ares-setup-device --add friendflix-tv /);
});

test('install.ps1: the same install cases (pwsh)', { skip: !hasPwsh && 'pwsh not on PATH' }, async () => {
  const ps = (args, env) => run('pwsh', ['-NoProfile', '-File', join(webosDir, 'install.ps1'), ...args, '-AresDir', aresDir, '-BaseUrl', base], env);
  let r = await ps([]);
  assert.equal(r.code, 2);
  assert.deepEqual(r.calls, []);
  r = await ps(['192.0.2.10', PASS]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls[0], 'ares-setup-device --remove friendflix-tv');
  assert.equal(r.calls[3], `stdin: ${PASS}`);
  assert.equal(r.calls.at(-1), 'ares-launch --device friendflix-tv com.friendflix.tv');
  assert.ok(!r.out.includes(PASS));
  r = await ps(['192.0.2.10', PASS, '-Probe', '-Version', 'v1.2.0']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.at(-1), 'ares-launch --device friendflix-tv com.friendflix.tv.probe');
});

// Windows PowerShell 5.1 strips double quotes inside arguments to native programs, so a `node -p '..."x"...'` call
// reaches Node as broken code (the Node 20+ check then failed with Node 26 installed). Native calls carry no `"`.
test('install.ps1: no double quotes inside single-quoted arguments to node', () => {
  const src = readFileSync(join(webosDir, 'install.ps1'), 'utf8');
  const bad = src.split('\n').filter((l) => /&\s*node\b/.test(l) && /'[^']*"[^']*'/.test(l));
  assert.deepEqual(bad, []);
});
