// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for scripts/changed-images.mjs (node:test, run by `npm run test:scripts`). Git histories are built in throwaway
// repositories (tmpRepo in test-helpers/), with identity and signing passed on the command line: CI runners have no git identity, local configs sign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { tmpDir, tmpRepo } from './test-helpers/tmp-repo.mjs';
import { IMAGES, changedFiles, classify, copyGuard, docsGuard, docsReaders, imageCommits, isInput, loadMap, plan } from './changed-images.mjs';

const SCRIPT = fileURLToPath(new URL('./changed-images.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

/** two images: backend (the node group, a ! exclude, a one-segment glob, argsFrom) and web */
const MAP = {
  exclude: ['**/*.md'],
  full: ['.github/images.json', 'scripts/changed-images.mjs'],
  groups: { all: ['.dockerignore', '.github/actions/build-image/**'], node: ['package.json'] },
  images: {
    backend: { dockerfile: 'backend/Dockerfile', groups: ['all', 'node'], inputs: ['backend/**', '!backend/test/**', 'deploy/*.yaml'], argsFrom: ['version.json'], required: true, reproducible: true },
    web: { dockerfile: 'web/Dockerfile', groups: ['all', 'node'], inputs: ['web/**'], argsFrom: [], required: false, reproducible: false },
  },
};

const BASE_FILES = {
  'package.json': '{}\n',
  'version.json': '{ "version": "1.0.0" }\n',
  '.dockerignore': '.github\ndocs\n',
  'README.md': '# demo\n',
  'docs/guide.md': 'guide\n',
  'backend/Dockerfile': 'FROM scratch\n',
  'backend/src/a.ts': 'export const a = 1;\n',
  'backend/test/a.test.ts': 'test\n',
  'web/Dockerfile': 'FROM scratch\n',
  'web/src/b.ts': 'export const b = 1;\n',
};

const DOCKERIGNORE = [
  '# comment',
  '',
  '**/node_modules',
  '/backend/secret',
  '.github',
  'docs',
  'backend/test',
  'backend/gen',
  '!backend/gen/keep.ts',
  'version.json',
  'backend/Dockerfile',
].join('\n');

test('isInput: globs, ! excludes, @image, **/*.md, .dockerignore drop and re-include', () => {
  const root = tmpDir();
  writeFileSync(join(root, '.dockerignore'), DOCKERIGNORE);
  const map = {
    ...MAP,
    images: {
      ...MAP.images,
      backend: { ...MAP.images.backend, inputs: [...MAP.images.backend.inputs, '@media'] },
      media: { dockerfile: 'media/Dockerfile', groups: [], inputs: ['media/Dockerfile', 'media/NOTICE'], argsFrom: [], required: false, reproducible: false },
    },
  };
  const yes = (image, path) => assert.equal(isInput(map, image, path, root), true, `${path} should be an input of ${image}`);
  const no = (image, path) => assert.equal(isInput(map, image, path, root), false, `${path} should not be an input of ${image}`);
  // globs: ** any depth, * one segment
  yes('backend', 'backend/src/a.ts');
  yes('backend', 'backend/src/deep/er/b.ts');
  yes('backend', 'deploy/blueprint.yaml');
  no('backend', 'deploy/templates/x.yaml');
  no('backend', 'web/src/b.ts');
  // ! excludes and the global exclude
  no('backend', 'backend/test/a.test.ts');
  no('backend', 'backend/README.md');
  no('backend', 'backend/src/deep/NOTES.md');
  // @image pulls in that image's inputs only
  yes('backend', 'media/Dockerfile');
  yes('backend', 'media/NOTICE');
  no('backend', 'media/try.sh');
  no('web', 'media/Dockerfile');
  // groups
  yes('backend', 'package.json');
  yes('web', 'package.json');
  // .dockerignore drops the image's own inputs: any depth, leading /, a parent folder, a later ! re-includes
  no('backend', 'backend/node_modules/x/index.js');
  no('web', 'web/src/node_modules/y.js');
  no('backend', 'backend/secret/key');
  no('backend', 'backend/gen/out.ts');
  yes('backend', 'backend/gen/keep.ts');
  // …but never the Dockerfile, groups, full or argsFrom (.dockerignore drops them here)
  yes('backend', '.github/actions/build-image/action.yml');
  yes('web', '.github/actions/build-image/action.yml');
  yes('backend', '.dockerignore');
  yes('web', '.github/images.json');
  yes('media', 'scripts/changed-images.mjs');
  yes('backend', 'version.json');
  no('web', 'version.json');
  yes('backend', 'backend/Dockerfile');
  no('web', 'backend/Dockerfile');
  // the global exclude wins over groups and full as well
  no('backend', '.github/actions/build-image/README.md');
  assert.throws(() => isInput(map, 'nope', 'x', root), /unknown image "nope"/);
  // no .dockerignore: nothing dropped
  const bare = tmpDir();
  assert.equal(isInput(map, 'backend', 'backend/gen/out.ts', bare), true);
});

test('image commit: the newest first-parent commit touching the inputs', () => {
  const r = tmpRepo();
  const c1 = r.commit('init', BASE_FILES);
  const c2 = r.commit('web change', { 'web/src/b.ts': 'export const b = 2;\n' });
  r.commit('docs', { 'docs/guide.md': 'more\n', 'README.md': '# more\n', 'backend/NOTES.md': 'x\n' });
  r.commit('backend test only', { 'backend/test/a.test.ts': 'test 2\n' });
  const ic = imageCommits(r.root, MAP, 'HEAD');
  assert.deepEqual(Object.keys(ic), ['backend', 'web']);
  assert.equal(ic.backend.commit, c1);
  assert.equal(ic.web.commit, c2);
  assert.equal(ic.web.time, Number(r.git('show', '-s', '--format=%ct', c2)));
  // an older rev sees its own history
  assert.equal(imageCommits(r.root, MAP, c1).web.commit, c1);
  // a shared group input moves both
  const c5 = r.commit('deps', { 'package.json': '{ "x": 1 }\n' });
  assert.deepEqual(Object.values(imageCommits(r.root, MAP, 'HEAD')).map((v) => v.commit), [c5, c5]);
  // odd file names (git would quote them without -z) still match; an empty commit touches nothing
  const odd = r.commit('odd name', { 'backend/src/ü x\t"q"\nline.ts': '1\n', 'docs/z.md': 'z\n' });
  r.commit('empty');
  assert.deepEqual(Object.values(imageCommits(r.root, MAP, 'HEAD')).map((v) => v.commit), [odd, c5]);
  // nothing ever touched → throws
  const ghost = { ...MAP, images: { ...MAP.images, ghost: { ...MAP.images.web, dockerfile: 'ghost/Dockerfile', groups: [], inputs: ['ghost/**'] } } };
  assert.throws(() => imageCommits(r.root, ghost, 'HEAD'), /no commit touches the inputs of ghost/);
});

test('a merge counts as the merge commit; the side branch\'s own commits do not', () => {
  const r = tmpRepo();
  r.commit('init', BASE_FILES);
  r.branch('feature');
  const f1 = r.commit('backend on a branch', { 'backend/src/a.ts': 'export const a = 2;\n' });
  const f2 = r.commit('web on a branch', { 'web/src/b.ts': 'export const b = 2;\n' });
  r.checkout('main');
  r.commit('docs on main', { 'docs/guide.md': 'main\n' });
  const m = r.merge('feature');
  r.commit('docs after the merge', { 'docs/guide.md': 'after\n' });
  const ic = imageCommits(r.root, MAP, 'HEAD');
  assert.equal(ic.backend.commit, m);
  assert.equal(ic.web.commit, m);
  assert.notEqual(ic.backend.commit, f1);
  assert.notEqual(ic.web.commit, f2);
});

test('a rename out of backend changes the backend image commit', () => {
  const r = tmpRepo();
  const c1 = r.commit('init', BASE_FILES);
  const mv = r.mv('backend/src/a.ts', 'lib/a.ts');
  const ic = imageCommits(r.root, MAP, 'HEAD');
  assert.equal(ic.backend.commit, mv);
  assert.equal(ic.web.commit, c1);
  // and a rename into web moves web
  const into = r.mv('lib/a.ts', 'web/src/a.ts');
  assert.equal(imageCommits(r.root, MAP, 'HEAD').web.commit, into);
});

test('a revert gives a new image commit', () => {
  const r = tmpRepo();
  r.commit('init', BASE_FILES);
  const x = r.commit('backend change', { 'backend/src/a.ts': 'export const a = 2;\n' });
  r.commit('web change', { 'web/src/b.ts': 'export const b = 2;\n' });
  assert.equal(imageCommits(r.root, MAP, 'HEAD').backend.commit, x);
  const rev = r.revert(x);
  assert.notEqual(rev, x);
  assert.equal(imageCommits(r.root, MAP, 'HEAD').backend.commit, rev);
});

test('classify: docs, version.json, code; e2e and dast triggers; map change → full', () => {
  const none = new Set();
  const cls = (files, built = none) => classify(MAP, files, built);
  for (const files of [['docs/guide.md', 'README.md', 'web/src/NOTES.md'], ['docs/a.md', 'version.json'], ['version.json'], []]) {
    const c = cls(files);
    assert.deepEqual({ ...c, reason: undefined }, { tests: 'docs', e2e: false, dast: false, full: false, reason: undefined }, files.join(' '));
    assert.ok(c.reason.length > 0);
  }
  assert.notEqual(cls(['version.json']).reason, cls(['docs/a.md']).reason);
  const code = cls(['backend/src/a.ts'], new Set(['backend']));
  assert.deepEqual({ ...code, reason: undefined }, { tests: 'full', e2e: false, dast: false, full: false, reason: undefined });
  assert.ok(code.reason.length > 0);
  const pick = (c) => [c.tests, c.e2e, c.dast, c.full];
  assert.deepEqual(pick(cls(['web/src/b.ts'], new Set(['web']))), ['full', true, true, false]);
  assert.deepEqual(pick(cls(['e2e/login.spec.ts'])), ['full', true, false, false]);
  assert.deepEqual(pick(cls(['.zap/rules.tsv'])), ['full', false, true, false]);
  assert.deepEqual(pick(cls(['.github/workflows/ci.yml'])), ['full', true, true, false]);
  assert.deepEqual(pick(cls(['.github/actions/build-image/action.yml'])), ['full', true, true, false]);
  assert.deepEqual(pick(cls(['docs/a.md', 'e2e/x.ts'])), ['full', true, false, false]);
  assert.deepEqual(pick(cls(['.github/images.json'])), ['full', true, true, true]);
  assert.deepEqual(pick(cls(['docs/a.md', 'scripts/changed-images.mjs'])), ['full', true, true, true]);
  assert.match(cls(['.github/images.json']).reason, /\.github\/images\.json/);
});

test('plan (pull_request): carry when the image commits at base and head are equal, build otherwise', () => {
  const r = tmpRepo();
  const base = r.commit('init', BASE_FILES);
  r.branch('pr');
  r.commit('web change', { 'web/src/b.ts': 'export const b = 2;\n' });
  r.checkout('main');
  const head = r.merge('pr');
  const p = plan({ root: r.root, map: MAP, event: 'pull_request', sha: 'HEAD', prBase: base });
  assert.equal(p.v, 1);
  assert.equal(p.event, 'pull_request');
  assert.equal(p.mode, 'compare');
  assert.equal(p.sha, head);
  assert.deepEqual(p.base, { commit: base });
  assert.deepEqual(p.images.backend, { action: 'carry', reason: `unverändert seit ${base.slice(0, 7)}`, commit: base, time: Number(r.git('show', '-s', '--format=%ct', base)), required: true, reproducible: true, base: null });
  assert.equal(p.images.web.action, 'build');
  assert.equal(p.images.web.reason, 'Eingaben geändert');
  assert.equal(p.images.web.commit, head);
  assert.deepEqual([p.images.web.required, p.images.web.reproducible, p.images.web.base], [false, false, null]);
  assert.deepEqual([p.classes.tests, p.classes.e2e, p.classes.dast, p.classes.full], ['full', true, true, false]);
  // a docs-only PR carries everything and runs docs mode
  r.branch('docs');
  r.commit('docs', { 'docs/guide.md': 'new\n' });
  r.checkout('main');
  const docsHead = r.merge('docs');
  const d = plan({ root: r.root, map: MAP, event: 'pull_request', sha: docsHead, prBase: head });
  assert.deepEqual(Object.values(d.images).map((i) => i.action), ['carry', 'carry']);
  assert.deepEqual([d.classes.tests, d.classes.e2e, d.classes.dast], ['docs', false, false]);
  // full is not honoured on a pull request
  assert.equal(plan({ root: r.root, map: MAP, event: 'pull_request', sha: docsHead, prBase: head, full: true }).mode, 'compare');
  // without a base a pull request has nothing to compare with
  assert.throws(() => plan({ root: r.root, map: MAP, event: 'pull_request', sha: 'HEAD' }), /--pr-base fehlt/);
  assert.throws(() => plan({ root: r.root, map: MAP, event: 'pull_request', sha: 'HEAD', prBase: '' }), /--pr-base fehlt/);
  // other events only report: everything builds, classes full
  const push = plan({ root: r.root, map: MAP, event: 'push', sha: 'HEAD' });
  assert.equal(push.mode, 'report');
  assert.equal(push.base, null);
  assert.deepEqual(Object.values(push.images).map((i) => [i.action, i.reason]), [['build', 'kein Vergleich (nur Bericht)'], ['build', 'kein Vergleich (nur Bericht)']]);
  assert.equal(push.images.web.commit, head);
  assert.deepEqual([push.classes.tests, push.classes.e2e, push.classes.dast, push.classes.full], ['full', true, true, true]);
  const full = plan({ root: r.root, map: MAP, event: 'workflow_dispatch', sha: 'HEAD', full: true });
  assert.equal(full.mode, 'full');
  assert.deepEqual(Object.values(full.images).map((i) => [i.action, i.reason]), [['build', 'alles bauen'], ['build', 'alles bauen']]);
});

test('changedFiles: names both sides of a rename', () => {
  const r = tmpRepo();
  const c1 = r.commit('init', BASE_FILES);
  const c2 = r.mv('backend/src/a.ts', 'lib/a.ts');
  assert.deepEqual(changedFiles(r.root, c1, c2), ['backend/src/a.ts', 'lib/a.ts']);
});

test('real map: every image has a commit at HEAD; node-common reaches all five Node images and not mediaserver', () => {
  const map = loadMap();
  assert.deepEqual(IMAGES, ['backend', 'gateway', 'web', 'updater', 'livetv', 'mediaserver']);
  assert.deepEqual(Object.keys(map.images), IMAGES);
  const ic = imageCommits(REPO, map, 'HEAD');
  for (const image of IMAGES) {
    assert.match(ic[image].commit, /^[0-9a-f]{40}$/, image);
    assert.ok(ic[image].time > 0, image);
  }
  const node = IMAGES.filter((i) => i !== 'mediaserver');
  for (const path of map.groups['node-common']) {
    for (const image of node) assert.equal(isInput(map, image, path), true, `${path} → ${image}`);
    assert.equal(isInput(map, 'mediaserver', path), false, `${path} → mediaserver`);
  }
  // the version lives only in the backend image (Stage C): version.json changes no other image
  for (const image of IMAGES) assert.equal(isInput(map, image, 'version.json'), image === 'backend', `version.json → ${image}`);
  // backend: tests and docs are not inputs; the media server is (through its pin)
  assert.equal(isInput(map, 'backend', 'backend/test/health.test.ts'), false);
  assert.equal(isInput(map, 'backend', 'backend/README.md'), false);
  assert.equal(isInput(map, 'backend', 'mediaserver/Dockerfile'), true);
  assert.equal(isInput(map, 'backend', 'deploy/authentik/friendflix-setup.yaml'), true);
  assert.equal(isInput(map, 'mediaserver', 'mediaserver/try.sh'), false);
  assert.equal(isInput(map, 'mediaserver', 'mediaserver/README.md'), false);
  assert.equal(isInput(map, 'web', 'codenames.json'), true);
  assert.equal(isInput(map, 'gateway', 'web/src/app.html'), false);
});

test('real map: .dockerignore and .github/actions/build-image/action.yml are inputs of all six images', () => {
  const map = loadMap();
  for (const image of IMAGES) {
    for (const path of ['.dockerignore', '.github/actions/build-image/action.yml', '.github/images.json', 'scripts/changed-images.mjs']) {
      assert.equal(isInput(map, image, path), true, `${path} → ${image}`);
    }
  }
});

test('CLI: an empty --pr-base on push is absent; pull_request without one fails', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const summary = join(tmpDir(), 'summary.md');
  const push = run('plan', '--event', 'push', '--sha', 'HEAD', '--pr-base', '', '--summary', summary);
  assert.equal(push.status, 0, push.stderr);
  assert.equal(push.stdout.trim().split('\n').length, 1);
  const p = JSON.parse(push.stdout);
  assert.equal(p.mode, 'report');
  assert.deepEqual(Object.keys(p.images), IMAGES);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /\| Image \| Aktion \| Image-Commit \| Grund \|/);
  for (const image of IMAGES) assert.match(text, new RegExp(`\\| ${image} \\| build \\| [0-9a-f]{7} \\| kein Vergleich \\(nur Bericht\\) \\|`));
  for (const args of [[], ['--pr-base', '']]) {
    const pr = run('plan', '--event', 'pull_request', '--sha', 'HEAD', ...args);
    assert.equal(pr.status, 1);
    assert.match(pr.stderr, /--pr-base fehlt/);
    assert.equal(pr.stdout, '');
  }
  const ic = run('image-commit', 'backend');
  assert.equal(ic.status, 0, ic.stderr);
  assert.match(ic.stdout, /^[0-9a-f]{40} \d+\n$/);
  assert.equal(run('image-commit', 'nope').status, 1);
  assert.equal(run('frobnicate').status, 1);
});

