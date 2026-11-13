// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The shipped reverse proxy config (deploy/npm/portal.advanced.conf) keeps every token-in-path location out of nginx's logs
// (node:test, run by `npm test` at the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const conf = readFileSync(fileURLToPath(import.meta.resolve('../deploy/npm/portal.advanced.conf')), 'utf8');

/** the directives of `location <prefix> { … }` (one level of braces, comments dropped), or null when it is missing */
function block(prefix) {
  const re = new RegExp(`^location ${prefix.replaceAll('/', '\\/')} \\{\\n([^}]*)\\n\\}`, 'm');
  const m = re.exec(conf);
  if (!m) return null;
  return m[1].split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}

test('the token locations /media/c/ (cast) and /media/l/ (Live TV) write neither access nor error log', () => {
  for (const prefix of ['/media/c/', '/media/l/']) {
    const b = block(prefix);
    assert.ok(b, `location ${prefix} is missing`);
    assert.ok(b.includes('access_log off;'), `${prefix}: access_log off`);
    assert.ok(b.includes('error_log /dev/null;'), `${prefix}: error_log /dev/null`);
  }
});

test('/media/l/ proxies exactly like /media/c/ (the gateway, unbuffered, with Range and the forwarding headers)', () => {
  assert.deepEqual(block('/media/l/'), block('/media/c/'));
});
