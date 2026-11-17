#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The CI change plan: which images must be built and which jobs do real work (docs/superpowers/specs/2026-11-17-ci-changed-only-design.md).
 *   - the change map (.github/images.json) lists each image's inputs; isInput decides for one path
 *   - an image's image commit is the newest first-parent commit that touched one of its inputs (a merge counts as the merge
 *     commit, a rename counts on both sides, a revert is a new commit); equal image commits mean equal inputs
 *   - the change classes (docs only, version.json, code, map/script → full) decide what test, e2e and dast run
 * Stage A only reports: a pull request compares the image commits at its base and its merge commit, every other event builds all.
 *
 * Usage:
 *   node scripts/changed-images.mjs plan --event <e> --sha <s> [--pr-base <s>] [--full] [--summary <file>]
 *     prints the plan as one JSON line; --summary appends a Markdown table (for $GITHUB_STEP_SUMMARY); an empty --pr-base
 *     counts as absent, a pull_request needs one
 *   node scripts/changed-images.mjs image-commit <image> [--ref <r>]   prints "<sha> <epoch>"
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAP_FILE = '.github/images.json';
/** the docs class; with version.json added it is the version class (both: docs-mode tests, no e2e, no dast) */
const DOCS = ['docs/**', '**/*.md'];
const VERSION_FILE = 'version.json';
/** changes that make e2e / dast run in full besides a web build */
const E2E_DIRS = ['e2e/', '.github/workflows/', '.github/actions/'];
const DAST_DIRS = ['.zap/', '.github/workflows/', '.github/actions/'];

/** the change map; throws on a group or @image that does not exist */
export function loadMap(root = ROOT) {
  const map = JSON.parse(readFileSync(join(root, MAP_FILE), 'utf8'));
  for (const [name, image] of Object.entries(map.images ?? {})) {
    for (const g of image.groups ?? []) if (!map.groups?.[g]) throw new Error(`${MAP_FILE}: ${name} names unknown group "${g}"`);
    for (const p of image.inputs ?? []) {
      const ref = p.replace(/^!/, '');
      if (ref.startsWith('@') && !map.images[ref.slice(1)]) throw new Error(`${MAP_FILE}: ${name} names unknown image "${ref}"`);
    }
  }
  return map;
}

/** image names in map order */
export const IMAGES = Object.keys(loadMap().images);

/** a glob as a RegExp over a repository path: `**` any number of folders, `*` and `?` within one segment */
function globRe(glob) {
  const segs = glob.split('/');
  let re = '';
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s === '**') { re += last ? '.*' : '(?:[^/]+/)*'; return; }
    re += s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (!last) re += '/';
  });
  return new RegExp(`^${re}$`, 's'); // s: a file name may hold a newline
}

/** a pattern list where the last matching entry wins and `!` negates; `@image` entries call `atImage(name, path)` */
function listMatcher(patterns, atImage) {
  const rules = patterns.map((p) => {
    const neg = p.startsWith('!');
    const body = neg ? p.slice(1) : p;
    if (body.startsWith('@')) { const name = body.slice(1); return { neg, test: (path) => atImage(name, path) }; }
    const re = globRe(body);
    return { neg, test: (path) => re.test(path) };
  });
  return (path) => {
    let hit = false;
    for (const r of rules) if (r.test(path)) hit = !r.neg;
    return hit;
  };
}

/** `.dockerignore` as a predicate "the build context drops this path": a pattern drops a path it or a parent folder matches,
 *  a later `!pattern` re-includes, a leading `/` (or `./`) is ignored, `#` lines are comments */
function dockerignoreDrops(root) {
  const file = join(root, '.dockerignore');
  if (!existsSync(file)) return () => false;
  const rules = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const neg = l.startsWith('!');
    const body = (neg ? l.slice(1) : l).trim().replace(/^(\.?\/)+/, '').replace(/\/+$/, '');
    return { neg, re: globRe(body) };
  });
  return (path) => {
    const parts = path.split('/');
    const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    let dropped = false;
    for (const r of rules) if (candidates.some((c) => r.re.test(c))) dropped = !r.neg;
    return dropped;
  };
}