test('COPY guard: the real Dockerfiles are covered', () => {
  assert.deepEqual(copyGuard(REPO, loadMap()), []);
});

test('COPY guard with the new map: version.json is an input and argsFrom of backend only, and the Dockerfiles still pass', () => {
  const map = loadMap();
  for (const [name, def] of Object.entries(map.images)) {
    const own = def.inputs.includes('version.json') || def.argsFrom.includes('version.json');
    assert.equal(own, name === 'backend', `version.json in ${name}`);
  }
  assert.deepEqual(map.images.backend.argsFrom, ['version.json']);
  assert.deepEqual(copyGuard(REPO, map), []);
});

test('no Dockerfile mentions GIT_SHA or BUILD_TIME; every final stage sets FF_IMAGE_COMMIT; only backend sets APP_VERSION', () => {
  for (const [name, def] of Object.entries(loadMap().images)) {
    const text = readFileSync(join(REPO, def.dockerfile), 'utf8');
    assert.doesNotMatch(text, /GIT_SHA|BUILD_TIME/, `${def.dockerfile} still names the run commit or build time`);
    const stages = text.split(/^FROM\s/m);
    const last = stages[stages.length - 1];
    assert.match(last, /^ARG FF_IMAGE_COMMIT=dev$/m, `${def.dockerfile}: final stage ARG FF_IMAGE_COMMIT=dev`);
    if (name === 'mediaserver') {
      // the trial image keeps its env as the managed media server's fixture has it: the image commit goes into its revision label
      assert.match(last, /org\.opencontainers\.image\.revision="\$\{FF_IMAGE_COMMIT\}"/, `${def.dockerfile}: revision label`);
    } else {
      assert.match(last, /^ENV FF_IMAGE_COMMIT=\$FF_IMAGE_COMMIT\b/m, `${def.dockerfile}: final stage ENV FF_IMAGE_COMMIT`);
    }
    assert.equal(/APP_VERSION|APP_CODENAME/.test(text), name === 'backend', `${def.dockerfile}: APP_VERSION only in backend`);
  }
  // web names its SvelteKit build after the image commit (kit-version.ts), in the build stage, and copies no version.json
  const web = readFileSync(join(REPO, 'web/Dockerfile'), 'utf8').split(/^FROM\s/m)[1];
  assert.match(web, /^ARG FF_IMAGE_COMMIT=dev$/m);
  assert.match(web, /^ARG SOURCE_DATE_EPOCH$/m);
  assert.match(web, /^COPY codenames\.json \.\/$/m);
  assert.doesNotMatch(web, /^(?:COPY|ADD)\b.*version\.json/m);
  const backend = readFileSync(join(REPO, 'backend/Dockerfile'), 'utf8').split(/^FROM\s/m).pop();
  assert.match(backend, /^ARG APP_VERSION=$/m);
  assert.match(backend, /^ARG APP_CODENAME=$/m);
  assert.match(backend, /^ENV FF_IMAGE_COMMIT=\$FF_IMAGE_COMMIT APP_VERSION=\$APP_VERSION APP_CODENAME=\$APP_CODENAME$/m);
});

