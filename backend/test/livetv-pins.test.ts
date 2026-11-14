// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV extra guides, Stage 3 (docs/superpowers/plans/2026-11-14-livetv-extra-guides.md Task 7): hand pins
 * (`PUT /api/admin/livetv/channels/:id/epg`) and the picker's search over one guide's XMLTV channels (`GET /api/admin/livetv/epg/channels`).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { matchIds, refreshEpg } from '../src/livetv/epg.js';
import { refreshRunning } from '../src/livetv/refresh.js';
import { ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
const key = keyFromBase64(ENC_KEY);
const GUIDE_URL = 'https://iptv.example.com/guide/international.xml';
const LIST_EPG = 'https://iptv.example.com/xmltv.php?username=anna&password=geheim';
const HINT = 'https://iptv.example.com/…';

// ---- the fake livetv: XMLTV guides by URL, filtered like livetv does (channels, time window) ----
type Guide = { channels: Array<{ id: string; names: string[] }>; progs: Array<{ ch: string; start: number; end: number; title: string }> };
const guides = new Map<string, Guide>();
const calls: Call[] = [];
const xmltvCalls = () => calls.filter((c) => c.path === '/v1/fetch/xmltv');
function xmltvAnswer(body: { url: string; channels?: string[]; from: number; to: number }) {
  const g = guides.get(body.url);
  if (!g) return { status: 400, json: { error: 'invalid', field: 'url' } };
  const want = (id: string) => !body.channels || body.channels.includes(id);
  const lines: unknown[] = [];
  for (const c of g.channels) if (want(c.id)) lines.push({ t: 'channel', ...c });
  let programmes = 0;
  for (const p of g.progs) {
    if (!want(p.ch) || p.end < body.from || p.start > body.to) continue;
    lines.push({ t: 'prog', ...p });
    programmes++;
  }
  lines.push({ t: 'end', programmes, channels: lines.length - programmes });
  return { raw: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', type: 'application/x-ndjson' };
}
const now = Date.now();
const guide = (chs: Array<[string, string]>): Guide => ({
  channels: chs.map(([id, name]) => ({ id, names: [name] })),
  progs: chs.map(([id, name]) => ({ ch: id, start: now - 30 * 60_000, end: now + 30 * 60_000, title: `Jetzt auf ${name}` })),
});

let addr = 0;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, s: Sess = admin) =>
  env.app.inject({
    method, url, cookies: s.cookies, remoteAddress: `192.0.2.${++addr % 200 + 1}`,
    headers: { 'x-csrf-token': s.csrf, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
const pin = (id: string, body: unknown, s?: Sess) => call('PUT', `/api/admin/livetv/channels/${id}/epg`, body, s);
const search = (source: string, q?: string, s?: Sess) =>
  call('GET', `/api/admin/livetv/epg/channels?source=${source}${q === undefined ? '' : `&q=${encodeURIComponent(q)}`}`, undefined, s);
const chan = async (id: string) => (await env.pool.query('select * from livetv_channels where id = $1', [id])).rows[0];
const view = async (id: string) => (await call('GET', `/api/admin/livetv/channels/${id}`)).json();
const src = async (id: string) => (await env.pool.query('select * from livetv_sources where id = $1', [id])).rows[0];

async function addList(name: string, o: { epg?: string } = {}): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_sources(id, kind, name, url_enc, url_hint, epg_url_enc, epg_hint, last_refresh_at)
     values ($1, 'm3u', $2, $3, $4, $5, $6, now())`,
    [id, name, encrypt(key, 'https://iptv.example.com/get.php?u=anna&p=geheim'), HINT, o.epg ? encrypt(key, o.epg) : null, o.epg ? HINT : null]);
  return id;
}
async function addFeeds(): Promise<string> {
  const id = randomUUID();
  await env.pool.query("insert into livetv_sources(id, kind, name, position) values ($1, 'manual', 'Eigene Streams', 50)", [id]);
  return id;
}
async function addChannel(sourceId: string, name: string): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name) values ($1, $2, $3, $4, 'ts', $5)`,
    [id, sourceId, `k-${id}`, encrypt(key, 'https://iptv.example.com/live/1.ts'), name]);
  return id;
}
async function createGuide(name = 'Sternwarte Guide', url = GUIDE_URL): Promise<string> {
  const res = await call('POST', '/api/admin/livetv/sources', { kind: 'guide', name, epgUrl: url, guideScope: null });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
/** the background import a pin starts: waits for its single flight to end */
async function settle(sourceId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (!(await refreshRunning(env.ctx, sourceId))) return;
  }
  throw new Error('import still running');
}

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query(`delete from livetv_programmes; delete from livetv_programmes_stage; delete from livetv_epg_channels; delete from livetv_channels;
    delete from livetv_group_map; delete from livetv_groups; delete from livetv_logos; delete from livetv_sources; delete from audit_log`);
  for (const k of await env.kv.keys('ltv')) await env.kv.del(k);
  calls.length = 0;
  guides.clear();
  env.ctx.fetchImpl = fakeHttp({
    'GET /healthz': () => ({ json: { ok: true, api: 1, version: '1.0.0', bootId: '0123456789abcdef' } }),
    'POST /v1/fetch/m3u': () => ({ json: { entries: [], groups: [], listed: 0, skipped: { vod: 0, invalid: 0, overLimit: 0, groups: 0 } } }),
    'POST /v1/fetch/xmltv': (_u, _i, body) => xmltvAnswer(body),
    'POST /v1/fetch/logo': () => ({ status: 404, json: { error: 'not_found' } }),
  }, calls);
  await detectLivetv(env.ctx, 0);
  calls.length = 0;
});