/** one predicate (image, path) → boolean for a map and a checkout; compiled once so a history scan stays cheap */
function inputMatcher(map, root) {
  const drops = dockerignoreDrops(root);
  const excluded = listMatcher(map.exclude ?? []);
  const full = listMatcher(map.full ?? []);
  const own = new Map();
  const shared = new Map();
  const visiting = new Set();
  const image = (name) => {
    const def = map.images?.[name];
    if (!def) throw new Error(`unknown image "${name}"`);
    return def;
  };
  /** the image's own build-context inputs (its inputs, @images), minus `.dockerignore` drops */
  const ownInput = (name, path) => {
    if (!own.has(name)) {
      const def = image(name);
      const inputs = listMatcher(def.inputs ?? [], (other, p) => {
        if (visiting.has(other)) throw new Error(`${MAP_FILE}: @${other} refers back to itself`);
        visiting.add(other);
        try { return ownInput(other, p); } finally { visiting.delete(other); }
      });
      own.set(name, (p) => inputs(p) && !drops(p));
    }
    return own.get(name)(path);
  };
  /** the Dockerfile, groups, full files and argsFrom: never subtracted by `.dockerignore` (it drops .github, yet the build
   *  action is an input; BuildKit reads the Dockerfile whatever the context drops) */
  const sharedInput = (name, path) => {
    if (!shared.has(name)) {
      const def = image(name);
      const lists = [...(def.groups ?? []).map((g) => listMatcher(map.groups[g])), listMatcher(def.argsFrom ?? [])];
      shared.set(name, (p) => p === def.dockerfile || full(p) || lists.some((m) => m(p)));
    }
    return shared.get(name)(path);
  };
  return (name, path) => {
    image(name);
    return !excluded(path) && (sharedInput(name, path) || ownInput(name, path));
  };
}

/** whether a change to `path` changes `image` */
export function isInput(map, image, path, root = ROOT) {
  return inputMatcher(map, root)(image, path);
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });

/** `rev` as a full commit sha */
function resolve(root, rev) {
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();
}

