#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds one LG webOS shell into a developer-mode .ipk.
//   node webos/build.mjs <app|probe> <outDir> [--ares <dir holding ares-package>]
// Works on a temp copy of webos/<app> (the tracked dirs stay untouched): checks its appinfo.json, stamps version.json's
// version, adds tv-shared/setup-core.js (and, for the probe, webos/app/setup.js and setup.css), runs `ares-package` and
// writes <outDir>/FriendFlix-<version>.ipk or <outDir>/FriendFlix-probe-<version>.ipk. Prints that path; exit 1 on any problem.
// Without --ares, ares-package comes from webos/node_modules/.bin (npm ci --prefix webos) or PATH.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { APPS, checkAppinfo } from './check-config.mjs';

const webosDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(webosDir, '..');

/** the strict X.Y.Z version of version.json */
export function readVersion() {
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'version.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version.json has no X.Y.Z version (${version})`);
  return version;
}

export function ipkName(app, version) {
  return app === 'probe' ? `FriendFlix-probe-${version}.ipk` : `FriendFlix-${version}.ipk`;
}

/** copies webos/<app> into tmpDir/<app>, stamps the version, adds the shared scripts; returns that staged dir */
export function stage(app, tmpDir) {
  if (!Object.hasOwn(APPS, app)) throw new Error(`unknown package "${app}", expected app or probe`);
  const src = join(webosDir, app);
  const problems = checkAppinfo(JSON.parse(readFileSync(join(src, 'appinfo.json'), 'utf8')), src);
  if (problems.length) throw new Error(`webos/${app}/appinfo.json: ${problems.join('; ')}`);
  const version = readVersion();
  const dir = join(tmpDir, app);
  cpSync(src, dir, { recursive: true });
  // leftovers of an earlier in-place build never go into the package
  for (const f of readdirSync(dir)) if (f.endsWith('.ipk')) rmSync(join(dir, f));
  const info = JSON.parse(readFileSync(join(dir, 'appinfo.json'), 'utf8'));
  info.version = version;
  writeFileSync(join(dir, 'appinfo.json'), `${JSON.stringify(info, null, 2)}\n`);
  cpSync(join(repoRoot, 'tv-shared/setup-core.js'), join(dir, 'setup-core.js'));
  if (app === 'probe') for (const f of ['setup.js', 'setup.css']) cpSync(join(webosDir, 'app', f), join(dir, f));
  return dir;
}

function main(argv) {
  const args = argv.slice();
  let aresDir = null;
  const i = args.indexOf('--ares');
  if (i !== -1) {
    aresDir = args[i + 1];
    args.splice(i, 2);
  }
  if (args.length !== 2 || (i !== -1 && !aresDir)) throw new Error('Usage: build.mjs <app|probe> <outDir> [--ares <dir with ares-package>]');
  const [app, outDir] = args;
  const work = mkdtempSync(join(tmpdir(), 'ff-webos-'));
  try {
    const dir = stage(app, work);
    const out = join(work, 'out');
    mkdirSync(out);
    // the pinned CLI's own script runs through this node: no .cmd shim, so it also works on Windows (Node refuses to spawn
    // a .cmd without a shell); --ares (tests) and a global install are found on PATH
    const localCli = join(webosDir, 'node_modules/@webos-tools/cli/bin/ares-package.js');
    const path = [aresDir ?? join(webosDir, 'node_modules/.bin'), process.env.PATH].join(delimiter);
    const [cmd, pre] = !aresDir && existsSync(localCli) ? [process.execPath, [localCli]] : ['ares-package', []];
    const r = spawnSync(cmd, [...pre, dir, '-o', out], { encoding: 'utf8', env: { ...process.env, PATH: path } });
    if (r.error) throw new Error(`could not run ares-package: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`ares-package failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
    const ipks = readdirSync(out).filter((f) => f.endsWith('.ipk'));
    if (ipks.length !== 1) throw new Error(`expected one .ipk from ares-package, got ${ipks.length}`);
    mkdirSync(outDir, { recursive: true });
    const target = join(outDir, ipkName(app, readVersion()));
    // the temp dir may sit on another filesystem than outDir
    cpSync(join(out, ipks[0]), target);
    console.log(target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