test('COPY guard: an uncovered COPY source fails', () => {
  const map = loadMap();
  map.images.web.inputs = map.images.web.inputs.filter((p) => p !== 'codenames.json');
  const problems = copyGuard(REPO, map);
  assert.deepEqual(problems, ['web/Dockerfile: codenames.json → codenames.json is not an input']);
  // an argsFrom path that names no tracked file would never trigger a rebuild
  const args = loadMap();
  args.images.gateway.argsFrom = ['version.jsn'];
  assert.deepEqual(copyGuard(REPO, args), ['.github/images.json: gateway argsFrom version.jsn matches no tracked file']);
});

test('COPY guard: COPY forms (continuations, flags, globs, folders, --from, URLs) in a fixture repository', () => {
  const r = tmpRepo();
  r.commit('init', {
    '.dockerignore': 'img/skip\n',
    'img/Dockerfile': [
      'FROM scratch',
      '# COPY ignored/comment.txt /x',
      'COPY --chown=1:1 \\',
      '  img/a.txt img/dir /dst/',
      'COPY --from=build /out/x /y',
      'ADD https://example.com/x.deb /tmp/',
      'COPY img/skip /s',
      'COPY img/*.cfg /etc/',
    ].join('\n'),
    'img/a.txt': 'a', 'img/dir/b.txt': 'b', 'img/skip/c.txt': 'c', 'img/one.cfg': '1', 'img/Dockerfile.d': 'd',
  });
  const map = { exclude: [], full: [], groups: {}, images: { img: { dockerfile: 'img/Dockerfile', groups: [], inputs: ['img/a.txt'], argsFrom: [] } } };
  assert.deepEqual(copyGuard(r.root, map), [
    'img/Dockerfile: img/dir → img/dir/b.txt is not an input',
    'img/Dockerfile: img/*.cfg → img/one.cfg is not an input',
  ]);
  map.images.img.inputs = ['img/**'];
  assert.deepEqual(copyGuard(r.root, map), []);
  // a heredoc or variable source cannot be resolved: fail closed
  r.commit('var', { 'img/Dockerfile': 'COPY $SRC /x\nCOPY <<EOF /y\n' });
  assert.equal(copyGuard(r.root, map).length, 2);
});

