// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Is this release tag already tested? A release commit (scripts/release.mjs) changes only version.json and CHANGELOG.md on
 * top of a commit of main. When CI on main passed for that commit, the tag run need not repeat `test` and `e2e`: the code
 * is the same, only the version text differs. Answers `tested=true` only when ALL of these hold, else `tested=false`:
 *   - the run is for a `v*` tag (push, or release.yml's workflow_dispatch);
 *   - the tag commit has exactly one parent P and differs from P only in version.json and/or CHANGELOG.md;
 *   - a CI run (ci.yml, push, branch main) for P concluded `success`. A run for P still queued or in progress is waited for
 *     (release.yml pushes the tag right after the merge, while main's CI for P still runs), at most `waitMs`.
 * Any error, a missing run or a failed one answers false: the tag run then tests everything, as before. Fail closed.
 *
 *   node scripts/release-tested.mjs   (env: GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GH_TOKEN,
 *                                      optional GITHUB_OUTPUT and GITHUB_STEP_SUMMARY)
 */
import { appendFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

const { fetch, AbortSignal } = globalThis;

export const RELEASE_FILES = ['version.json', 'CHANGELOG.md'];
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * @param {{ event: string, ref: string, sha: string, repo: string,
 *   api: (path: string) => Promise<any>, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   waitMs?: number, pollMs?: number }} o
 * @returns {Promise<{ tested: boolean, reason: string }>}
 */
export async function releaseTested(o) {
  const no = (reason) => ({ tested: false, reason });
  if (!['push', 'workflow_dispatch'].includes(o.event) || !/^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/.test(o.ref)) return no('kein Release-Tag');
  if (!SHA_RE.test(o.sha)) return no('kein Commit');
  try {
    const commit = await o.api(`/repos/${o.repo}/commits/${o.sha}`);
    const parents = Array.isArray(commit?.parents) ? commit.parents : [];
    if (parents.length !== 1 || !SHA_RE.test(parents[0]?.sha ?? '')) return no('Release-Commit hat nicht genau einen Vorgänger');
    const parent = parents[0].sha;
    const cmp = await o.api(`/repos/${o.repo}/compare/${parent}...${o.sha}`);
    const files = Array.isArray(cmp?.files) ? cmp.files : null;
    if (!files || cmp.ahead_by !== 1 || cmp.behind_by !== 0) return no('Tag ist nicht genau ein Commit nach seinem Vorgänger');
    const other = files.find((f) => !RELEASE_FILES.includes(f?.filename) || f?.status === 'renamed' || f?.status === 'removed');
    if (other || files.length === 0) return no(`Release ändert mehr als ${RELEASE_FILES.join(' und ')}`);

    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = o.now ?? Date.now;
    const until = now() + (o.waitMs ?? 50 * 60_000);
    for (;;) {
      const r = await o.api(`/repos/${o.repo}/actions/workflows/ci.yml/runs?head_sha=${parent}&event=push&branch=main&per_page=20`);
      const runs = Array.isArray(r?.workflow_runs) ? r.workflow_runs.filter((x) => x?.head_sha === parent) : [];
      if (runs.some((x) => x.status === 'completed' && x.conclusion === 'success')) return { tested: true, reason: `CI auf main für ${parent.slice(0, 7)} war grün` };
      const open = runs.some((x) => x.status !== 'completed');
      if (!open) return no(runs.length ? `CI auf main für ${parent.slice(0, 7)} war nicht grün` : `kein CI-Lauf auf main für ${parent.slice(0, 7)}`);
      if (now() >= until) return no(`CI auf main für ${parent.slice(0, 7)} nach der Wartezeit noch nicht fertig`);
      await sleep(o.pollMs ?? 30_000);
    }
  } catch {
    return no('GitHub nicht lesbar');
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GH_TOKEN ?? '';
  const api = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const r = await releaseTested({ event: process.env.GITHUB_EVENT_NAME ?? '', ref: process.env.GITHUB_REF ?? '', sha: process.env.GITHUB_SHA ?? '', repo, api });
  const line = r.tested ? `Release bereits getestet (${r.reason}): test und e2e laufen nicht erneut.` : `Volle Tests (${r.reason}).`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tested=${r.tested}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release-Check\n${line}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
