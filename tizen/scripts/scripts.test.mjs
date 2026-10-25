// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Tizen shell scripts (install.sh, package.sh, install-cli.sh) against PATH shims for sdb/tizen and a local fake
// GitHub release server (/releases/latest redirects to /releases/tag/<tag>, files under /releases/download/<tag>/).
// install.ps1 runs the same install cases when pwsh is on PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const tizenDir = join(here, '..');
const repo = join(tizenDir, '..');
const work = mkdtempSync(join(tmpdir(), 'ff-tizen-scripts-'));
const shims = join(work, 'bin');
const log = join(work, 'calls.log');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// release files: v1.2.3 (latest) and v1.2.0, each with app + probe and a SHA256SUMS-tizen.txt
const releases = {};
for (const tag of ['v1.2.3', 'v1.2.0']) {
  const v = tag.slice(1);
  const files = { [`FriendFlix-${v}.wgt`]: Buffer.from(`app ${v}`), [`FriendFlix-probe-${v}.wgt`]: Buffer.from(`probe ${v}`) };
  files['SHA256SUMS-tizen.txt'] = Buffer.from(Object.entries(files).map(([n, b]) => `${sha(b)}  ${n}\n`).join(''));
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

  mkdirSync(shims);
  const shim = (name, body) => {
    writeFileSync(join(shims, name), `#!/usr/bin/env bash\necho "${name} $*" >> "$SHIM_LOG"\n${body}\n`);
    chmodSync(join(shims, name), 0o755);
  };
  shim('sdb', `case "$1" in
  connect) echo "connecting to $2 ..."; echo "connected to $2" ;;
  devices) printf 'List of devices attached \\n'; [ -n "$SDB_DEVICES" ] && printf '%b\\n' "$SDB_DEVICES" ;;
esac
exit 0`);
  // tizen: install (exit code / output from the environment), package (writes <name>.wgt into -o, records the build dir)
  shim('tizen', `if [ "$1" = install ]; then
  echo "$TIZEN_INSTALL_OUT"; exit "\${TIZEN_INSTALL_RC:-0}"
fi
if [ "$1" = package ]; then
  out=""; dir=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; --) dir="$2"; shift ;; esac; shift; done
  seen="$(dirname "$SHIM_LOG")/seen-$(basename "$dir")"; mkdir -p "$out"; (cd "$dir" && ls -A | sort) > "$seen.txt"; cp "$dir/config.xml" "$seen.xml"
  echo "built from $dir" > "$out/Whatever.wgt"; echo "Package File Location: $out/Whatever.wgt"
fi
exit 0`);
});

after(() => {
  server?.close();
  rmSync(work, { recursive: true, force: true });
});

const DEVICE = '192.0.2.10:26101\tdevice\t\tQE55Q80BAT';

function run(cmd, args, env = {}) {
  rmSync(log, { force: true });
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: work,
      env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, SHIM_LOG: log, SDB_DEVICES: DEVICE, ...env },
    }, (err, stdout, stderr) => {
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
      resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr, calls });
    });
  });
}

const installSh = (args, env) => run('bash', [join(tizenDir, 'install.sh'), ...args], env);

test('install.sh: usage errors exit 2 without calling sdb', async () => {
  for (const args of [[], ['--probe'], ['not-an-ip'], ['192.0.2.300'], ['192.0.2.10', '--version'], ['192.0.2.10', '--version', '1.2'], ['192.0.2.10', '--bogus'], ['192.0.2.10', '192.0.2.11']]) {
    const r = await installSh([...args, '--base-url', base]);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, /Usage:/);
    assert.deepEqual(r.calls, []);
  }
});

test('install.sh: latest release, hash checked, sdb connect + tizen install on the TV', async () => {
  const r = await installSh(['192.0.2.10', '--base-url', base]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /v1\.2\.3/);
  assert.equal(r.calls[0], 'sdb connect 192.0.2.10:26101');
  assert.equal(r.calls[1], 'sdb devices');
  assert.match(r.calls[2], /^tizen install -n \S+\/FriendFlix-1\.2\.3\.wgt -t QE55Q80BAT$/);
});