test('COPY guard: a file the build action reads must be in argsFrom', () => {
  const r = tmpRepo();
  const map = { exclude: [], full: [], groups: {}, images: { img: { dockerfile: 'img/Dockerfile', groups: [], inputs: ['img/**', 'version.json', 'extra.json'], argsFrom: ['version.json'] } } };
  const action = (body) => ({ 'img/Dockerfile': 'FROM scratch\n', 'version.json': '{}', 'extra.json': '{}', 'scripts/tool.sh': '#', '.github/actions/build-image/action.yml': body });
  // reads: a run operand, a $(…) operand, a with: file value; comments and a label string do not count
  r.commit('ok', action([
    'name: build',
    '# reads extra.json in a comment only',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - run: |',
    '        # also extra.json in a comment',
    '        v=$(jq -r .version version.json)',
    '        echo "$v" # scripts/tool.sh named in a trailing comment',
    '      shell: bash',
    '    - uses: example/build@0000000000000000000000000000000000000000',
    '      with:',
    '        labels: |',
    '          org.opencontainers.image.documentation=extra.json',
    '        file: img/Dockerfile',
  ].join('\n')));
  assert.deepEqual(copyGuard(r.root, map), []);
  r.commit('reads', action([
    'runs:',
    '  steps:',
    '    - run: node scripts/tool.sh --in "./extra.json"',
    '      shell: bash',
  ].join('\n')));
  assert.deepEqual(copyGuard(r.root, map), [
    ".github/actions/build-image/action.yml: reads extra.json, which is in no image's argsFrom",
    ".github/actions/build-image/action.yml: reads scripts/tool.sh, which is in no image's argsFrom",
  ]);
  map.images.img.argsFrom = ['version.json', 'extra.json', 'scripts/tool.sh'];
  map.images.img.inputs.push('scripts/tool.sh');
  assert.deepEqual(copyGuard(r.root, map), []);
});

