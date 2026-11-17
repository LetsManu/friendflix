// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Third-party runtime images in the shipped compose files are pinned by tag AND digest, and Dependabot proposes their
// updates (security audit G7). Run by `npm test` at the repo root (node:test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(import.meta.resolve(`../${p}`)), 'utf8');
/** every `image:` value of a compose file (comments dropped) */
const images = (text) => [...text.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]);
/** our own images: built locally (`friendflix-*:dev`) or from the release registry (`${FF_REGISTRY…}`) */
const own = (img) => img.startsWith('${FF_REGISTRY') || /^friendflix-[a-z]+:dev$/.test(img);
const PINNED = /^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;

for (const file of ['compose.yaml', 'compose.prod.yaml']) {
  test(`${file}: every third-party image is pinned by tag and sha256 digest`, () => {
    const third = images(read(file)).filter((i) => !own(i));
    assert.ok(third.length >= 4, `${file}: expected the database, cache and bundled media images, got ${third.join(', ')}`);
    for (const img of third) {
      assert.match(img, PINNED, `${file}: ${img} is not pinned as name:tag@sha256:<digest>`);
      assert.doesNotMatch(img, /:latest@/, `${file}: ${img} pins the moving tag "latest"`);
    }
  });
  test(`${file}: the same image name carries the same pin everywhere`, () => {
    const byName = new Map();
    for (const img of images(read(file)).filter((i) => !own(i))) {
      const name = img.split(':')[0];
      assert.equal(byName.get(name) ?? img, img, `${file}: ${name} is pinned twice differently`);
      byName.set(name, img);
    }
  });
}

test('compose.yaml and compose.prod.yaml pin the same third-party images', () => {
  const set = (f) => [...new Set(images(read(f)).filter((i) => !own(i) && !i.includes('socket-proxy')))].sort();
  assert.deepEqual(set('compose.yaml'), set('compose.prod.yaml'));
});

test('Dependabot proposes updates for the images in the compose files', () => {
  const cfg = read('.github/dependabot.yml');
  const entry = /- package-ecosystem: docker-compose\n((?:\s{4}.*\n)+)/.exec(cfg);
  assert.ok(entry, 'no docker-compose entry in .github/dependabot.yml');
  assert.match(entry[1], /^\s+directory: \/\s*(#.*)?$/m, 'the docker-compose entry must cover the repository root (compose.yaml, compose.prod.yaml)');
});
