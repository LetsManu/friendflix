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

test('the token locations /media/c/ (cast), /media/l/ (Live TV) and /media/r/ (recordings) write neither access nor error log', () => {
  for (const prefix of ['/media/c/', '/media/l/', '/media/r/']) {
    const b = block(prefix);
    assert.ok(b, `location ${prefix} is missing`);
    assert.ok(b.includes('access_log off;'), `${prefix}: access_log off`);
    assert.ok(b.includes('error_log /dev/null;'), `${prefix}: error_log /dev/null`);
  }
});

test('/media/l/ and /media/r/ proxy exactly like /media/c/ (the gateway, unbuffered, with Range and the forwarding headers)', () => {
  assert.deepEqual(block('/media/l/'), block('/media/c/'));
  assert.deepEqual(block('/media/r/'), block('/media/c/'));
});

test('Plan B keeps the token locations: its setup notes name /media/l/ and /media/r/ (it has no token location of its own)', () => {
  const planB = readFileSync(fileURLToPath(import.meta.resolve('../deploy/npm/plan-b-auth-request.conf')), 'utf8');
  for (const prefix of ['/media/l/', '/media/r/']) assert.match(planB, new RegExp(`keep[^\\n]*\\n?[^\\n]*${prefix.replaceAll('/', '\\/')}`, 'i'), prefix);
});

test('the operator docs keep /media/l/ and /media/r/ in Plan B, and the bug report warns about their addresses (N6)', () => {
  const ops = readFileSync(fileURLToPath(import.meta.resolve('../docs/operations.md')), 'utf8');
  const planB = ops.slice(ops.indexOf('## Plan B'), ops.indexOf('**Sicherheitsmerkmale', ops.indexOf('## Plan B')));
  assert.match(planB, /`location \/media\/l\/`[^\n]*`location \/media\/r\/`[^\n]*\*\*bleiben stehen\*\*/);
  // the gateway serves both tokens under Plan B too: stopping it is only for installations without Live TV
  assert.doesNotMatch(planB, /Gateway-Container kann gestoppt werden/);
  const bug = readFileSync(fileURLToPath(import.meta.resolve('../.github/ISSUE_TEMPLATE/bug_report.yml')), 'utf8');
  for (const p of ['/media/c/', '/media/l/', '/media/r/']) assert.ok(bug.includes(`\`${p}…\``), p);
});