describe('hand pins (Task 7)', () => {
  it('a pin sets manual, beats the automatic match, and now/next comes from the pinned guide', async () => {
    const list = await addList('Nordlicht Paket');
    const ch = await addChannel(list, 'Hafenkanal Plus'); // no automatic match anywhere
    const g = await createGuide();
    guides.set(GUIDE_URL, guide([['sw.int', 'Sternwarte International'], ['hk.de', 'Hafenkanal']]));
    expect(await refreshEpg(env.ctx, await src(g))).toEqual({ channels: 2, programmes: 0 }); // no channel could use it: nothing downloaded
    calls.length = 0;

    const r = await pin(ch, { sourceId: g, xmlId: 'hk.de' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toMatchObject({
      id: ch, epg: true, epgMatch: 'manual', epgPin: { sourceId: g, sourceName: 'Sternwarte Guide', xmlId: 'hk.de', name: 'Hafenkanal', guideDisabled: false },
    });
    expect(await chan(ch)).toMatchObject({ epg_match: 'manual', epg_source_id: g, epg_channel_id: 'hk.de' });
    // the guide had no programme of it (its filter did not hold it): its EPG is imported at once, the filter now holds the pin
    await settle(g);
    expect(xmltvCalls().at(-1)!.body).toMatchObject({ channels: ['hk.de'] });
    expect((await view(ch)).now).toMatchObject({ title: 'Jetzt auf Hafenkanal' });
    // the automatic pass never touches it, also when another channel could match
    await matchIds(env.pool);
    expect(await chan(ch)).toMatchObject({ epg_match: 'manual', epg_source_id: g, epg_channel_id: 'hk.de' });
    // audited like the other channel edits: field and mode, never the XMLTV id
    const a = (await env.pool.query("select action, target, meta from audit_log where action = 'livetv.channel.update'")).rows;
    expect(a).toEqual([{ action: 'livetv.channel.update', target: ch, meta: { fields: ['epg'], epg: 'manual' } }]);
    // a pin to an XMLTV channel with programmes already starts no import
    calls.length = 0;
    expect((await pin(ch, { sourceId: g, xmlId: 'hk.de' })).statusCode).toBe(200);
    await settle(g);
    expect(xmltvCalls()).toHaveLength(0);
  });

  it('a pin beats a list match; a list with a guide is a pin target too', async () => {
    const list = await addList('Nordlicht Paket', { epg: LIST_EPG });
    const ch = await addChannel(list, 'Nordlicht TV');
    const g = await createGuide();
    guides.set(LIST_EPG, guide([['nordlicht.de', 'Nordlicht TV'], ['wetter.de', 'Wetterkanal Küste']]));
    guides.set(GUIDE_URL, guide([['nordlicht.int', 'Nordlicht International']]));
    await refreshEpg(env.ctx, await src(list));
    await refreshEpg(env.ctx, await src(g));
    expect(await chan(ch)).toMatchObject({ epg_match: 'auto', epg_source_id: list, epg_channel_id: 'nordlicht.de' });

    expect((await pin(ch, { sourceId: g, xmlId: 'nordlicht.int' })).json()).toMatchObject({ epgMatch: 'manual', epgPin: { sourceId: g, xmlId: 'nordlicht.int' } });
    await settle(g);
    expect((await view(ch)).now).toMatchObject({ title: 'Jetzt auf Nordlicht International' });
    // another of the list's own XMLTV channels
    const r = await pin(ch, { sourceId: list, xmlId: 'wetter.de' });
    expect(r.json()).toMatchObject({ epgPin: { sourceId: list, sourceName: 'Nordlicht Paket', xmlId: 'wetter.de', name: 'Wetterkanal Küste', guideDisabled: false } });
    await settle(list);
    expect((await view(ch)).now).toMatchObject({ title: 'Jetzt auf Wetterkanal Küste' });

    // null: automatic again, matched at once (the list's own guide); the list's last import held only the pin, so it is imported again
    const back = await pin(ch, null);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ epg: true, epgMatch: 'auto', epgPin: null });
    expect(await chan(ch)).toMatchObject({ epg_match: 'auto', epg_source_id: list, epg_channel_id: 'nordlicht.de' });
    await settle(list);
    expect((await view(ch)).now).toMatchObject({ title: 'Jetzt auf Nordlicht TV' });
  });

  it('{ none: true } = no programme; null re-matches at once', async () => {
    const list = await addList('Nordlicht Paket', { epg: LIST_EPG });
    const ch = await addChannel(list, 'Nordlicht TV');
    guides.set(LIST_EPG, guide([['nordlicht.de', 'Nordlicht TV']]));
    await refreshEpg(env.ctx, await src(list));
    const none = await pin(ch, { none: true });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toMatchObject({ epg: false, epgMatch: 'none', epgPin: null, now: null });
    expect(await chan(ch)).toMatchObject({ epg_match: 'none', epg_source_id: null, epg_channel_id: null, epg_logo_hash: null });
    await matchIds(env.pool);
    expect(await chan(ch)).toMatchObject({ epg_match: 'none', epg_source_id: null });
    expect((await pin(ch, null)).json()).toMatchObject({ epg: true, epgMatch: 'auto', now: { title: 'Jetzt auf Nordlicht TV' } });
  });

  it('refuses an unfit source, an unknown XMLTV channel and a malformed body (400); an unknown channel is 404', async () => {
    const plain = await addList('Hafen Paket'); // a list without a guide
    const feeds = await addFeeds();
    const ch = await addChannel(plain, 'Hafenkanal');
    const g = await createGuide();
    const off = await createGuide('Aus Guide', 'https://iptv.example.com/guide/aus.xml');
    guides.set(GUIDE_URL, guide([['hk.de', 'Hafenkanal']]));
    guides.set('https://iptv.example.com/guide/aus.xml', guide([['hk.at', 'Hafenkanal AT']]));
    await refreshEpg(env.ctx, await src(g));
    await refreshEpg(env.ctx, await src(off));
    expect((await call('PATCH', `/api/admin/livetv/sources/${off}`, { enabled: false })).statusCode).toBe(200);

    const bad = async (body: unknown, field: string) => {
      const r = await pin(ch, body);
      expect([r.statusCode, r.json()]).toEqual([400, { error: 'invalid', field }]);
    };
    await bad({ sourceId: randomUUID(), xmlId: 'hk.de' }, 'sourceId');
    await bad({ sourceId: plain, xmlId: 'hk.de' }, 'sourceId');
    await bad({ sourceId: feeds, xmlId: 'hk.de' }, 'sourceId');
    await bad({ sourceId: off, xmlId: 'hk.at' }, 'sourceId'); // a disabled guide takes no new pin
    await bad({ sourceId: g, xmlId: 'nope' }, 'xmlId');
    await bad({ sourceId: 'x', xmlId: 'hk.de' }, 'sourceId');
    await bad({ sourceId: g }, 'xmlId');
    await bad({ sourceId: g, xmlId: 'hk.de', extra: 1 }, 'body');
    await bad({ none: false }, 'none');
    await bad([], 'body');
    expect(await chan(ch)).toMatchObject({ epg_match: 'auto', epg_channel_id: 'hk.de' }); // the automatic match, untouched
    expect((await pin(randomUUID(), { none: true })).statusCode).toBe(404);
    expect((await pin('nope', { none: true })).statusCode).toBe(404);
    expect((await env.pool.query("select 1 from audit_log where action = 'livetv.channel.update'")).rowCount).toBe(0);
  });

  it('a pin to a guide that is then switched off stays, says guideDisabled, and serves no programme', async () => {
    const list = await addList('Nordlicht Paket');
    const ch = await addChannel(list, 'Hafenkanal Plus');
    const g = await createGuide();
    guides.set(GUIDE_URL, guide([['hk.de', 'Hafenkanal']]));
    await refreshEpg(env.ctx, await src(g));
    await pin(ch, { sourceId: g, xmlId: 'hk.de' });
    await settle(g);
    expect((await view(ch)).now).toMatchObject({ title: 'Jetzt auf Hafenkanal' });

    expect((await call('PATCH', `/api/admin/livetv/sources/${g}`, { enabled: false })).statusCode).toBe(200);
    expect(await chan(ch)).toMatchObject({ epg_match: 'manual', epg_source_id: g, epg_channel_id: 'hk.de' });
    expect(await view(ch)).toMatchObject({ epgMatch: 'manual', now: null, epgPin: { sourceId: g, sourceName: 'Sternwarte Guide', xmlId: 'hk.de', guideDisabled: true } });
    // the list shows the same
    const row = (await call('GET', '/api/admin/livetv/channels')).json().channels.find((c: { id: string }) => c.id === ch);
    expect(row.epgPin).toMatchObject({ guideDisabled: true });
    // switched on again: the programme is back
    await call('PATCH', `/api/admin/livetv/sources/${g}`, { enabled: true });
    expect(await view(ch)).toMatchObject({ epgPin: { guideDisabled: false }, now: { title: 'Jetzt auf Hafenkanal' } });
  });

  it('the search: at most 50 by name, case-insensitive contains, normName as fallback; enabled guides and lists with a guide only', async () => {
    const list = await addList('Nordlicht Paket', { epg: LIST_EPG });
    const plain = await addList('Hafen Paket');
    const g = await createGuide();
    const chs: Array<[string, string]> = Array.from({ length: 60 }, (_, i) => [`k${i + 1}.int`, `Kanal ${String(i + 1).padStart(2, '0')}`]);
    guides.set(GUIDE_URL, guide([...chs, ['nl.hd', 'Nordlicht HD'], ['sw.int', 'Sternwarte 24']]));
    guides.set(LIST_EPG, guide([['nordlicht.de', 'Nordlicht TV']]));
    await refreshEpg(env.ctx, await src(g));
    await refreshEpg(env.ctx, await src(list));

    const all = await search(g, 'KANAL');
    expect(all.statusCode).toBe(200);
    expect(all.headers['cache-control']).toBe('no-store');
    expect(all.json().channels).toHaveLength(50);
    expect(all.json().more).toBe(true);
    expect(all.json().channels[0]).toEqual({ xmlId: 'k1.int', names: ['Kanal 01'] });
    expect(all.json().channels[49]).toEqual({ xmlId: 'k50.int', names: ['Kanal 50'] });
    expect((await search(g, 'stern')).json()).toEqual({ channels: [{ xmlId: 'sw.int', names: ['Sternwarte 24'] }], more: false });
    // by id as well
    expect((await search(g, 'NL.HD')).json().channels).toEqual([{ xmlId: 'nl.hd', names: ['Nordlicht HD'] }]);
    // no contains hit: normName ("Nordlicht-HD" -> "nordlicht")
    expect((await search(g, 'Nordlicht-HD')).json().channels).toEqual([{ xmlId: 'nl.hd', names: ['Nordlicht HD'] }]);
    // like wildcards are text
    expect((await search(g, '%')).json().channels).toEqual([]);
    // no q: the first 50 by name
    expect((await search(g)).json()).toMatchObject({ more: true });
    expect((await search(g)).json().channels).toHaveLength(50);
    expect((await search(list, 'nord')).json().channels).toEqual([{ xmlId: 'nordlicht.de', names: ['Nordlicht TV'] }]);

    const refused = async (source: string) => expect((await search(source, 'x')).json()).toEqual({ error: 'invalid', field: 'source' });
    await refused(plain);
    await refused(randomUUID());
    await refused('nope');
    await call('PATCH', `/api/admin/livetv/sources/${g}`, { enabled: false });
    await refused(g);
    expect((await call('GET', `/api/admin/livetv/epg/channels?source=${list}&q=${'x'.repeat(101)}`)).json()).toEqual({ error: 'invalid', field: 'q' });
  });

  it('admin only', async () => {
    const list = await addList('Nordlicht Paket', { epg: LIST_EPG });
    const ch = await addChannel(list, 'Nordlicht TV');
    guides.set(LIST_EPG, guide([['nordlicht.de', 'Nordlicht TV']]));
    await refreshEpg(env.ctx, await src(list));
    await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values (gen_random_uuid(), 'sub-ben', 'ben@friend.example.com', 'Ben Muster', 'family', $1, 'Ben', $2) on conflict do nothing`, ['2'.repeat(32), encrypt(key, 'pw')]);
    const ben = await env.login({ sub: 'sub-ben', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] });
    expect((await pin(ch, { none: true }, ben)).statusCode).toBe(403);
    expect((await pin(ch, { sourceId: list, xmlId: 'nordlicht.de' }, ben)).statusCode).toBe(403);
    expect((await search(list, 'nord', ben)).statusCode).toBe(403);
    expect(await chan(ch)).toMatchObject({ epg_match: 'auto' });
    // and CSRF: a write without the token is refused
    const noCsrf = await env.app.inject({ method: 'PUT', url: `/api/admin/livetv/channels/${ch}/epg`, cookies: admin.cookies, remoteAddress: '192.0.2.251', payload: { none: true } });
    expect(noCsrf.statusCode).toBe(403);
  });
});
