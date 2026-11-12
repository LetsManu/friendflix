// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

// The signed cast logo URL carries its credential in the query (`sig`): the request log must not hold it (final review M7).
describe('request log: the logo signature', () => {
  let env: TestEnv;
  const logs: string[] = [];
  beforeAll(async () => {
    env = await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
  });
  afterAll(() => env.close());

  it('sig is redacted in the logged url, the rest of the line stays', async () => {
    const hash = 'a'.repeat(64);
    const r = await env.app.inject({ method: 'GET', url: `/api/livetv/logos/${hash}?exp=${Date.now() + 60_000}&sig=SECRETSIGNATURE123` });
    expect(r.statusCode).toBe(403);
    const all = logs.join('\n');
    expect(all).not.toContain('SECRETSIGNATURE123');
    expect(all).toContain(`/api/livetv/logos/${hash}?exp=`);
    expect(all).toContain('sig=[redacted]');
  });
});