const ACTION = join(REPO, '.github/actions/build-image/action.yml');

/** the run: bodies (comment lines dropped) and the with: file / context values of an action, by indentation */
function actionParts(text) {
  const runs = [];
  const paths = [];
  let run = null;
  for (const raw of text.split('\n')) {
    const indent = raw.length - raw.trimStart().length;
    if (run && (raw.trim() === '' || indent > run.indent)) { if (!/^\s*#/.test(raw)) run.lines.push(raw.trim()); continue; }
    run = null;
    const m = /^(\s*)(?:-\s+)?(run|file|context):\s*(.*)$/.exec(raw);
    if (!m) continue;
    if (m[2] === 'run') { run = { indent: m[1].length, lines: [m[3].replace(/^[|>][+-]?$/, '')] }; runs.push(run); } else paths.push(`${m[2]}: ${m[3]}`);
  }
  return { runs: runs.map((r) => r.lines.join('\n').trim()), paths };
}

test('build action: its real reads are version.json and the image\'s Dockerfile (pinned: the guard sees literal paths only)', () => {
  const text = readFileSync(ACTION, 'utf8');
  const { runs, paths } = actionParts(text);
  // both builds: the whole checkout as context, the image's own Dockerfile (exempt from argsFrom: it is an input by itself)
  assert.deepEqual(paths, ['context: .', 'file: ${{ inputs.service }}/Dockerfile', 'context: .', 'file: ${{ inputs.service }}/Dockerfile']);
  assert.ok(runs.length > 0);
  const body = runs.join('\n');
  // no ${{ }} in a script (inputs come in as env) and no path built from a variable or a glob: every read is a literal path
  assert.doesNotMatch(body, /\$\{\{/);
  assert.doesNotMatch(body, /\$\{?\w+\}?\//);
  assert.doesNotMatch(body, /[\w.-]+\/[\w*.-]+/, 'a script names a repository path; add it here and to argsFrom');
  assert.deepEqual([...new Set(body.match(/[\w-]+\.(?:json|ya?ml|sh|mjs|js|ts|txt)\b/g))].sort(), ['version.json']);
  // and the guard, against the real file: every file it reads is fed to some image (version.json → argsFrom), and it sees that read
  assert.deepEqual(copyGuard(REPO, loadMap()), []);
  const bare = loadMap();
  for (const def of Object.values(bare.images)) def.argsFrom = [];
  assert.deepEqual(copyGuard(REPO, bare), [".github/actions/build-image/action.yml: reads version.json, which is in no image's argsFrom"]);
});

test('build action: commit and time are required inputs, the labels are written from them (no metadata-action, no .version)', () => {
  const text = readFileSync(ACTION, 'utf8');
  // code lines only: a comment must not satisfy (or fail) these checks
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const input of ['commit', 'time']) assert.match(code, new RegExp(`^ {2}${input}:\\n(?: {4}.*\\n)*? {4}required: true$`, 'm'), input);
  assert.doesNotMatch(code, /metadata-action/);
  assert.doesNotMatch(code, /image\.version|GIT_SHA|BUILD_TIME|GITHUB_SHA|git log/);
  for (const key of ['title', 'source', 'url', 'licenses', 'revision', 'created']) assert.match(code, new RegExp(`org\\.opencontainers\\.image\\.${key}=`), key);
  assert.match(code, /"FF_IMAGE_COMMIT=\$COMMIT"/);
  assert.match(code, /"SOURCE_DATE_EPOCH=\$TIME"/);
});

/** a stand-in for `docker buildx build`: logs the --build-arg values to $FAKE_LOG and writes an OCI tarball with one manifest */
const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
[ "$1 $2" = "buildx build" ] || { echo "fake docker: $*" >&2; exit 1; }
: > "$FAKE_LOG"; out=
while [ $# -gt 0 ]; do
  case "$1" in
    --build-arg) printf '%s\\n' "$2" >> "$FAKE_LOG"; shift ;;
    --output) out=$(sed -n 's/^type=oci,dest=\\([^,]*\\),.*/\\1/p' <<< "$2"); shift ;;
  esac
  shift
done
d=$(mktemp -d)
printf '{"manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:${'1'.repeat(64)}"}]}' > "$d/index.json"
tar -cf "$out" -C "$d" index.json
rm -rf "$d"
`;

test('reproduce-image.sh builds for the image commit (the ref\'s own script), else the ref; an old Dockerfile for the ref with GIT_SHA', () => {
  const bin = tmpDir();
  const log = join(bin, 'args.txt');
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  const r = tmpRepo();
  const map = { exclude: [], full: [], groups: {}, images: { gateway: { dockerfile: 'gateway/Dockerfile', groups: [], inputs: ['gateway/**'], argsFrom: [] } } };
  const c1 = r.commit('init', {
    '.github/images.json': JSON.stringify(map),
    'scripts/changed-images.mjs': readFileSync(SCRIPT, 'utf8'),
    'version.json': '{ "version": "1.0.0", "codename": "Test" }\n',
    'gateway/Dockerfile': 'FROM scratch\nARG FF_IMAGE_COMMIT=dev\nENV FF_IMAGE_COMMIT=$FF_IMAGE_COMMIT\n',
  });
  const c2 = r.commit('not an input', { 'other.txt': 'x\n' });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUILDER: 'fake', FAKE_LOG: log };
  const args = (ref) => {
    const out = spawnSync('bash', [join(REPO, 'scripts/reproduce-image.sh'), 'gateway', '--ref', ref], { cwd: r.root, encoding: 'utf8', env });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `sha256:${'1'.repeat(64)}\n`);
    return readFileSync(log, 'utf8').trim().split('\n');
  };
  const time = (c) => r.git('log', '-1', '--format=%ct', c);
  // c2 changed no input of gateway: built for c1 and c1's time, as CI builds it
  assert.deepEqual(args(c2), [`SOURCE_DATE_EPOCH=${time(c1)}`, `FF_IMAGE_COMMIT=${c1}`]);
  // a ref without scripts/changed-images.mjs: the ref itself
  rmSync(join(r.root, 'scripts'), { recursive: true });
  const c3 = r.commit('no script');
  assert.deepEqual(args(c3), [`SOURCE_DATE_EPOCH=${time(c3)}`, `FF_IMAGE_COMMIT=${c3}`]);
  // a Dockerfile from before FF_IMAGE_COMMIT: GIT_SHA = the ref, BUILD_TIME = its time, the version from version.json
  const c4 = r.commit('old', { 'gateway/Dockerfile': 'FROM scratch\nARG GIT_SHA=dev\nARG BUILD_TIME=\nARG APP_VERSION=\nARG APP_CODENAME=\n' });
  const iso = new Date(Number(time(c4)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.deepEqual(args(c4), [`SOURCE_DATE_EPOCH=${time(c4)}`, `GIT_SHA=${c4}`, `BUILD_TIME=${iso}`, 'APP_VERSION=1.0.0', 'APP_CODENAME=Test']);
});

test('reproduce-image.sh --buildkit-image reads the action\'s pin', () => {
  const pin = /^ {2}buildkit-image:\n(?: {4}.*\n)*? {4}default: *(\S+)/m.exec(readFileSync(ACTION, 'utf8'))?.[1];
  assert.match(pin ?? '', /^moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  const out = spawnSync('bash', [join(REPO, 'scripts/reproduce-image.sh'), '--buildkit-image'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, `${pin}\n`);
  assert.doesNotMatch(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8'), /BUILDKIT_IMAGE:/, 'the pin lives only in the action');
});

test('reproduce-image.sh --buildkit-image falls back to ci.yml on an old ref', () => {
  const r = tmpRepo();
  const run = (...args) => spawnSync('bash', [join(REPO, 'scripts/reproduce-image.sh'), '--buildkit-image', ...args], { cwd: r.root, encoding: 'utf8' });
  const none = r.commit('none', { 'README.md': 'x\n' });
  const old = r.commit('old', {
    '.github/workflows/ci.yml': [
      'env:',
      '  # pinned by digest',
      `  BUILDKIT_IMAGE: moby/buildkit:v0.1.0@sha256:${'1'.repeat(64)} # comment`,
      'jobs: {}',
      '',
    ].join('\n'),
  });
  assert.deepEqual([run().status, run().stdout], [0, `moby/buildkit:v0.1.0@sha256:${'1'.repeat(64)}\n`]);
  r.commit('new', {
    '.github/actions/build-image/action.yml': [
      'inputs:',
      '  service: { required: true }',
      '  # pinned by digest',
      '  buildkit-image:',
      '    description: BuildKit',
      `    default: moby/buildkit:v0.2.0@sha256:${'2'.repeat(64)}`,
      '  other:',
      '    default: nope',
      '',
    ].join('\n'),
  });
  assert.equal(run().stdout, `moby/buildkit:v0.2.0@sha256:${'2'.repeat(64)}\n`);
  assert.equal(run('--ref', old).stdout, `moby/buildkit:v0.1.0@sha256:${'1'.repeat(64)}\n`);
  const missing = run('--ref', none);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /BuildKit pin not found/);
});

