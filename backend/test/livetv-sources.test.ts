// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 15: provider sources with encrypted URLs and import options, and *Prüfen* through livetv (spec §3.4, §6.1,
 * §9.1). Provider URLs are secrets (F13): stored encrypted, answered only as `scheme://host/…`, never in logs, audit meta or errors.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt, keyFromBase64 } from '../src/crypto.js';
import { sourceSecrets } from '../src/livetv/sources.js';
import { checkSourceUrl, classifyAddress, maskUrl } from '../src/livetv/urls.js';
import type { FetchM3uAnswer, M3uEntry } from '../src/livetv/wire.js';
import { ENC_KEY, fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
const key = keyFromBase64(ENC_KEY);
const logs: string[] = [];

// a provider URL with credentials in userinfo and query (Xtream style); only the masked form may ever leave the backend
const SECRET_URL = 'https://anna:geheim@iptv.example.com/get.php?username=anna&password=geheim&type=m3u_plus';
const SECRET_EPG = 'https://anna:geheim@iptv.example.com/xmltv.php?username=anna&password=geheim';
const HINT = 'https://iptv.example.com/…';
const LEAKS = ['geheim', 'password=', 'get.php', 'xmltv.php', 'anna'];

let addr = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, s: Sess = admin) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });
const create = (b: Record<string, unknown>) => call('POST', '/api/admin/livetv/sources', { name: 'Anbieter', url: SECRET_URL, ...b });
const row = async (id: string) => (await env.pool.query('select * from livetv_sources where id = $1', [id])).rows[0];

// ---- the fake livetv: every request the backend sends lands here; nothing else (no provider host) has a route ----
const calls: Call[] = [];
let m3u: Handler;
let xmltv: Handler;
const entry = (name: string, group: string, pos: number): M3uEntry =>
  ({ key: `k${pos}`, name, group, pos, url: `https://iptv.example.com/live/anna/geheim/${pos}.ts`, kind: 'ts' });
