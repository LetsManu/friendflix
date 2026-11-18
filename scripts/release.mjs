#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cuts a FriendFlix release (used by .github/workflows/release.yml, runnable locally with --dry-run):
 *   1. bumps version.json (SemVer; a new MAJOR also takes the next codename from codenames.json, A–Z cinema snacks)
 *   2. turns CHANGELOG "## [Unreleased]" into "## [x.y.z] – Codename – YYYY-MM-DD" with a fresh empty Unreleased above
 * version.json is the only version file (package.json and package-lock.json say 0.0.0 once), so a release changes the
 * inputs of the backend image alone. It never commits, tags or pushes; the workflow does that. Refuses when the Unreleased section is empty.
 *
 * Usage: node scripts/release.mjs <patch|minor|major|none> [--dry-run] [--notes <file>] [--date YYYY-MM-DD]
 * Prints a JSON summary ({ version, codename, tag, previous, files }) on stdout; --notes writes the release notes
 * (the changelog section without its heading) to a file.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** codename list in alphabetical order (shared with backend/src/version.ts and web/src/lib/version/codenames.ts) */
export const CODENAMES = JSON.parse(readFileSync(new URL('../codenames.json', import.meta.url), 'utf8')).map((c) => c.name);
/** `none` releases the version already in version.json (the first release, 1.0.0) as long as its tag does not exist */
const KINDS = ['patch', 'minor', 'major', 'none'];

/** "1.2.3" → [1, 2, 3]; anything else (pre-release, "v" prefix, missing parts) throws */
export function parseVersion(v) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(v));
  if (!m) throw new Error(`not a plain SemVer version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** next version for a patch / minor / major bump */
export function bump(version, kind) {
  if (kind === 'none') { parseVersion(version); return version; }
  const [ma, mi, pa] = parseVersion(version);
  if (kind === 'patch') return `${ma}.${mi}.${pa + 1}`;
  if (kind === 'minor') return `${ma}.${mi + 1}.0`;
  if (kind === 'major') return `${ma + 1}.0.0`;
  throw new Error(`unknown bump "${kind}" (expected ${KINDS.join(' | ')})`);
}

/** the codename after `current` in the A–Z list; the end of the list is a deliberate stop (a human picks what comes next) */
export function nextCodename(current, list = CODENAMES) {
  const i = list.indexOf(current);
  if (i < 0) throw new Error(`unknown codename "${current}"`);
  if (i === list.length - 1) throw new Error(`codename list exhausted after "${current}"; extend codenames.json first`);
  return list[i + 1];
}

/** version.json after a bump: the codename changes only with the major version */
export function bumpVersionInfo(info, kind) {
  const version = bump(info.version, kind);
  return { version, codename: kind === 'major' ? nextCodename(info.codename) : info.codename };
}

const UNRELEASED = /^## \[Unreleased\][^\n]*\n/m;

/**
 * Moves the Unreleased section under a version heading and puts a fresh empty Unreleased above it.
 * Older sections stay untouched. Returns the new text and the notes (section body, trimmed).
 */
export function cutChangelog(text, version, codename, date) {
  const m = UNRELEASED.exec(text);
  if (!m) throw new Error('CHANGELOG has no "## [Unreleased]" section');
  const start = m.index + m[0].length;
  const next = text.slice(start).search(/^## /m);
  const end = next < 0 ? text.length : start + next;
  const body = text.slice(start, end);
  const notes = body.trim();
  // only headings / blank lines = nothing to release
  if (!notes.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) throw new Error('the Unreleased section of CHANGELOG.md is empty, nothing to release');
  const heading = `## [${version}] – ${codename} – ${date}`;
  const out = `${text.slice(0, m.index)}## [Unreleased]\n\n${heading}\n\n${notes}\n${end < text.length ? '\n' : ''}${text.slice(end)}`;
  return { text: out, notes };
}

/** body of the `## [version] …` section of a changelog (the notes of an already cut release) */
export function changelogSection(text, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  // plain string search, no regex built from input
  const head = `## [${version}]`;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(head));
  if (at < 0) throw new Error(`CHANGELOG has no section for ${version}`);
  const rest = lines.slice(at + 1).join('\n');
  const next = rest.search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/** git tags of `root` (the workflow checks out with fetch-depth 0, so all tags are there) */
export function gitTags(root = ROOT) {
  return execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' }).split('\n').map((t) => t.trim()).filter(Boolean);
}

/** plans (and unless dryRun writes) a release in `root`; `tags` = existing git tags (a release never reuses one) */
export function release({ root = ROOT, kind, date = new Date().toISOString().slice(0, 10), dryRun = false, tags = [] }) {
  if (!KINDS.includes(kind)) throw new Error(`usage: release.mjs <${KINDS.join('|')}> [--dry-run] [--notes <file>]`);
  const p = (f) => `${root.replace(/\/$/, '')}/${f}`;
  const info = JSON.parse(readFileSync(p('version.json'), 'utf8'));
  const next = bumpVersionInfo(info, kind);
  if (tags.includes(`v${next.version}`)) throw new Error(`tag v${next.version} already exists${kind === 'none' ? ': `none` only releases a version that has no tag yet, pick patch, minor or major' : ''}`);
  const cut = cutChangelog(readFileSync(p('CHANGELOG.md'), 'utf8'), next.version, next.codename, date);
  const writes = new Map([
    ['version.json', `{ "version": ${JSON.stringify(next.version)}, "codename": ${JSON.stringify(next.codename)} }\n`],
    ['CHANGELOG.md', cut.text],
  ]);
  if (!dryRun) for (const [f, text] of writes) writeFileSync(p(f), text);
  return { summary: { version: next.version, codename: next.codename, tag: `v${next.version}`, previous: info.version, date, dryRun, files: [...writes.keys()] }, notes: cut.notes };
}

/** what a bump would release, without touching any file or looking at the changelog / tags (release.yml uses it to resume) */
export function plan({ root = ROOT, kind }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown bump "${kind}" (expected ${KINDS.join(' | ')})`);
  const info = JSON.parse(readFileSync(`${root.replace(/\/$/, '')}/version.json`, 'utf8'));
  const next = bumpVersionInfo(info, kind);
  return { ...next, tag: `v${next.version}`, previous: info.version };
}

/**
 * CLI. `release.mjs <kind> [--dry-run] [--notes f] [--date d]` cuts a release;
 * `release.mjs plan <kind>` prints what it would release; `release.mjs notes <version> --from <changelog> --notes <f>`
 * writes the notes of an already cut version.
 */
function main(argv) {
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  if (args[0] === 'plan') { console.log(JSON.stringify(plan({ kind: args[1] }), null, 2)); return; }
  if (args[0] === 'notes') {
    const from = flag('--from') ?? `${ROOT}/CHANGELOG.md`, out = flag('--notes');
    const notes = changelogSection(readFileSync(from, 'utf8'), args[1]);
    if (out) writeFileSync(out, `${notes}\n`); else console.log(notes);
    return;
  }
  const dryRun = args.includes('--dry-run');
  if (dryRun) args.splice(args.indexOf('--dry-run'), 1);
  const notesFile = flag('--notes');
  const date = flag('--date');
  const { summary, notes } = release({ kind: args[0], dryRun, tags: gitTags(), ...(date ? { date } : {}) });
  if (notesFile) writeFileSync(notesFile, `${notes}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) console.error(`\n--- release notes ${summary.tag} ---\n${notes}`); // stderr: stdout stays pure JSON
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`release: ${e instanceof Error ? e.message : e}`); process.exit(1); }
}