test('install.sh: --probe and --version pick the file and the tag', async () => {
  let r = await installSh(['192.0.2.10', '--probe', '--version', 'v1.2.0', '--base-url', base]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls.at(-1), /FriendFlix-probe-1\.2\.0\.wgt -t QE55Q80BAT$/);
  r = await installSh(['--version', '1.2.0', '192.0.2.10', '--base-url', base]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls.at(-1), /FriendFlix-1\.2\.0\.wgt/);
});

test('install.sh: a missing release or a wrong hash stops before the TV is touched', async () => {
  let r = await installSh(['192.0.2.10', '--version', 'v9.9.9', '--base-url', base]);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.calls, []);
  releases['v1.2.0']['FriendFlix-1.2.0.wgt'] = Buffer.from('tampered');
  try {
    r = await installSh(['192.0.2.10', '--version', 'v1.2.0', '--base-url', base]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /SHA-256 mismatch/);
    assert.deepEqual(r.calls, []);
  } finally {
    releases['v1.2.0']['FriendFlix-1.2.0.wgt'] = Buffer.from('app 1.2.0');
  }
  const sums = releases['v1.2.0']['SHA256SUMS-tizen.txt'];
  releases['v1.2.0']['SHA256SUMS-tizen.txt'] = Buffer.from(`${'0'.repeat(64)}  other.wgt\n`);
  try {
    r = await installSh(['192.0.2.10', '--version', 'v1.2.0', '--base-url', base]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no SHA-256 for FriendFlix-1\.2\.0\.wgt/);
    assert.deepEqual(r.calls, []);
  } finally {
    releases['v1.2.0']['SHA256SUMS-tizen.txt'] = sums;
  }
});