/** the fixture list: "DE | Sport" 3, "Kinder" 2, "Nachrichten" 1 (list order) */
function answer(groups: Array<[string, number]>): FetchM3uAnswer {
  const names = ['Bergblick Sport', 'Nordlicht TV', 'Hafenkanal', 'Kinderinsel', 'Kanal Wolkenlos', 'Sternwarte 24', 'Nordlicht TV 2', 'Hafenkanal 2'];
  const entries: M3uEntry[] = [];
  for (const [g, n] of groups) for (let i = 0; i < n; i++) entries.push(entry(names[entries.length % names.length]!, g, entries.length));
  return { entries, groups: groups.map(([name, channels]) => ({ name, channels })), listed: entries.length, skipped: { vod: 0, invalid: 0, overLimit: 0, groups: 0 } };
}
const ndjson = (lines: unknown[]) => ({ raw: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', type: 'application/x-ndjson' });

beforeAll(async () => {
  env = await makeEnv({}, { logger: { stream: { write: (l: string) => { logs.push(l); } }, level: 'trace' } });
  admin = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from livetv_channels; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources; delete from audit_log');
  calls.length = 0;
  logs.length = 0;
  m3u = () => ({ json: answer([['DE | Sport', 3], ['Kinder', 2], ['Nachrichten', 1]]) });
  xmltv = () => ndjson([{ t: 'channel', id: 'nordlicht.de', names: ['Nordlicht TV'] }, { t: 'channel', id: 'hafen.de', names: ['Hafenkanal'] }, { t: 'end', programmes: 0, channels: 2 }]);
  env.ctx.fetchImpl = fakeHttp({ 'POST /v1/fetch/m3u': (...a) => m3u(...a), 'POST /v1/fetch/xmltv': (...a) => xmltv(...a) }, calls);
});

describe('stored encrypted, answered masked', () => {
  it('urls are stored encrypted and answered masked', async () => {
    const r = await create({ epgUrl: SECRET_EPG });
    expect(r.statusCode).toBe(201);
    const s = r.json();
    const stored = await row(s.id);
    expect(stored.kind).toBe('m3u');
    expect(decrypt(key, stored.url_enc)).toBe(SECRET_URL);
    expect(decrypt(key, stored.epg_url_enc)).toBe(SECRET_EPG);
    expect(stored.url_hint).toBe(HINT);
    expect(stored.epg_hint).toBe(HINT);
    expect(await sourceSecrets(env.ctx, s.id)).toEqual({ url: SECRET_URL, epgUrl: SECRET_EPG });
    const list = await call('GET', '/api/admin/livetv/sources');
    expect(list.statusCode).toBe(200);
    for (const body of [r.body, list.body]) {
      expect(body).toContain(HINT);
      expect(body).not.toContain('geheim');
      expect(body).not.toContain('password=');
    }
    expect(list.json()).toEqual([{
      id: s.id, kind: 'm3u', name: 'Anbieter', urlHint: HINT, epgHint: HINT, userAgent: null, allowLan: false, refresh: '24h', skipGroups: [],
      numbering: 'chno', numberBase: 1, logoPref: 'm3u', epgShiftMin: 0, maxStreams: null, enabled: true, position: 0, channelCount: 0, pendingGroups: 0,
      guideProvider: null, guideScope: null, servedChannels: 0, fileName: null, fileBytes: null,
      state: { lastRefreshAt: null, lastOkAt: null, lastError: null, counts: null, epg: { lastRefreshAt: null, lastOkAt: null, lastError: null, programmes: null } },
    }]);
  });

  it('edit without url keeps it', async () => {
    const id = (await create({ epgUrl: SECRET_EPG })).json().id;
    const before = await row(id);
    const r = await call('PATCH', `/api/admin/livetv/sources/${id}`, { name: 'Anbieter Zwei' });
    expect(r.statusCode).toBe(200);
    expect(r.json().name).toBe('Anbieter Zwei');
    const after = await row(id);
    expect(after.url_enc).toBe(before.url_enc);
    expect(after.epg_url_enc).toBe(before.epg_url_enc);
    // a new URL replaces it; epgUrl: null removes the EPG
    const next = 'http://iptv.example.com:8080/get.php?username=anna&password=neu';
    const r2 = await call('PATCH', `/api/admin/livetv/sources/${id}`, { url: next, epgUrl: null });
    expect(r2.json()).toMatchObject({ urlHint: 'http://iptv.example.com:8080/…', epgHint: null });
    expect(r2.body).not.toContain('neu');
    expect(await sourceSecrets(env.ctx, id)).toEqual({ url: next, epgUrl: null });
    expect((await row(id)).epg_hint).toBeNull();
  });

  it('a source answers its channel count and the unreleased groups holding its channels', async () => {
    const id = (await create({})).json().id;
    const g1 = (await env.pool.query("insert into livetv_groups(id, name, released) values (gen_random_uuid(), 'DE | Sport', false) returning id")).rows[0].id;
    const g2 = (await env.pool.query("insert into livetv_groups(id, name, released) values (gen_random_uuid(), 'Nachrichten', true) returning id")).rows[0].id;
    await env.pool.query('insert into livetv_group_map(source_id, provider_group, group_id) values ($1, $2, $3), ($1, $4, $5)', [id, 'DE | Sport', g1, 'Nachrichten', g2]);
    let n = 0;
    const ch = (name: string, group: string, missing = false) => env.pool.query(
      `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, import_group, missing_since)
       values (gen_random_uuid(), $1, $2, $3, 'ts', $4, $5, $6)`, [id, `k${++n}`, encrypt(key, `https://iptv.example.com/live/${n}.ts`), name, group, missing ? new Date() : null]);
    await ch('Bergblick Sport', 'DE | Sport');
    await ch('Nordlicht TV', 'Nachrichten');
    await ch('Hafenkanal', 'Nachrichten', true);
    const s = (await call('GET', '/api/admin/livetv/sources')).json()[0];
    expect(s).toMatchObject({ channelCount: 2, pendingGroups: 1 });
  });
});

describe('save-time validation (spec §3.4)', () => {
  it('save-time validation', async () => {
    const bad = async (b: Record<string, unknown>, status: number, json: unknown) => {
      const r = await create(b);
      expect(r.statusCode).toBe(status);
      expect(r.json()).toEqual(json);
    };
    await bad({ url: 'ftp://iptv.example.com/list.m3u' }, 400, { error: 'invalid', field: 'url' });
    await bad({ url: 'kein Link' }, 400, { error: 'invalid', field: 'url' });
    await bad({ url: 'http://backend/list' }, 400, { error: 'refused', field: 'url' });
    await bad({ url: 'http://localhost:8090/list' }, 400, { error: 'refused', field: 'url' });
    // a fixed code, not `invalid`: it is no schema failure
    await bad({ url: 'http://192.168.1.5/x' }, 400, { error: 'lan_required', field: 'url' });
    expect((await create({ url: 'http://192.168.1.5/x', allowLan: true })).statusCode).toBe(201);
    await bad({ url: 'http://127.0.0.1/', allowLan: true }, 400, { error: 'refused', field: 'url' });
    await bad({ url: 'http://169.254.169.254/latest', allowLan: true }, 400, { error: 'refused', field: 'url' });
    await bad({ url: 'http://[::ffff:127.0.0.1]/x', allowLan: true }, 400, { error: 'refused', field: 'url' });
    await bad({ url: 'http://0x7f.1/x', allowLan: true }, 400, { error: 'refused', field: 'url' });
    await bad({ epgUrl: 'http://10.0.0.8/epg.xml' }, 400, { error: 'lan_required', field: 'epgUrl' });
    await bad({ epgUrl: 'srt://iptv.example.com:9000' }, 400, { error: 'invalid', field: 'epgUrl' });
    await bad({ name: '' }, 400, { error: 'invalid', field: 'name' });
    await bad({ kind: 'manual' }, 400, { error: 'invalid', field: 'kind' }); // only a list ('m3u', the default) or a guide is created here
    await bad({ other: 1 }, 400, { error: 'invalid', field: 'body' }); // strict: no unknown keys
    expect((await call('GET', '/api/admin/livetv/sources')).json()).toHaveLength(1);
  });

  it('turning LAN off under a LAN address is refused; the own-feeds source takes no URL', async () => {
    const id = (await create({ url: 'http://192.168.1.5/x', allowLan: true })).json().id;
    expect((await call('PATCH', `/api/admin/livetv/sources/${id}`, { allowLan: false })).json()).toEqual({ error: 'lan_required', field: 'url' });
    expect((await row(id)).allow_lan).toBe(true);
    const own = (await env.pool.query("insert into livetv_sources(id, kind, name) values (gen_random_uuid(), 'manual', 'Eigene Streams') returning id")).rows[0].id;
    expect((await call('PATCH', `/api/admin/livetv/sources/${own}`, { url: 'https://iptv.example.com/x' })).json()).toEqual({ error: 'invalid', field: 'url' });
    expect((await call('PATCH', `/api/admin/livetv/sources/${own}`, { allowLan: true })).statusCode).toBe(200);
    expect((await call('PATCH', '/api/admin/livetv/sources/0c000000-0000-4000-a000-00000000ffff', { name: 'X' })).statusCode).toBe(404);
    expect((await call('PATCH', '/api/admin/livetv/sources/nope', { name: 'X' })).statusCode).toBe(404);
  });

  it('the backend classifies IP literals like livetv', () => {
    const v = JSON.parse(readFileSync(new URL('../../test-vectors/livetv-ip-classes.json', import.meta.url), 'utf8')) as { rows: Array<{ ip: string; class: string }> };
    expect(v.rows.length).toBe(64);
    for (const r of v.rows) expect([r.ip, classifyAddress(r.ip)]).toEqual([r.ip, r.class]);
  });

  it('the classification is livetv/src/netguard.ts verbatim (F18)', () => {
    const ours = readFileSync(new URL('../src/livetv/urls.ts', import.meta.url), 'utf8');
    const theirs = readFileSync(new URL('../../livetv/src/netguard.ts', import.meta.url), 'utf8');
    const copy = ours.slice(ours.indexOf('\n', ours.indexOf('// ---- copied from')) + 1, ours.indexOf('// ---- end of the copy ----'))
      .replace('own: readonly Cidr[] = []', 'own: readonly Cidr[]');
    expect(copy.length).toBeGreaterThan(2000);
    expect(theirs).toContain(copy);
  });

  it('checkSourceUrl and maskUrl', () => {
    const http = { allowLan: false, schemes: ['http:', 'https:'] as Array<'http:' | 'https:'> };
    expect(checkSourceUrl('https://iptv.example.com/list', http)).toEqual({ ok: true });
    expect(checkSourceUrl('https://iptv.example.com./list', http)).toEqual({ ok: true });
    expect(checkSourceUrl('https://192.0.2.10/list', http)).toEqual({ ok: true });
    expect(checkSourceUrl('srt://192.0.2.10:9000', http)).toEqual({ ok: false, code: 'scheme' });
    expect(checkSourceUrl('srt://192.0.2.10:9000', { ...http, schemes: ['srt:'] })).toEqual({ ok: true });
    expect(checkSourceUrl('http://postgres./x', http)).toEqual({ ok: false, code: 'host' });
    expect(checkSourceUrl('nope', http)).toEqual({ ok: false, code: 'invalid' });
    expect(checkSourceUrl('http://[fd00::1]/x', http)).toEqual({ ok: false, code: 'lan_required' });
    expect(checkSourceUrl('http://[fd00::1]/x', { ...http, allowLan: true })).toEqual({ ok: true });
    expect(checkSourceUrl('http://[fe80::1]/x', { ...http, allowLan: true })).toEqual({ ok: false, code: 'refused' });
    expect(checkSourceUrl('http://2130706433/x', { ...http, allowLan: true })).toEqual({ ok: false, code: 'refused' });
    expect(maskUrl(SECRET_URL)).toBe(HINT);
    expect(maskUrl('http://anna:geheim@192.0.2.10:8000/live/anna/geheim/1.ts#x')).toBe('http://192.0.2.10:8000/…');
    expect(maskUrl('http://[2001:db8::1]/a?b=c')).toBe('http://[2001:db8::1]/…');
    expect(maskUrl('kein Link mit geheim')).toBe('…');
  });
});

describe('own feeds and import options', () => {
  it('own feeds are called feeds', async () => {
    await env.pool.query("insert into livetv_sources(id, kind, name, position) values (gen_random_uuid(), 'manual', 'Eigene Streams', 0)");
    const id = (await create({ refresh: 'manual' })).json().id;
    const list = (await call('GET', '/api/admin/livetv/sources')).json() as Array<{ id: string; kind: string; refresh: string; urlHint: string | null }>;
    expect(list.map((s) => [s.kind, s.refresh, s.urlHint])).toEqual([['feeds', '24h', null], ['m3u', 'manual', HINT]]);
    expect(list[1]!.id).toBe(id);
    expect((await row(id)).kind).toBe('m3u');
  });

  it('import options validate and are answered', async () => {
    const field = async (b: Record<string, unknown>) => { const r = await create(b); return [r.statusCode, r.json().field]; };
    expect(await field({ epgShiftMin: 45 })).toEqual([400, 'epgShiftMin']);
    expect(await field({ epgShiftMin: 900 })).toEqual([400, 'epgShiftMin']);
    expect(await field({ epgShiftMin: -750 })).toEqual([400, 'epgShiftMin']);
    expect(await field({ numbering: 'x' })).toEqual([400, 'numbering']);
    expect(await field({ logoPref: 'svg' })).toEqual([400, 'logoPref']);
    expect(await field({ numberBase: 0 })).toEqual([400, 'numberBase']);
    expect(await field({ numberBase: 100_000 })).toEqual([400, 'numberBase']);
    expect(await field({ maxStreams: 51 })).toEqual([400, 'maxStreams']);
    expect(await field({ refresh: '1h' })).toEqual([400, 'refresh']);
    expect(await field({ skipGroups: [''] })).toEqual([400, 'skipGroups']);
    expect(await field({ skipGroups: new Array(2001).fill('x') })).toEqual([400, 'skipGroups']);
    expect(await field({ userAgent: 'Nordlicht/1.0 ä' })).toEqual([400, 'userAgent']);
    const minus = await create({ epgShiftMin: -90 });
    expect(minus.statusCode).toBe(201);
    expect(minus.json().epgShiftMin).toBe(-90);
    const s = (await create({})).json();
    expect(s).toMatchObject({ skipGroups: [], numbering: 'chno', numberBase: 1, logoPref: 'm3u', epgShiftMin: 0, maxStreams: null, refresh: '24h', enabled: true, position: 1 });
    const full = (await create({ numbering: 'order', numberBase: 100, logoPref: 'xmltv', epgShiftMin: 840, maxStreams: 2, userAgent: 'Nordlicht/1.0', skipGroups: ['Kinder', 'Kinder', 'VOD'] })).json();
    expect(full).toMatchObject({ numbering: 'order', numberBase: 100, logoPref: 'xmltv', epgShiftMin: 840, maxStreams: 2, userAgent: 'Nordlicht/1.0', skipGroups: ['Kinder', 'VOD'] });

    // a refreshed source: a changed selection or numbering marks it due (the next tick re-imports it); other fields do not
    const refreshed = async () => env.pool.query("update livetv_sources set last_refresh_at = now() - interval '1 hour', last_ok_at = now() where id = $1", [s.id]);
    const due = async () => (await row(s.id)).last_refresh_at === null;
    await refreshed();
    await call('PATCH', `/api/admin/livetv/sources/${s.id}`, { name: 'Anbieter neu', logoPref: 'xmltv', epgShiftMin: 60, skipGroups: [] });
    expect(await due()).toBe(false);
    const r = await call('PATCH', `/api/admin/livetv/sources/${s.id}`, { skipGroups: ['Kinder'] });
    expect(r.json()).toMatchObject({ skipGroups: ['Kinder'], state: { lastRefreshAt: null } });
    expect(r.json().state.lastOkAt).not.toBeNull();
    expect(await due()).toBe(true);
    for (const p of [{ numbering: 'order' }, { numberBase: 50 }]) {
      await refreshed();
      await call('PATCH', `/api/admin/livetv/sources/${s.id}`, p);
      expect(await due()).toBe(true);
    }
    // the same selection in another order is no change
    await call('PATCH', `/api/admin/livetv/sources/${s.id}`, { skipGroups: ['Kinder', 'VOD'] });
    await refreshed();
    const same = await call('PATCH', `/api/admin/livetv/sources/${s.id}`, { skipGroups: ['VOD', 'Kinder', 'VOD'] });
    expect(same.json().skipGroups).toEqual(['VOD', 'Kinder']);
    expect(await due()).toBe(false);
    // another list URL is imported again (bughunt L1); the same URL sent again is no change
    const stored = (await env.pool.query<{ url_enc: string }>('select url_enc from livetv_sources where id = $1', [s.id])).rows[0]!.url_enc;
    await call('PATCH', `/api/admin/livetv/sources/${s.id}`, { url: decrypt(env.ctx.encKey, stored) });
    expect(await due()).toBe(false);
    await call('PATCH', `/api/admin/livetv/sources/${s.id}`, { url: 'https://iptv.example.com/get.php?username=bert&password=anders&type=m3u_plus' });
    expect(await due()).toBe(true);
    expect((await call('PATCH', `/api/admin/livetv/sources/${s.id}`, { epgShiftMin: 45 })).json()).toEqual({ error: 'invalid', field: 'epgShiftMin' });
  });

  it('an empty EPG field means no EPG', async () => {
    const r = await create({ epgUrl: '' });
    expect(r.statusCode).toBe(201);
    expect(r.json().epgHint).toBeNull();
    const id = r.json().id;
    expect((await row(id)).epg_url_enc).toBeNull();
    expect((await call('PATCH', `/api/admin/livetv/sources/${id}`, { epgUrl: SECRET_EPG })).json().epgHint).toBe(HINT);
    expect((await call('PATCH', `/api/admin/livetv/sources/${id}`, { epgUrl: '  ' })).json().epgHint).toBeNull();
    expect(await sourceSecrets(env.ctx, id)).toEqual({ url: SECRET_URL, epgUrl: null });
    // the test route: '' overrides a stored EPG URL with none
    await call('PATCH', `/api/admin/livetv/sources/${id}`, { epgUrl: SECRET_EPG });
    calls.length = 0;
    const t = await call('POST', '/api/admin/livetv/sources/test', { sourceId: id, allowLan: false, epgUrl: '' });
    expect([t.statusCode, t.json().epgChannels]).toEqual([200, null]);
    expect(calls.map((c) => c.path).filter((p) => p !== '/healthz')).toEqual(['/v1/fetch/m3u']); // (a proof of key renewal may come first)
  });

  it('every write drops the cached channel sets and is audited with field names only', async () => {
    const id = (await create({ epgUrl: SECRET_EPG })).json().id;
    await call('PATCH', `/api/admin/livetv/sources/${id}`, { url: SECRET_URL, enabled: false });
    await call('DELETE', `/api/admin/livetv/sources/${id}`);
    const a = (await env.pool.query('select action, target, meta from audit_log where action like $1 order by id', ['livetv.source.%'])).rows;
    expect(a).toEqual([
      { action: 'livetv.source.create', target: id, meta: { fields: ['name', 'url', 'epgUrl', 'userAgent', 'allowLan', 'refresh', 'skipGroups', 'numbering', 'numberBase', 'logoPref', 'epgShiftMin', 'maxStreams', 'enabled'] } },
      { action: 'livetv.source.update', target: id, meta: { fields: ['url', 'enabled'] } },
      { action: 'livetv.source.delete', target: id, meta: { fields: [], channels: 0 } },
    ]);
  });
});

describe('Prüfen', () => {
  it('test lists the groups with counts', async () => {
    const want = {
      channels: 6, groups: [{ name: 'DE | Sport', channels: 3 }, { name: 'Kinder', channels: 2 }, { name: 'Nachrichten', channels: 1 }],
      samples: ['Bergblick Sport', 'Nordlicht TV', 'Hafenkanal', 'Kinderinsel', 'Kanal Wolkenlos'], epgChannels: null, epgError: null,
    };
    const r = await call('POST', '/api/admin/livetv/sources/test', { url: SECRET_URL, allowLan: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(want);
    // the stored source skips "Kinder": the test still counts every group (no skipGroups to livetv), with the stored URL and EPG
    const id = (await create({ skipGroups: ['Kinder'], epgUrl: SECRET_EPG, userAgent: 'Nordlicht/1.0' })).json().id;
    calls.length = 0;
    const r2 = await call('POST', '/api/admin/livetv/sources/test', { sourceId: id, allowLan: false });
    expect(r2.json()).toEqual({ ...want, epgChannels: 2 });
    const m = calls.find((c) => c.path === '/v1/fetch/m3u')!;
    expect(m.body).toEqual({ url: SECRET_URL, allowLan: false, userAgent: 'Nordlicht/1.0' });
    expect(calls.find((c) => c.path === '/v1/fetch/xmltv')!.body).toMatchObject({ url: SECRET_EPG, allowLan: false });
    // epgUrl: null leaves the EPG out
    calls.length = 0;
    expect((await call('POST', '/api/admin/livetv/sources/test', { sourceId: id, allowLan: false, epgUrl: null })).json().epgChannels).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(['/v1/fetch/m3u']);
  });

  it('test asks livetv, never the provider', async () => {
    m3u = () => ({ json: answer([['DE | Sport', 4], ['Nachrichten', 2]]) });
    const r = await call('POST', '/api/admin/livetv/sources/test', { url: SECRET_URL, epgUrl: SECRET_EPG, allowLan: false });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(a.channels).toBe(6);
    expect(Array.isArray(a.groups)).toBe(true);
    expect(a.groups).toHaveLength(2);
    expect(a.groups.map((g: { name: string }) => g.name)).toEqual(['DE | Sport', 'Nachrichten']);
    for (const g of a.groups) expect(Object.keys(g).sort()).toEqual(['channels', 'name']);
    expect(a.samples.length).toBeLessThanOrEqual(5);
    expect(a.epgChannels).toBe(2);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.host).toBe('livetv:8090');
    expect(calls.find((c) => c.path === '/v1/fetch/m3u')!.body).toEqual({ url: SECRET_URL, allowLan: false });
    expect(r.body).not.toContain('iptv.example.com');
  });

  it('refusals are fixed codes', async () => {
    const test = (b: Record<string, unknown>) => call('POST', '/api/admin/livetv/sources/test', { allowLan: false, ...b });
    expect((await test({})).json()).toEqual({ error: 'invalid', field: 'url' });
    expect((await test({ url: 'http://192.168.1.5/x' })).json()).toEqual({ error: 'lan_required', field: 'url' });
    expect((await test({ url: 'http://127.0.0.1/x', allowLan: true })).json()).toEqual({ error: 'refused', field: 'url' });
    expect((await test({ sourceId: '0c000000-0000-4000-a000-00000000ffff' })).statusCode).toBe(404);
    expect(calls).toEqual([]);
    // the provider (through livetv) failed: 422 with livetv's code; too_big also means too many groups or entries (Task 14)
    m3u = () => ({ status: 422, json: { error: 'too_big' } });
    const big = await test({ url: SECRET_URL });
    expect([big.statusCode, big.json()]).toEqual([422, { error: 'too_big' }]);
    m3u = () => ({ status: 422, json: { error: `unreachable ${SECRET_URL}` } }); // not a code: never passed on
    expect((await test({ url: SECRET_URL })).json()).toEqual({ error: 'livetv_error' });
    // a broken EPG keeps the list result
    m3u = () => ({ json: answer([['Nachrichten', 1]]) });
    xmltv = () => ndjson([{ t: 'channel', id: 'a', names: ['Hafenkanal'] }, { t: 'error', code: 'doctype' }]);
    expect((await test({ url: SECRET_URL, epgUrl: SECRET_EPG })).json()).toMatchObject({ channels: 1, epgChannels: null, epgError: 'doctype' });
    xmltv = () => ndjson([{ t: 'channel', id: 'a', names: ['Hafenkanal'] }]);
    expect((await test({ url: SECRET_URL, epgUrl: SECRET_EPG })).json()).toMatchObject({ epgChannels: null, epgError: 'incomplete' });
    // livetv itself not reached
    env.ctx.fetchImpl = (async () => { throw new Error(`connect ECONNREFUSED ${SECRET_URL}`); }) as typeof fetch;
    const down = await test({ url: SECRET_URL });
    expect([down.statusCode, down.json()]).toEqual([503, { error: 'livetv_unreachable' }]);
  });

  it('a malformed or empty answer from livetv is a refusal, not an error', async () => {
    const test = () => call('POST', '/api/admin/livetv/sources/test', { url: SECRET_URL, allowLan: false });
    for (const h of [
      () => ({ json: { entries: 'x' } }), () => ({ json: { entries: [], groups: [] } }), () => ({ json: null }), () => ({ status: 204 }),
      () => ({ raw: 'kein JSON', type: 'text/plain' }),
      () => ({ json: { ...answer([['Nachrichten', 1]]), groups: [null] } }), () => ({ json: { ...answer([['Nachrichten', 1]]), entries: [null] } }),
    ] as Handler[]) {
      m3u = h;
      const r = await test();
      expect([r.statusCode, r.json()]).toEqual([422, { error: 'invalid_answer' }]);
    }
    expect(logs.join('\n')).not.toContain('unhandled error');
  });

  it('a failed list cancels the EPG count', async () => {
    let epgSignal: AbortSignal | undefined;
    let epgStarted!: () => void;
    const started = new Promise<void>((r) => { epgStarted = r; });
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/fetch/xmltv') {
        epgSignal = init.signal ?? undefined;
        epgStarted();
        // livetv still downloading the provider's XMLTV: ends only when the backend goes away
        return new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      }
      await started; // the list fails while the EPG count runs
      return new Response(JSON.stringify({ error: 'denied' }), { status: 422, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const t0 = Date.now();
    const r = await call('POST', '/api/admin/livetv/sources/test', { url: SECRET_URL, epgUrl: SECRET_EPG, allowLan: false });
    expect([r.statusCode, r.json()]).toEqual([422, { error: 'denied' }]);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(epgSignal?.aborted).toBe(true);
  });

  it('one test per admin at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { await gate; return inner(input, init); }) as typeof fetch;
    const body = { url: SECRET_URL, allowLan: false };
    const first = call('POST', '/api/admin/livetv/sources/test', body);
    // the first one holds the lock until livetv answers
    await expect.poll(async () => (await env.kv.keys('ltv:srctest:')).length).toBe(1);
    const second = await call('POST', '/api/admin/livetv/sources/test', body);
    expect([second.statusCode, second.json()]).toEqual([409, { error: 'test_running' }]);
    release();
    expect((await first).statusCode).toBe(200);
    // released afterwards, also after a refusal
    expect((await call('POST', '/api/admin/livetv/sources/test', { allowLan: false })).statusCode).toBe(400);
    expect((await call('POST', '/api/admin/livetv/sources/test', body)).statusCode).toBe(200);
    expect(await env.kv.keys('ltv:srctest:')).toEqual([]);
  });
});

describe('secrets (F13)', () => {
  it('no secret in logs, audit or errors', async () => {
    const answers: string[] = [];
    const send = async (method: 'POST' | 'PATCH', url: string, payload: unknown) => { const r = await call(method, url, payload); answers.push(r.body); return r; };
    const id = (await send('POST', '/api/admin/livetv/sources', { name: 'Anbieter', url: SECRET_URL, epgUrl: SECRET_EPG })).json().id as string;
    // invalid bodies carrying the URL: every refusal names the field, never the value
    await send('POST', '/api/admin/livetv/sources', { name: '', url: SECRET_URL });
    await send('POST', '/api/admin/livetv/sources', { name: 'X', url: SECRET_URL, unknown: SECRET_URL });
    await send('POST', '/api/admin/livetv/sources', { name: 'X', url: SECRET_URL.replace('https', 'ftp') });
    await send('POST', '/api/admin/livetv/sources', { name: 'X', url: SECRET_URL.replace('iptv.example.com', '10.0.0.8') });
    await send('POST', '/api/admin/livetv/sources', { name: 'X', url: SECRET_URL, epgShiftMin: 45 });
    await send('PATCH', `/api/admin/livetv/sources/${id}`, { url: SECRET_URL.replace('iptv.example.com', '127.0.0.1') });
    await send('PATCH', `/api/admin/livetv/sources/${id}`, { url: SECRET_URL, epgShiftMin: 'x' });
    await send('POST', '/api/admin/livetv/sources/test', { url: SECRET_URL, allowLan: 'x' });
    m3u = () => ({ status: 422, json: { error: 'denied' } });
    await send('POST', '/api/admin/livetv/sources/test', { url: SECRET_URL, epgUrl: SECRET_EPG, allowLan: false });
    // a body that is not JSON
    const raw = await env.app.inject({ method: 'POST', url: '/api/admin/livetv/sources', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, payload: `{"name":"X","url":"${SECRET_URL}" kaputt` });
    expect(raw.statusCode).toBe(400);
    answers.push(raw.body);
    // a database failure on a write (its `detail` quotes the failing row, url_hint included): logged by type and code only
    await env.pool.query("alter table livetv_sources add constraint t15_fail check (name <> 'Kaputt')");
    try {
      const r = await send('POST', '/api/admin/livetv/sources', { name: 'Kaputt', url: SECRET_URL });
      expect([r.statusCode, r.json()]).toEqual([500, { error: 'internal' }]);
    } finally {
      await env.pool.query('alter table livetv_sources drop constraint t15_fail');
    }
    expect(logs.join('\n')).toContain('unhandled error');

    const sources = await call('GET', '/api/admin/livetv/sources');
    const audit = (await env.pool.query('select meta::text as meta from audit_log')).rows.map((r) => r.meta as string).join('\n');
    const errors = answers.slice(1).join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const hay of [logs.join('\n'), audit, errors]) {
      expect(hay).not.toContain('iptv.example.com');
      expect(hay).not.toContain('geheim');
    }
    // in source answers the host appears only inside the hints
    for (const body of [answers[0]!, sources.body]) {
      expect(body.replaceAll(`"${HINT}"`, '')).not.toContain('iptv.example.com');
      for (const leak of LEAKS) expect(body).not.toContain(leak);
    }
  });
});

describe('delete and access', () => {
  it('delete cascades channels and reports the count', async () => {
    const id = (await create({})).json().id;
    const other = (await create({ name: 'Zweiter' })).json().id;
    let n = 0;
    for (const [src, name] of [[id, 'Nordlicht TV'], [id, 'Hafenkanal'], [id, 'Sternwarte 24'], [other, 'Kanal Wolkenlos']] as const) {
      await env.pool.query(`insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name) values (gen_random_uuid(), $1, $2, $3, 'hls', $4)`,
        [src, `k${++n}`, encrypt(key, `https://iptv.example.com/live/${n}.m3u8`), name]);
    }
    const r = await call('DELETE', `/api/admin/livetv/sources/${id}`);
    expect([r.statusCode, r.json()]).toEqual([200, { channels: 3 }]);
    expect((await env.pool.query('select import_name from livetv_channels')).rows).toEqual([{ import_name: 'Kanal Wolkenlos' }]);
    expect((await call('DELETE', `/api/admin/livetv/sources/${id}`)).statusCode).toBe(404);
    expect((await call('GET', '/api/admin/livetv/sources')).json().map((s: { id: string }) => s.id)).toEqual([other]);
  });

  it('no session 401', async () => {
    const id = (await create({})).json().id;
    for (const [m, u, b] of [
      ['GET', '/api/admin/livetv/sources', undefined], ['POST', '/api/admin/livetv/sources', { name: 'X', url: SECRET_URL }],
      ['PATCH', `/api/admin/livetv/sources/${id}`, { name: 'X' }], ['DELETE', `/api/admin/livetv/sources/${id}`, undefined],
      ['POST', '/api/admin/livetv/sources/test', { url: SECRET_URL, allowLan: false }], ['POST', '/api/admin/livetv/sources/test', { bad: 1 }],
    ] as const) {
      const r = await env.app.inject({ method: m, url: u, remoteAddress: '192.0.2.250', ...(b === undefined ? {} : { payload: b as object }) });
      expect([m, u, r.statusCode]).toEqual([m, u, 401]);
      expect(r.body).not.toContain('iptv.example.com');
    }
    expect(calls).toEqual([]);
    expect((await row(id)).name).toBe('Anbieter');
  });

  it('non-admin 403', async () => {
    const id = (await create({})).json().id;
    await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values (gen_random_uuid(), 'sub-ben', 'ben@friend.example.com', 'Ben Muster', 'family', $1, 'Ben', $2)`, ['2'.repeat(32), encrypt(key, 'pw')]);
    const ben = await env.login({ sub: 'sub-ben', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] });
    for (const [m, u, b] of [
      ['GET', '/api/admin/livetv/sources', undefined], ['POST', '/api/admin/livetv/sources', { name: 'X', url: SECRET_URL }],
      ['PATCH', `/api/admin/livetv/sources/${id}`, { name: 'X' }], ['DELETE', `/api/admin/livetv/sources/${id}`, undefined],
      ['POST', '/api/admin/livetv/sources/test', { url: SECRET_URL, allowLan: false }],
    ] as const) {
      const r = await call(m, u, b, ben);
      expect([m, u, r.statusCode]).toEqual([m, u, 403]);
    }
    expect(calls).toEqual([]);
  });
});

describe('wire.ts', () => {
  it('M3uEntry and FetchM3uAnswer are the declarations of livetv/src/m3u.ts, field for field (F4)', () => {
    const theirs = readFileSync(new URL('../../livetv/src/m3u.ts', import.meta.url), 'utf8');
    const ours = readFileSync(new URL('../src/livetv/wire.ts', import.meta.url), 'utf8');
    const body = (src: string, from: string) => {
      const i = src.indexOf(from);
      expect(i).toBeGreaterThan(-1);
      return src.slice(src.indexOf('{', i), src.indexOf('\n}', i) + 2).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
    };
    expect(body(ours, 'interface M3uEntry')).toBe(body(theirs, 'interface M3uEntry'));
    expect(body(ours, 'interface FetchM3uAnswer')).toBe(body(theirs, 'interface M3uResult'));
  });
});