test('docs-reader guard: every docs-reading test is in test:docs', () => {
  assert.deepEqual(docsGuard(REPO), []);
  const readers = docsReaders(REPO);
  assert.ok(readers.includes('updater/test/livetv.test.ts'), 'the readers are found');
  assert.ok(readers.includes('backend/test/syscheck.test.ts'));
  assert.ok(!readers.some((f) => f.endsWith('.mjs')));
});

test('docs-reader guard: a reader missing from test:docs fails; literals decide, comments do not', () => {
  const r = tmpRepo();
  r.commit('init', {
    'backend/package.json': JSON.stringify({ scripts: { 'test:docs': 'vitest run test/a.test.ts' } }),
    'backend/test/a.test.ts': "it('x', () => read('docs/setup.md'));\n",
    'backend/test/b.test.ts': "it('x', () => expect(link).toBe(`https://example.com/operations.md`));\n",
    'backend/test/c.test.ts': "// see docs/setup.md and README.md\nit('x', () => expect(1).toBe(1));\n",
    'backend/test/d.test.ts': "const re = /docs/; it('x', () => expect('mydocs').toBe('mydocs'));\n",
  });
  assert.deepEqual(docsReaders(r.root), ['backend/test/a.test.ts', 'backend/test/b.test.ts']);
  assert.deepEqual(docsGuard(r.root), ['backend/package.json: test:docs does not run test/b.test.ts']);
});

test('docs/operations.md lists docker (x) for every required image and reproducible (x) for every required reproducible one', () => {
  const text = readFileSync(join(REPO, 'docs/operations.md'), 'utf8');
  for (const [name, def] of Object.entries(loadMap().images)) {
    if (def.required) assert.ok(text.includes(`\`docker (${name})\``), `docker (${name})`);
    if (def.required && def.reproducible) assert.ok(text.includes(`\`reproducible (${name})\``), `reproducible (${name})`);
  }
});
