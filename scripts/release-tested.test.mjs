// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseTested } from './release-tested.mjs';

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'example/friendflix';
const TAG = '1'.repeat(40);
const P = '2'.repeat(40);
const base = { event: 'push', ref: 'refs/tags/v4.0.3', sha: TAG, repo: REPO };

/** a fake GitHub API: the commit, the compare and a list of run answers handed out in order (the last one repeats) */
function gh({ parents = [{ sha: P }], files = [{ filename: 'version.json', status: 'modified' }, { filename: 'CHANGELOG.md', status: 'modified' }], ahead = 1, behind = 0, runs = [[{ head_sha: P, status: 'completed', conclusion: 'success' }]], fail = '' } = {}) {
  const calls = [];
  let i = 0;
  const api = async (path) => {
    calls.push(path);
    if (fail && path.includes(fail)) throw new Error('HTTP 500');
    if (path === `/repos/${REPO}/commits/${TAG}`) return { parents };
    if (path === `/repos/${REPO}/compare/${P}...${TAG}`) return { ahead_by: ahead, behind_by: behind, files };
    if (path.startsWith(`/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${P}&event=push&branch=main`)) return { workflow_runs: runs[Math.min(i++, runs.length - 1)] };
    throw new Error(`unexpected ${path}`);
  };
  return { api, calls };
}
const fastClock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('a release tag whose only changes are version.json and CHANGELOG.md on a green main commit is tested', async () => {
  const r = await releaseTested({ ...base, ...gh() });
  assert.equal(r.tested, true);
});

test('anything else tests everything: no tag, a branch push, a pull request', async () => {
  for (const o of [{ ref: 'refs/heads/main' }, { ref: 'refs/tags/x4.0.3' }, { event: 'pull_request' }, { ref: 'refs/tags/v4.0.3-rc1' }]) {
    const f = gh();
    assert.equal((await releaseTested({ ...base, ...o, api: f.api })).tested, false, JSON.stringify(o));
    assert.deepEqual(f.calls, [], 'asks GitHub nothing');
  }
  assert.equal((await releaseTested({ ...base, event: 'workflow_dispatch', ...gh() })).tested, true, "release.yml's dispatch for the tag counts");
});

test('a release that touches any other file, or is more than one commit, tests everything', async () => {
  assert.equal((await releaseTested({ ...base, ...gh({ files: [{ filename: 'version.json', status: 'modified' }, { filename: 'backend/src/app.ts', status: 'modified' }] }) })).tested, false);
  assert.equal((await releaseTested({ ...base, ...gh({ files: [{ filename: 'CHANGELOG.md', status: 'renamed' }] }) })).tested, false);
  assert.equal((await releaseTested({ ...base, ...gh({ files: [] }) })).tested, false);
  assert.equal((await releaseTested({ ...base, ...gh({ ahead: 2 }) })).tested, false);
  assert.equal((await releaseTested({ ...base, ...gh({ behind: 1 }) })).tested, false);
  assert.equal((await releaseTested({ ...base, ...gh({ parents: [{ sha: P }, { sha: '3'.repeat(40) }] }) })).tested, false, 'a merge commit');
});

test('main CI for the parent: red, missing or unreadable tests everything', async () => {
  assert.equal((await releaseTested({ ...base, ...gh({ runs: [[{ head_sha: P, status: 'completed', conclusion: 'failure' }]] }) })).tested, false);
  assert.equal((await releaseTested({ ...base, ...gh({ runs: [[]] }) })).tested, false);
  assert.equal((await releaseTested({ ...base, ...gh({ runs: [[{ head_sha: '4'.repeat(40), status: 'completed', conclusion: 'success' }]] }) })).tested, false, 'a run for another commit');
  assert.equal((await releaseTested({ ...base, ...gh({ fail: '/compare/' }) })).tested, false);
  assert.equal((await releaseTested({ ...base, ...gh({ fail: '/runs?' }) })).tested, false);
});

test('a main run still in progress is waited for: green counts, the wait is bounded', async () => {
  const running = [{ head_sha: P, status: 'in_progress', conclusion: null }];
  const green = [{ head_sha: P, status: 'completed', conclusion: 'success' }];
  const c1 = fastClock();
  assert.equal((await releaseTested({ ...base, ...gh({ runs: [running, running, green] }), ...c1, pollMs: 30_000 })).tested, true);
  const c2 = fastClock();
  const r = await releaseTested({ ...base, ...gh({ runs: [running] }), ...c2, waitMs: 120_000, pollMs: 30_000 });
  assert.equal(r.tested, false);
  assert.ok(c2.now() <= 150_000, 'stops after the wait');
});

test('ci.yml: test and e2e skip only on an already tested release; every job that needs them still runs', () => {
  const ci = readFileSync(join(REPO_DIR, '.github/workflows/ci.yml'), 'utf8');
  const job = (name) => {
    const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$(?![\\s\\S]))`).exec(ci);
    assert.ok(m, `job ${name}`);
    return m[1];
  };
  for (const name of ['test', 'e2e']) {
    const j = job(name);
    assert.match(j, /^ {4}needs: release-check$/m);
    // runs when release-check failed or is unknown (fail closed): only an explicit 'true' skips
    assert.match(j, /^ {4}if: \$\{\{ !cancelled\(\) && needs\.release-check\.outputs\.tested != 'true' \}\}$/m);
  }
  for (const name of ['android-release', 'desktop-release', 'tizen-release', 'webos-release', 'publish', 'publish-mediaserver']) {
    assert.match(job(name), /^ {4}if: \$\{\{ !cancelled\(\) && !failure\(\) && \(/m, `${name} runs when test/e2e were skipped, never after a failure`);
  }
  assert.match(job('release-check'), /node scripts\/release-tested\.mjs/);
});
