// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEW_DAYS } from '../src/fresh.js';
import { makeEnv, type TestEnv } from './helpers.js';
import { PlexFake } from './plexfake.js';

/**
 * "Neue Serien" / "Neue Filme" are GET /api/library/items?types=Series|Movie&sort=DateCreated&desc=true: every item carries `dateCreated`
 * (the client draws "Neu seit N Tagen" and keeps what is within NEW_DAYS = 14 days of it), the type filter is the existing `types`,
 * newest first. No new parameter is needed; these tests pin that for Jellyfin and Plex.
 */
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const hex = (n: number) => n.toString(16).padStart(32, '0');
const LIB = [
  { Id: hex(1), Name: 'Alte Serie', Type: 'Series', DateCreated: ago(40) },
  { Id: hex(2), Name: 'Neue Serie', Type: 'Series', DateCreated: ago(2) },
  { Id: hex(3), Name: 'Neuer Film', Type: 'Movie', DateCreated: ago(5) },
  { Id: hex(4), Name: 'Alter Film', Type: 'Movie', DateCreated: ago(200) },
  { Id: hex(5), Name: 'Film vor 13 Tagen', Type: 'Movie', DateCreated: ago(13) },
];

describe('new titles on Jellyfin', () => {
  let env: TestEnv;
  let s: { cookies: Record<string, string>; csrf: string };
  beforeAll(async () => {
    env = await makeEnv({
      'GET /Items': (u) => {
        const types = (u.searchParams.get('includeItemTypes') ?? '').split(',');
        const desc = u.searchParams.get('sortOrder') === 'Descending';
        const list = LIB.filter((i) => types.includes(i.Type)).sort((a, b) => (desc ? -1 : 1) * a.DateCreated.localeCompare(b.DateCreated));
        return { json: { Items: list.slice(0, Number(u.searchParams.get('limit') ?? 60)), TotalRecordCount: list.length } };
      },
    });
    s = await env.login();
  });
  afterAll(() => env.close());
  const list = async (q: string) => (await env.app.inject({ url: `/api/library/items?${q}`, cookies: s.cookies })).json().items as Array<{ id: string; type: string; dateCreated?: string }>;

  it('Neue Serien: series only, newest first, dateCreated on every item', async () => {
    const items = await list('types=Series&sort=DateCreated&desc=true&limit=30');
    expect(items.map((i) => i.id)).toEqual([hex(2), hex(1)]);
    expect(items.every((i) => typeof i.dateCreated === 'string')).toBe(true);
    const call = env.jfCalls.filter((c) => c.path === '/Items').at(-1)!;
    expect(new URLSearchParams(call.search).get('fields')).toContain('DateCreated'); // asked from the server
  });

  it('Neue Filme: movies only; the 14-day window is a plain filter on dateCreated', async () => {
    const items = await list('types=Movie&sort=DateCreated&desc=true&limit=30');
    expect(items.map((i) => i.id)).toEqual([hex(3), hex(5), hex(4)]);
    const within = items.filter((i) => Date.now() - Date.parse(i.dateCreated!) <= NEW_DAYS * DAY);
    expect(within.map((i) => i.id)).toEqual([hex(3), hex(5)]);
  });
});

describe('new titles on Plex', () => {
  let env: TestEnv;
  let s: { cookies: Record<string, string>; csrf: string };
  const fake = new PlexFake();
  beforeAll(async () => {
    fake.addMovie({ title: 'Plex neu' });
    env = await makeEnv({}, { server: 'plex', plexFake: fake });
    s = await env.login();
  });
  afterAll(() => env.close());

  it('items carry dateCreated and sort newest first by DateCreated, types filter as on Jellyfin', async () => {
    const r = await env.app.inject({ url: '/api/library/items?types=Movie&sort=DateCreated&desc=true&limit=30', cookies: s.cookies });
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<{ type: string; dateCreated?: string }>;
    expect(items.length).toBeGreaterThan(1);
    expect(items.every((i) => i.type === 'Movie' && !Number.isNaN(Date.parse(i.dateCreated ?? '')))).toBe(true);
    const t = items.map((i) => Date.parse(i.dateCreated!));
    expect(t).toEqual([...t].sort((a, b) => b - a));
    const series = (await env.app.inject({ url: '/api/library/items?types=Series&sort=DateCreated&desc=true', cookies: s.cookies })).json().items as Array<{ type: string; dateCreated?: string }>;
    expect(series.length).toBeGreaterThan(0);
    expect(series.every((i) => i.type === 'Series' && typeof i.dateCreated === 'string')).toBe(true);
  });
});