/** the image commits found at `rev`; images whose inputs no commit touched are missing */
function scanImageCommits(root, map, rev) {
  const names = Object.keys(map.images);
  const matches = inputMatcher(map, root);
  const found = {};
  const out = git(root, ['log', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--root', '--name-only', '-z', '--format=%x00%H %ct', rev, '--']);
  // -z: "\0<sha> <time>\0\n<file>\0<file>\0…" per commit
  let commit = null;
  for (const token of out.split('\0')) {
    const head = /^([0-9a-f]{40,64}) (\d+)$/.exec(token);
    if (head) { commit = { commit: head[1], time: Number(head[2]) }; continue; }
    const path = token.replace(/^\n/, '');
    if (!path || !commit) continue;
    for (const name of names) if (!found[name] && matches(name, path)) found[name] = commit;
    if (names.every((n) => found[n])) break;
  }
  return Object.fromEntries(names.filter((n) => found[n]).map((n) => [n, found[n]]));
}

/** per image (map order) the newest first-parent commit at `rev` that touched its inputs, with its commit time */
export function imageCommits(root, map, rev) {
  const found = scanImageCommits(root, map, rev);
  for (const name of Object.keys(map.images)) if (!found[name]) throw new Error(`no commit touches the inputs of ${name}`);
  return found;
}

/** files that differ between two commits (a rename lists both paths) */
export function changedFiles(root, from, to) {
  return git(root, ['diff', '--name-only', '--no-renames', '-z', from, to, '--']).split('\0').filter(Boolean);
}

const under = (path, dirs) => dirs.some((d) => path.startsWith(d));

/** which test, e2e and dast work the changed files need; `built` = images this run builds */
export function classify(map, files, built) {
  const fullFile = listMatcher(map.full ?? []);
  const isDocs = listMatcher(DOCS);
  const full = files.find((f) => fullFile(f));
  if (full) return { tests: 'full', e2e: true, dast: true, full: true, reason: `${full} geändert: alles voll` };
  const rest = files.filter((f) => !isDocs(f));
  if (rest.length === 0) return { tests: 'docs', e2e: false, dast: false, full: false, reason: 'nur Doku' };
  if (rest.every((f) => f === VERSION_FILE)) return { tests: 'docs', e2e: false, dast: false, full: false, reason: 'nur version.json (und Doku)' };
  const web = built.has('web');
  return {
    tests: 'full',
    e2e: web || files.some((f) => under(f, E2E_DIRS)),
    dast: web || files.some((f) => under(f, DAST_DIRS)),
    full: false,
    reason: 'Code geändert',
  };
}

const ALL_FULL = (reason) => ({ tests: 'full', e2e: true, dast: true, full: true, reason });

/**
 * The plan for one CI run. pull_request: an image is carried iff its image commits at `sha` and `prBase` are equal, classes from
 * the files changed between them. Any other event (Stage A): report only, every image builds, classes full; `full` → mode full.
 */
export function plan({ root = ROOT, map = loadMap(root), event, sha, prBase, full = false }) {
  const head = resolve(root, sha);
  const at = imageCommits(root, map, head);
  const entry = (name, action, reason) => ({
    action,
    reason,
    commit: at[name].commit,
    time: at[name].time,
    required: map.images[name].required === true,
    reproducible: map.images[name].reproducible === true,
    base: null,
  });
  const names = Object.keys(map.images);
  if (event === 'pull_request') {
    if (!prBase) throw new Error('--pr-base fehlt');
    const base = resolve(root, prBase);
    const before = scanImageCommits(root, map, base);
    const images = Object.fromEntries(names.map((n) => [n, before[n]?.commit === at[n].commit
      ? entry(n, 'carry', `unverändert seit ${at[n].commit.slice(0, 7)}`)
      : entry(n, 'build', 'Eingaben geändert')]));
    const built = new Set(names.filter((n) => images[n].action === 'build'));
    return { v: 1, event, mode: 'compare', sha: head, base: { commit: base }, classes: classify(map, changedFiles(root, base, head), built), images };
  }
  const [mode, reason] = full ? ['full', 'alles bauen'] : ['report', 'kein Vergleich (nur Bericht)'];
  const images = Object.fromEntries(names.map((n) => [n, entry(n, 'build', reason)]));
  return { v: 1, event, mode, sha: head, base: null, classes: ALL_FULL(reason), images };
}

/** the plan as Markdown for $GITHUB_STEP_SUMMARY */
function summary(p) {
  const yes = (b) => (b ? 'ja' : 'nein');
  const c = p.classes;
  return [
    `### Änderungsplan (${p.mode}${p.base ? `, Basis ${p.base.commit.slice(0, 7)}` : ''})`,
    '',
    `Tests: ${c.tests} · e2e: ${yes(c.e2e)} · dast: ${yes(c.dast)} · ${c.reason}`,
    '',
    '| Image | Aktion | Image-Commit | Grund |',
    '|---|---|---|---|',
    ...Object.entries(p.images).map(([name, i]) => `| ${name} | ${i.action} | ${i.commit.slice(0, 7)} | ${i.reason} |`),
    '',
  ].join('\n');
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'plan') {
    const { values } = parseArgs({
      args: rest,
      options: { event: { type: 'string' }, sha: { type: 'string' }, 'pr-base': { type: 'string' }, full: { type: 'boolean' }, summary: { type: 'string' } },
    });
    if (!values.event) throw new Error('--event fehlt');
    if (!values.sha) throw new Error('--sha fehlt');
    const p = plan({ event: values.event, sha: values.sha, prBase: values['pr-base'] || undefined, full: values.full === true });
    if (values.summary) appendFileSync(values.summary, summary(p));
    console.log(JSON.stringify(p));
    return;
  }
  if (command === 'image-commit') {
    const { values, positionals } = parseArgs({ args: rest, options: { ref: { type: 'string' } }, allowPositionals: true });
    const map = loadMap();
    const [name] = positionals;
    if (positionals.length !== 1 || !map.images[name]) throw new Error(`image-commit <${IMAGES.join('|')}> [--ref <r>]`);
    const found = scanImageCommits(ROOT, map, resolve(ROOT, values.ref || 'HEAD'))[name];
    if (!found) throw new Error(`no commit touches the inputs of ${name}`);
    console.log(`${found.commit} ${found.time}`);
    return;
  }
  throw new Error('usage: changed-images.mjs plan --event <e> --sha <s> [--pr-base <s>] [--full] [--summary <file>] | image-commit <image> [--ref <r>]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`changed-images: ${e instanceof Error ? e.message : e}`); process.exit(1); }
}