test('install.sh: TV not connected or install failing prints the hints and exits non-zero', async () => {
  let r = await installSh(['192.0.2.10', '--base-url', base], { SDB_DEVICES: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Developer mode/i);
  assert.match(r.out, /same network/i);
  assert.ok(!r.calls.some((c) => c.startsWith('tizen install')));
  r = await installSh(['192.0.2.10', '--base-url', base], { SDB_DEVICES: '192.0.2.10:26101\toffline\t\tQE55Q80BAT' });
  assert.notEqual(r.code, 0);
  r = await installSh(['192.0.2.10', '--base-url', base], { TIZEN_INSTALL_RC: '1' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /DUID/);
  // the Tizen CLI may exit 0 although the install failed; its output decides
  r = await installSh(['192.0.2.10', '--base-url', base], { TIZEN_INSTALL_OUT: 'install failed[118, -12], reason: Check certificate error' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /DUID/);
});

const packageSh = (args, env) => run('bash', [join(here, 'package.sh'), ...args], env);

test('package.sh: builds a copy with setup-core.js (and setup.js for the probe), version stamped, repo untouched', async () => {
  const version = JSON.parse(readFileSync(join(repo, 'version.json'), 'utf8')).version;
  const before = { app: readdirSync(join(tizenDir, 'app')).sort(), probe: readdirSync(join(tizenDir, 'probe')).sort() };
  const out = join(work, 'out-app');
  let r = await packageSh(['app', out]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls.some((c) => /^tizen package -t wgt -s friendflix-dev -o \S+ -- \S+$/.test(c)), r.calls.join('\n'));
  assert.ok(existsSync(join(out, `FriendFlix-${version}.wgt`)), readdirSync(out).join(' '));
  assert.ok(!existsSync(join(out, 'Whatever.wgt')));
  const listing = readFileSync(join(work, 'seen-app.txt'), 'utf8').split('\n');
  for (const f of ['config.xml', 'index.html', 'setup.js', 'setup-core.js', 'setup.css', 'icon.png']) assert.ok(listing.includes(f), f);
  assert.match(readFileSync(join(work, 'seen-app.xml'), 'utf8'), new RegExp(`<widget [^>]*version="${version.replace(/\./g, '\\.')}"`));

  const pout = join(work, 'out-probe');
  r = await packageSh(['probe', pout, '--sign']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls.some((c) => /^tizen package -t wgt -s friendflix -o /.test(c)), r.calls.join('\n'));
  assert.ok(existsSync(join(pout, `FriendFlix-probe-${version}.wgt`)));
  const plisting = readFileSync(join(work, 'seen-probe.txt'), 'utf8').split('\n');
  for (const f of ['setup.js', 'setup-core.js']) assert.ok(plisting.includes(f), f);

  assert.deepEqual({ app: readdirSync(join(tizenDir, 'app')).sort(), probe: readdirSync(join(tizenDir, 'probe')).sort() }, before);
  assert.match(readFileSync(join(tizenDir, 'app', 'config.xml'), 'utf8'), /version="0\.0\.0"/);
});

test('package.sh: usage errors exit 2', async () => {
  for (const args of [[], ['tv', join(work, 'x')], ['app'], ['app', join(work, 'x'), '--bogus']]) {
    const r = await packageSh(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.deepEqual(r.calls, []);
  }
});

const addProfile = (args, env) => run('bash', [join(here, 'add-profile.sh'), ...args], env);

test('add-profile.sh: refuses passwords the Tizen CLI wrapper would mangle, before calling it', async () => {
  let r = await addProfile(['friendflix'], { AUTHOR_PW: 'x' });
  assert.equal(r.code, 2);
  for (const [author, dist] of [["it's-Secret9", 'ok'], ['Sec  ret9', 'ok'], ['ok', 'Sec*ret9'], ['ok', 'grünSecret'], [' LeadSecret9', 'ok']]) {
    r = await addProfile(['friendflix', 'author.p12', 'dist.p12'], { AUTHOR_PW: author, DIST_PW: dist });
    assert.equal(r.code, 1, `${author} / ${dist}: ${r.out}`);
    assert.match(r.out, /password has characters the Tizen CLI cannot take/);
    assert.ok(!r.out.includes(author === 'ok' ? dist : author), 'the password itself is never printed');
    assert.deepEqual(r.calls, []);
  }
});

const installCli = (env) => run('bash', [join(here, 'install-cli.sh'), join(work, 'studio')], env);

test('install-cli.sh: fails closed on a missing pin and on a hash mismatch', async () => {
  const lock = join(work, 'test.lock');
  writeFileSync(lock, 'url=https://download.tizen.org/x.bin\nsha256=TODO\n');
  let r = await installCli({ TIZEN_CLI_LOCK: lock });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not pinned/);
  const payload = join(work, 'payload.bin');
  writeFileSync(payload, 'not the installer');
  writeFileSync(lock, `url=file://${payload}\nsha256=${'0'.repeat(64)}\n`);
  r = await installCli({ TIZEN_CLI_LOCK: lock });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /SHA-256 mismatch/);
  assert.ok(!existsSync(join(work, 'studio')));
});

test('the pinned Tizen CLI lock is complete', () => {
  const text = readFileSync(join(tizenDir, 'tizen-cli.lock'), 'utf8');
  assert.match(text, /^url=https:\/\/download\.tizen\.org\/\S+\.bin$/m);
  assert.match(text, /^sha256=[0-9a-f]{64}$/m);
});

const hasPwsh = await new Promise((resolve) => execFile('pwsh', ['-NoProfile', '-Command', 'exit 0'], (err) => resolve(!err)));

test('install.ps1: the same install cases (pwsh)', { skip: !hasPwsh && 'pwsh not on PATH' }, async () => {
  const ps = (args, env) => run('pwsh', ['-NoProfile', '-File', join(tizenDir, 'install.ps1'), ...args], env);
  let r = await ps(['-BaseUrl', base]);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.calls, []);
  r = await ps(['192.0.2.10', '-BaseUrl', base]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls[0], 'sdb connect 192.0.2.10:26101');
  assert.match(r.calls.at(-1), /FriendFlix-1\.2\.3\.wgt -t QE55Q80BAT$/);
  r = await ps(['192.0.2.10', '-Probe', '-Version', 'v1.2.0', '-BaseUrl', base]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls.at(-1), /FriendFlix-probe-1\.2\.0\.wgt -t QE55Q80BAT$/);
  r = await ps(['192.0.2.10', '-BaseUrl', base], { TIZEN_INSTALL_RC: '1' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /DUID/);
});
