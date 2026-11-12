// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 17: the XMLTV import (ruling 27, spec §19), the four-pass matching (spec §9.4, rulings 27 and 44, F17), offsets
 * on read (ruling 42), EPG logos (ruling 43), now/next, the prune, the EPG step of the refresh (F16) and the shared normName (F18).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { CHANNEL_SELECT } from '../src/livetv/channels.js';
import { livetvStream } from '../src/livetv/client.js';
import { autoMatch, buildEpgIndex, epgPrune, livetvEpgPruneTick, matchChannel, normName, nowNext, refreshEpg } from '../src/livetv/epg.js';
import { livetvRefreshTick, refreshSource } from '../src/livetv/refresh.js';
import type { SourceRow } from '../src/livetv/sources.js';
import type { M3uEntry } from '../src/livetv/wire.js';
import { ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
const key = keyFromBase64(ENC_KEY);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const EPG_A = 'https://anna:geheim@iptv.example.com/xmltv.php?username=anna&password=geheim';
const EPG_B = 'https://iptv.example.com/epg/zweiter.xml.gz';
const ICON = 'https://iptv.example.com/icons/nordlicht.png?token=geheim';
const ICON_HAFEN = 'https://iptv.example.com/icons/hafenkanal.png?token=geheim';

// ---- the fake livetv: XMLTV guides by URL, filtered like livetv does (channels, time window) ----
type GuideChannel = { id: string; names: string[]; icon?: string };
type GuideProg = { ch: string; start: number; end: number; title: string; subtitle?: string };
type Guide = { channels: GuideChannel[]; progs: GuideProg[]; fail?: 'error' | 'noend' | 'badline' | 'status' };
const guides = new Map<string, Guide>();
const calls: Call[] = [];
let list: M3uEntry[] = [];
const xmltvCalls = () => calls.filter((c) => c.path === '/v1/fetch/xmltv');
const logoCalls = (url?: string) => calls.filter((c) => c.path === '/v1/fetch/logo' && (url === undefined || c.body.url === url));

function xmltvAnswer(body: { url: string; channels?: string[]; from: number; to: number }) {
  const g = guides.get(body.url);
  if (!g || g.fail === 'status') return { status: 400, json: { error: 'invalid', field: 'url' } };
  const want = (id: string) => !body.channels || body.channels.includes(id);
  const lines: unknown[] = [];
  for (const c of g.channels) if (want(c.id)) lines.push({ t: 'channel', ...c });
  let programmes = 0;
  for (const p of g.progs) {
    if (!want(p.ch) || p.end < body.from || p.start > body.to) continue;
    lines.push({ t: 'prog', ...p });
    programmes++;
  }
  let text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  if (g.fail === 'error') text += `${JSON.stringify({ t: 'error', code: 'invalid' })}\n`;
  else if (g.fail === 'badline') text += '{"t":"prog","ch":\n';
  else if (g.fail !== 'noend') text += `${JSON.stringify({ t: 'end', programmes, channels: lines.length - programmes })}\n`;
  return { raw: text, type: 'application/x-ndjson' };
}

// ---- times: today (UTC) at hh:mm, so every programme is inside the import window (yesterday to 8 days ahead) ----
const day = new Date();
day.setUTCHours(0, 0, 0, 0);
const at = (h: number, m = 0) => day.getTime() + (h * 60 + m) * 60_000;
const iso = (h: number, m = 0) => new Date(at(h, m)).toISOString();
const ymd = day.toISOString().slice(0, 10);

async function addSource(o: { kind?: 'm3u' | 'manual'; epg?: string | null; logoPref?: 'm3u' | 'xmltv'; shift?: number; refresh?: string; epgAt?: Date | null; lastAt?: Date | null; position?: number } = {}): Promise<string> {
  const id = randomUUID();
  const own = o.kind === 'manual';
  await env.pool.query(
    `insert into livetv_sources(id, kind, name, url_enc, url_hint, epg_url_enc, epg_hint, logo_pref, epg_shift_min, refresh, epg_last_refresh_at, last_refresh_at, position)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, own ? 'manual' : 'm3u', own ? 'Eigene Streams' : 'Anbieter', own ? null : encrypt(key, 'https://iptv.example.com/get.php?u=anna&p=geheim'),
      own ? null : 'https://iptv.example.com/…', o.epg ? encrypt(key, o.epg) : null, o.epg ? 'https://iptv.example.com/…' : null,
      o.logoPref ?? 'm3u', o.shift ?? 0, o.refresh ?? '24h', o.epgAt ?? null, o.lastAt ?? null, o.position ?? 0]);
  return id;
}
async function addChannel(sourceId: string, name: string, o: { tvgId?: string; tvgName?: string; importShift?: number; overrideShift?: number; importLogo?: string; map?: [string, string]; match?: 'auto' | 'manual' | 'none'; missingSince?: Date } = {}): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, tvg_id, tvg_name, import_epg_shift_min,
       epg_shift_override_min, import_logo_hash, epg_source_id, epg_channel_id, epg_match, missing_since)
     values ($1, $2, $3, $4, 'ts', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, sourceId, `k-${id}`, encrypt(key, 'https://iptv.example.com/live/anna/geheim/1.ts'), name, o.tvgId ?? null, o.tvgName ?? null,
      o.importShift ?? null, o.overrideShift ?? null, o.importLogo ?? null, o.map?.[0] ?? null, o.map?.[1] ?? null, o.match ?? (o.map ? 'manual' : 'auto'),
      o.missingSince ?? null]);
  return id;
}
const src = async (id: string) => (await env.pool.query<SourceRow>('select * from livetv_sources where id = $1', [id])).rows[0]!;
const chan = async (id: string) => (await env.pool.query('select * from livetv_channels where id = $1', [id])).rows[0];
const progs = async (sourceId: string) => (await env.pool.query('select xml_channel, title, start_at, end_at from livetv_programmes where source_id = $1 order by start_at, title', [sourceId])).rows;
const addProg = (sourceId: string, ch: string, title: string, start: number, end: number) =>
  env.pool.query('insert into livetv_programmes(source_id, xml_channel, title, start_at, end_at) values ($1, $2, $3, $4, $5)', [sourceId, ch, title, new Date(start), new Date(end)]);
let addr = 0;
const call = (method: 'GET' | 'POST', url: string, s: Sess = admin) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}` });

/** Nordlicht TV (with icon) and Hafenkanal, three programmes on Nordlicht */
const nordGuide = (): Guide => ({
  channels: [{ id: 'nordlicht.de', names: ['Nordlicht TV', 'Nordlicht HD'], icon: ICON }, { id: 'hafenkanal.de', names: ['Hafenkanal'], icon: ICON_HAFEN }],
  progs: [
    { ch: 'nordlicht.de', start: at(20, 15), end: at(21), title: 'Die Leuchtturmwärter', subtitle: 'Sturm und Stille' },
    { ch: 'nordlicht.de', start: at(21), end: at(21, 15), title: 'Wetter am Hafen' },
    { ch: 'hafenkanal.de', start: at(20), end: at(21), title: 'Abenteuer Wattenmeer' },
  ],
});

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query(`delete from livetv_programmes; delete from livetv_epg_channels; delete from livetv_recent; delete from livetv_favourites;
    delete from livetv_channels; delete from livetv_group_map; delete from livetv_groups; delete from livetv_logos; delete from livetv_sources`);
  for (const k of [...await env.kv.keys('ltv'), ...await env.kv.keys('ltvlogo:')]) await env.kv.del(k);
  calls.length = 0;
  guides.clear();
  list = [];
  env.ctx.fetchImpl = fakeHttp({
    'POST /v1/fetch/m3u': () => ({ json: { entries: list, groups: [], listed: list.length, skipped: { vod: 0, invalid: 0, overLimit: 0, groups: 0 } } }),
    'POST /v1/fetch/xmltv': (_u, _i, body) => xmltvAnswer(body),
    'POST /v1/fetch/logo': () => ({ raw: PNG, type: 'image/png' }),
  }, calls);
});
afterEach(() => { vi.useRealTimers(); });

describe('XMLTV import (ruling 27, spec §19)', () => {
  it('a broken file keeps the old programmes', async () => {
    guides.set(EPG_A, nordGuide());
    const id = await addSource({ epg: EPG_A });
    await addChannel(id, 'Nordlicht TV');
    await addChannel(id, 'Hafenkanal');
    expect(await refreshEpg(env.ctx, await src(id))).toEqual({ channels: 2, programmes: 3 });
    const before = await progs(id);
    expect(before.map((p) => p.title)).toEqual(['Abenteuer Wattenmeer', 'Die Leuchtturmwärter', 'Wetter am Hafen']);
    const okAt = (await src(id)).epg_last_ok_at;
    expect((await src(id)).epg_counts).toEqual({ channels: 2, programmes: 3 });

    for (const [fail, code] of [['error', 'invalid'], ['noend', 'incomplete'], ['badline', 'invalid_answer'], ['status', 'invalid']] as const) {
      // the new file would have other programmes: none of them may land
      guides.set(EPG_A, { ...nordGuide(), progs: [{ ch: 'nordlicht.de', start: at(22), end: at(23), title: 'Sternstunde Physik' }], fail });
      expect(await refreshEpg(env.ctx, await src(id))).toEqual({ error: code });
      expect(await progs(id)).toEqual(before);
      const s = await src(id);
      expect(s.epg_last_error).toBe(code);
      expect(s.epg_last_ok_at).toEqual(okAt);
      expect(s.epg_counts).toEqual({ channels: 2, programmes: 3 });
    }
    // livetv not reached
    env.ctx.fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await refreshEpg(env.ctx, await src(id))).toEqual({ error: 'livetv_unreachable' });
    expect(await progs(id)).toEqual(before);
    // only fixed codes, never a URL or a provider text
    const s = await src(id);
    expect(s.epg_last_error).toMatch(/^[a-z_]{1,40}$/);
  });

  it('UTC is stored', async () => {
    // <programme start="…201500 +0200"> arrives from livetv as epoch ms of that instant
    const start = Date.parse(`${ymd}T20:15:00+02:00`);
    guides.set(EPG_A, { channels: [{ id: 'nordlicht.de', names: ['Nordlicht TV'] }], progs: [{ ch: 'nordlicht.de', start, end: start + 45 * 60_000, title: 'Abendjournal' }] });
    const id = await addSource({ epg: EPG_A });
    const ch = await addChannel(id, 'Nordlicht TV', { tvgId: 'nordlicht.de' });
    await refreshEpg(env.ctx, await src(id));
    const [p] = await progs(id);
    expect((p.start_at as Date).toISOString()).toBe(iso(18, 15));
    const nn = (await nowNext(env.ctx, [ch], new Date(at(18, 30)))).get(ch)!;
    expect(nn.now).toEqual({ title: 'Abendjournal', start: iso(18, 15), end: iso(19) });
  });

  it('the request filter lists only the stored ids a channel could match, and the index is read once', async () => {
    guides.set(EPG_A, {
      channels: [{ id: 'Nordlicht.DE', names: ['Nordlicht TV'] }, { id: 'kinderinsel.de', names: ['Kinderinsel'] }, { id: 'sternwarte24.de', names: ['Sternwarte 24'] }],
      progs: [
        { ch: 'Nordlicht.DE', start: at(20), end: at(21), title: 'Abendjournal' },
        { ch: 'kinderinsel.de', start: at(20), end: at(21), title: 'Abenteuer Wattenmeer' },
        { ch: 'sternwarte24.de', start: at(20), end: at(21), title: 'Sternstunde Physik' },
      ],
    });
    const id = await addSource({ epg: EPG_A });
    const other = await addSource();
    const nord = await addChannel(id, 'Nordlicht TV HD', { tvgId: 'nordlicht.de' }); // pass 1 (case-insensitive) and pass 4
    await addChannel(other, 'Sternwarte 24'); // another source's channel: pass 3
    await refreshEpg(env.ctx, await src(id));
    const [index, run] = xmltvCalls();
    expect(xmltvCalls()).toHaveLength(2);
    expect(index!.body).toMatchObject({ url: EPG_A, allowLan: false, from: 0, to: 1 });
    expect(index!.body.channels).toBeUndefined();
    expect([...run!.body.channels].sort()).toEqual(['Nordlicht.DE', 'sternwarte24.de']);
    expect((await progs(id)).map((p) => p.title)).toEqual(['Abendjournal', 'Sternstunde Physik']);
    // the index keeps every channel; the next refresh reads no index again
    expect((await env.pool.query('select count(*)::int as n from livetv_epg_channels where source_id = $1', [id])).rows[0].n).toBe(3);
    expect((await chan(nord)).epg_channel_id).toBe('Nordlicht.DE');
    calls.length = 0;
    await refreshEpg(env.ctx, await src(id));
    expect(xmltvCalls()).toHaveLength(1);
    expect(xmltvCalls()[0]!.body.channels).toBeDefined();
    // another EPG URL: the index is read again
    calls.length = 0;
    guides.set(EPG_B, guides.get(EPG_A)!);
    await env.pool.query('update livetv_sources set epg_url_enc = $2 where id = $1', [id, encrypt(key, EPG_B)]);
    await refreshEpg(env.ctx, await src(id));
    expect(xmltvCalls()).toHaveLength(2);
  });

  it('an EPG nobody can use stores no programmes', async () => {
    guides.set(EPG_A, nordGuide());
    const id = await addSource({ epg: EPG_A });
    expect(await refreshEpg(env.ctx, await src(id))).toEqual({ channels: 0, programmes: 0 });
    expect(xmltvCalls()[1]!.body.channels).toEqual([]);
    // the index still holds every XMLTV channel (for matching and the Phase 2 picker)
    expect((await env.pool.query('select xml_id from livetv_epg_channels where source_id = $1 order by xml_id', [id])).rows.map((r) => r.xml_id))
      .toEqual(['hafenkanal.de', 'nordlicht.de']);
  });

  it('a filter over 2 000 ids is omitted and that run replaces the index', async () => {
    const n = 2100;
    guides.set(EPG_A, { channels: Array.from({ length: n }, (_, i) => ({ id: `kanal${i}.de`, names: [`Kanal ${i}`] })), progs: [] });
    const id = await addSource({ epg: EPG_A });
    await env.pool.query(
      `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, tvg_id)
       select gen_random_uuid(), $1, 'k' || i, $2, 'ts', 'Kanal ' || i, 'kanal' || i || '.de' from generate_series(0, $3 - 1) i`,
      [id, encrypt(key, 'https://iptv.example.com/live/1.ts'), n]);
    expect(await refreshEpg(env.ctx, await src(id))).toEqual({ channels: n, programmes: 0 });
    expect(xmltvCalls()[1]!.body.channels).toBeUndefined();
    expect((await env.pool.query("select count(*)::int as n from livetv_channels where epg_channel_id is not null")).rows[0].n).toBe(n);
  });

  it('the EPG import renews the refresh lock while it reads', async () => {
    guides.set(EPG_A, nordGuide());
    const id = await addSource({ epg: EPG_A });
    const beats: number[] = [];
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now');
    let t = now;
    spy.mockImplementation(() => (t += 61_000)); // every look at the clock is a minute later
    try {
      await refreshEpg(env.ctx, await src(id), { heartbeat: async () => { beats.push(1); } });
    } finally {
      spy.mockRestore();
    }
    expect(beats.length).toBeGreaterThan(0);
  });

  it('a cancelled stream clears its deadline at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    env.ctx.fetchImpl = (async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('{"t":"channel"}\n')); } }))) as typeof fetch;
    const r = await livetvStream(env.ctx, '/v1/fetch/xmltv', {}, { timeoutMs: 60_000 });
    const reader = r.body!.getReader();
    await reader.read();
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('matching (spec §9.4, rulings 27 and 44)', () => {
  const ch = (sourceId: string, o: { tvgId?: string; tvgName?: string; name: string }) => ({ sourceId, tvgId: o.tvgId ?? null, tvgName: o.tvgName ?? null, importName: o.name });

  it('the four passes in order', () => {
    const idx = buildEpgIndex([
      { sourceId: 's1', xmlId: 'Nordlicht.DE', names: ['Nordlicht Eins'] },
      { sourceId: 's1', xmlId: 'hk', names: ['Hafen Kanal'] },
      { sourceId: 's1', xmlId: 'bb', names: ['Bergblick Sport'] },
      { sourceId: 's1', xmlId: 'nl', names: ['Nordlicht TV'] },
    ]);
    expect(matchChannel(ch('s1', { tvgId: 'nordlicht.de', name: 'x' }), idx)).toEqual({ sourceId: 's1', xmlId: 'Nordlicht.DE', pass: 1 });
    expect(matchChannel(ch('s1', { tvgName: 'Hafen_Kanal', name: 'x' }), idx)).toEqual({ sourceId: 's1', xmlId: 'hk', pass: 2 });
    expect(matchChannel(ch('s1', { tvgName: '  hafen   kanal ', name: 'x' }), idx)).toEqual({ sourceId: 's1', xmlId: 'hk', pass: 2 });
    expect(matchChannel(ch('s1', { name: 'bergblick sport' }), idx)).toEqual({ sourceId: 's1', xmlId: 'bb', pass: 3 });
    expect(matchChannel(ch('s1', { name: 'Nordlicht TV HD' }), idx)).toEqual({ sourceId: 's1', xmlId: 'nl', pass: 4 });
    expect(matchChannel(ch('s1', { tvgId: 'unbekannt.de', tvgName: 'Unbekannt', name: 'Sternwarte 24' }), idx)).toBeNull();

    // pass order beats source order: a pass-1 hit in another source beats a pass-2 hit in the own source
    const two = buildEpgIndex([
      { sourceId: 's1', xmlId: 'hafen-own', names: ['Hafenkanal'] },
      { sourceId: 's2', xmlId: 'hafenkanal.de', names: ['Hafen'] },
    ]);
    expect(matchChannel(ch('s1', { tvgId: 'hafenkanal.de', tvgName: 'Hafenkanal', name: 'Hafenkanal' }), two)).toEqual({ sourceId: 's2', xmlId: 'hafenkanal.de', pass: 1 });

    // two pass-2 candidates in the own source: pass 3 decides
    const dup = buildEpgIndex([
      { sourceId: 's1', xmlId: 'a', names: ['Hafenkanal'] },
      { sourceId: 's1', xmlId: 'b', names: ['Hafenkanal', 'Hafenkanal Nord'] },
    ]);
    expect(matchChannel(ch('s1', { tvgName: 'Hafenkanal', name: 'Hafenkanal Nord' }), dup)).toEqual({ sourceId: 's1', xmlId: 'b', pass: 3 });
  });

  it('own source first', () => {
    const idx = buildEpgIndex([
      { sourceId: 's2', xmlId: 'nordlicht.de', names: ['Nordlicht TV'] },
      { sourceId: 's1', xmlId: 'nordlicht.de', names: ['Nordlicht TV'] },
    ]);
    expect(matchChannel(ch('s1', { tvgId: 'nordlicht.de', name: 'Nordlicht TV' }), idx)).toEqual({ sourceId: 's1', xmlId: 'nordlicht.de', pass: 1 });
    expect(matchChannel(ch('s2', { tvgId: 'nordlicht.de', name: 'Nordlicht TV' }), idx)).toEqual({ sourceId: 's2', xmlId: 'nordlicht.de', pass: 1 });
  });

  it('other sources decide together', () => {
    const rows = [
      { sourceId: 's1', xmlId: 'nordlicht.de', names: ['Nordlicht'] },
      { sourceId: 's2', xmlId: 'nordlicht.de', names: ['Nordlicht TV'] },
      { sourceId: 's3', xmlId: 'eigen', names: ['Hafenkanal'] },
    ];
    const c = ch('s3', { tvgId: 'nordlicht.de', name: 'Nordlicht TV' });
    // no hit in the own source, the tvg-id in two other sources: no pass-1 match, pass 3 decides (only s2 has the name)
    expect(matchChannel(c, buildEpgIndex(rows))).toEqual({ sourceId: 's2', xmlId: 'nordlicht.de', pass: 3 });
    // whatever the order of the sources
    expect(matchChannel(c, buildEpgIndex([...rows].reverse()))).toEqual({ sourceId: 's2', xmlId: 'nordlicht.de', pass: 3 });
    // in exactly one other source: a pass-1 match, whatever the positions
    const one = [{ sourceId: 's2', xmlId: 'Nordlicht.de', names: [] }, { sourceId: 's1', xmlId: 'x', names: ['Hafenkanal'] }];
    expect(matchChannel(c, buildEpgIndex(one))).toEqual({ sourceId: 's2', xmlId: 'Nordlicht.de', pass: 1 });
    expect(matchChannel(c, buildEpgIndex([...one].reverse()))).toEqual({ sourceId: 's2', xmlId: 'Nordlicht.de', pass: 1 });
    // several hits across other sources in every pass: no match
    const many = buildEpgIndex([{ sourceId: 's1', xmlId: 'n1', names: ['Nordlicht TV'] }, { sourceId: 's2', xmlId: 'n2', names: ['Nordlicht TV'] }]);
    expect(matchChannel(ch('s3', { name: 'Nordlicht TV' }), many)).toBeNull();
  });

  it('no fuzzy match is applied', () => {
    const idx = buildEpgIndex([{ sourceId: 's1', xmlId: 'nl2', names: ['Nordlicht TV 2'] }]);
    expect(matchChannel(ch('s1', { name: 'Nordlicht' }), idx)).toBeNull();
    expect(matchChannel(ch('s1', { name: 'Nordlicht TV' }), idx)).toBeNull();
  });

  it('normName vectors', () => {
    const rows = JSON.parse(readFileSync(new URL('../../test-vectors/livetv-normname.json', import.meta.url), 'utf8')) as Array<{ in: string; out: string }>;
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) expect(normName(r.in), r.in).toBe(r.out);
  });

  it('autoMatch maps auto channels only and drops a mapping that no longer matches', async () => {
    guides.set(EPG_A, nordGuide());
    const id = await addSource({ epg: EPG_A });
    const auto = await addChannel(id, 'Nordlicht TV');
    const manual = await addChannel(id, 'Hafenkanal', { map: [id, 'nordlicht.de'] });
    const none = await addChannel(id, 'Hafenkanal', { match: 'none' });
    const stale = await addChannel(id, 'Kinderinsel', { map: [id, 'kinderinsel.de'], match: 'auto' });
    await refreshEpg(env.ctx, await src(id));
    expect(await chan(auto)).toMatchObject({ epg_source_id: id, epg_channel_id: 'nordlicht.de' });
    expect(await chan(manual)).toMatchObject({ epg_channel_id: 'nordlicht.de' });
    expect(await chan(none)).toMatchObject({ epg_source_id: null, epg_channel_id: null });
    expect(await chan(stale)).toMatchObject({ epg_source_id: null, epg_channel_id: null });
    expect(await autoMatch(env.ctx)).toEqual({ matched: 1, total: 2 });
  });
});

describe('logos (ruling 43, F17)', () => {
  it('refreshEpg hands its icons to the matcher', async () => {
    guides.set(EPG_A, nordGuide());
    const id = await addSource({ epg: EPG_A, logoPref: 'xmltv' });
    const nord = await addChannel(id, 'Nordlicht TV');
    await refreshEpg(env.ctx, await src(id));
    expect(logoCalls(ICON)).toHaveLength(1);
    expect(logoCalls(ICON)[0]!.body).toEqual({ url: ICON, allowLan: false });
    expect((await chan(nord)).epg_logo_hash).toMatch(/^[0-9a-f]{64}$/);
    // the unmatched XMLTV channel's icon is not fetched
    expect(logoCalls(ICON_HAFEN)).toHaveLength(0);
    const dump = JSON.stringify((await env.pool.query(`select (select json_agg(s) from livetv_sources s) a, (select json_agg(c) from livetv_channels c) b,
      (select json_agg(e) from livetv_epg_channels e) c, (select json_agg(p) from livetv_programmes p) d`)).rows);
    expect(dump).not.toContain('icons/');
    expect(dump).not.toContain('geheim');
  });

  it('logo preference', async () => {
    guides.set(EPG_A, {
      channels: [{ id: 'nordlicht.de', names: ['Nordlicht TV'], icon: ICON }, { id: 'hafenkanal.de', names: ['Hafenkanal'], icon: ICON_HAFEN },
        { id: 'kinderinsel.de', names: ['Kinderinsel'], icon: ICON_HAFEN }, { id: 'sternwarte24.de', names: ['Sternwarte 24'] }],
      progs: [],
    });
    const xmltvSrc = await addSource({ epg: EPG_A, logoPref: 'xmltv' });
    const m3uSrc = await addSource({ logoPref: 'm3u' });
    const importHash = 'a'.repeat(64);
    await env.pool.query("insert into livetv_logos(hash, mime, bytes) values ($1, 'image/png', $2)", [importHash, PNG]);
    const pref = await addChannel(xmltvSrc, 'Nordlicht TV', { importLogo: importHash });
    const withLogo = await addChannel(m3uSrc, 'Nordlicht TV', { importLogo: importHash });
    const hafen = await addChannel(m3uSrc, 'Hafenkanal');
    const kinder = await addChannel(m3uSrc, 'Kinderinsel');
    const stern = await addChannel(xmltvSrc, 'Sternwarte 24', { importLogo: importHash });
    await refreshEpg(env.ctx, await src(xmltvSrc));

    const eff = async (cid: string) => (await env.pool.query(`${CHANNEL_SELECT} where c.id = $1`, [cid])).rows[0].logo_hash;
    // xmltv: the EPG logo is the effective logo, over the import logo
    const epgHash = (await chan(pref)).epg_logo_hash;
    expect(epgHash).toMatch(/^[0-9a-f]{64}$/);
    expect(epgHash).not.toBe(importHash);
    expect(await eff(pref)).toBe(epgHash);
    // m3u with a tvg-logo: no icon fetch for it (ICON is fetched once, for `pref` only)
    expect(logoCalls(ICON)).toHaveLength(1);
    expect((await chan(withLogo)).epg_logo_hash).toBeNull();
    expect(await eff(withLogo)).toBe(importHash);
    // m3u without: fetched, once per URL (two channels, one URL)
    expect(logoCalls(ICON_HAFEN)).toHaveLength(1);
    expect(await eff(hafen)).toBe((await chan(hafen)).epg_logo_hash);
    expect((await chan(kinder)).epg_logo_hash).toBe((await chan(hafen)).epg_logo_hash);
    // an XMLTV channel without an icon: no EPG logo, the import logo stays effective
    expect((await chan(stern)).epg_logo_hash).toBeNull();
    expect(await eff(stern)).toBe(importHash);
    // a second refresh fetches nothing again (7-day memo)
    await refreshEpg(env.ctx, await src(xmltvSrc));
    expect(logoCalls()).toHaveLength(2);
    // unmatched: cleared
    await env.pool.query("update livetv_channels set import_name = 'Kanal Wolkenlos' where id = $1", [hafen]);
    await refreshEpg(env.ctx, await src(xmltvSrc));
    expect(await chan(hafen)).toMatchObject({ epg_channel_id: null, epg_logo_hash: null });
    // no icon URL in any table
    const dump = JSON.stringify((await env.pool.query(`select (select json_agg(s) from livetv_sources s) a, (select json_agg(c) from livetv_channels c) b,
      (select json_agg(e) from livetv_epg_channels e) c`)).rows);
    expect(dump).not.toContain('icons/');
  });
});

describe('now and next (ruling 42)', () => {
  it('now and next', async () => {
    guides.set(EPG_A, nordGuide());
    const id = await addSource({ epg: EPG_A });
    const ch = await addChannel(id, 'Nordlicht TV');
    const unmapped = await addChannel(id, 'Kanal Wolkenlos');
    await refreshEpg(env.ctx, await src(id));
    const m = await nowNext(env.ctx, [ch, unmapped], new Date(at(20, 30)));
    expect(m.get(ch)).toEqual({
      now: { title: 'Die Leuchtturmwärter', start: iso(20, 15), end: iso(21), subtitle: 'Sturm und Stille' },
      next: { title: 'Wetter am Hafen', start: iso(21), end: iso(21, 15) },
    });
    expect(m.has(unmapped)).toBe(false);
    // in a gap: next only; after the last: neither
    expect((await nowNext(env.ctx, [ch], new Date(at(19)))).get(ch)).toEqual({ next: { title: 'Die Leuchtturmwärter', start: iso(20, 15), end: iso(21), subtitle: 'Sturm und Stille' } });
    expect((await nowNext(env.ctx, [ch], new Date(at(23)))).get(ch)).toEqual({});
    expect((await nowNext(env.ctx, [])).size).toBe(0);
  });

  it('offsets shift now and next on read', async () => {
    const epg = await addSource({ epg: EPG_A });
    const plus60 = await addSource({ shift: 60 });
    await addProg(epg, 'nordlicht.de', 'Die Leuchtturmwärter', at(19, 15), at(20));
    await addProg(epg, 'nordlicht.de', 'Wetter am Hafen', at(20), at(20, 15));
    await addProg(epg, 'nordlicht.de', 'Abendjournal', at(20, 15), at(21));
    const map: [string, string] = [epg, 'nordlicht.de'];
    const listShift = await addChannel(epg, 'Nordlicht TV', { importShift: 60, map });
    const override = await addChannel(epg, 'Nordlicht TV', { importShift: 60, overrideShift: 0, map });
    const sourceShift = await addChannel(plus60, 'Nordlicht TV', { map });
    const m = await nowNext(env.ctx, [listShift, override, sourceShift], new Date(at(20, 30)));
    // +60: the 19:15-20:00 UTC programme is on at 20:30, shown 20:15-21:00
    expect(m.get(listShift)!.now).toEqual({ title: 'Die Leuchtturmwärter', start: iso(20, 15), end: iso(21) });
    expect(m.get(listShift)!.next).toEqual({ title: 'Wetter am Hafen', start: iso(21), end: iso(21, 15) });
    // the channel override 0 wins over the import +60
    expect(m.get(override)!.now).toEqual({ title: 'Abendjournal', start: iso(20, 15), end: iso(21) });
    // the source's +60 when the channel has neither
    expect(m.get(sourceShift)!.now).toEqual({ title: 'Die Leuchtturmwärter', start: iso(20, 15), end: iso(21) });
    // never stored into the programmes
    expect((await progs(epg))[0].start_at.toISOString()).toBe(iso(19, 15));
  });

  it('one EPG channel serves two channels with different offsets', async () => {
    const epg = await addSource({ epg: EPG_A });
    await addProg(epg, 'hafenkanal.de', 'Abenteuer Wattenmeer', at(19), at(20));
    await addProg(epg, 'hafenkanal.de', 'Sternstunde Physik', at(20), at(21));
    const a = await addChannel(epg, 'Hafenkanal', { map: [epg, 'hafenkanal.de'] });
    const b = await addChannel(epg, 'Hafenkanal West', { overrideShift: 60, map: [epg, 'hafenkanal.de'] });
    const m = await nowNext(env.ctx, [a, b], new Date(at(20, 30)));
    expect(m.get(a)!.now).toEqual({ title: 'Sternstunde Physik', start: iso(20), end: iso(21) });
    expect(m.get(b)!.now).toEqual({ title: 'Abenteuer Wattenmeer', start: iso(20), end: iso(21) });
  });
});

describe('the EPG step of the refresh (F16)', () => {
  it('the EPG step skips sources without an EPG URL', async () => {
    list = [{ key: 'k0', name: 'Nordlicht TV', pos: 0, url: 'https://iptv.example.com/live/anna/geheim/0.ts', kind: 'ts' }];
    const own = await addSource({ kind: 'manual', position: 0 });
    const plain = await addSource({ position: 1 });
    await refreshSource(env.ctx, own, 'admin');
    await refreshSource(env.ctx, plain, 'admin');
    await livetvRefreshTick(env.ctx);
    expect(calls.filter((c) => c.path === '/v1/fetch/m3u').length).toBeGreaterThan(0);
    expect(xmltvCalls()).toHaveLength(0);
    for (const sid of [own, plain]) expect(await src(sid)).toMatchObject({ epg_last_error: null, epg_last_refresh_at: null });
    // refreshEpg itself refuses them too, recording nothing
    expect(await refreshEpg(env.ctx, await src(own))).toEqual({ error: 'no_epg' });
    expect(await refreshEpg(env.ctx, await src(plain))).toEqual({ error: 'no_epg' });
    expect(xmltvCalls()).toHaveLength(0);
  });

  it('the list refresh runs the EPG step after the list', async () => {
    guides.set(EPG_A, nordGuide());
    list = [{ key: 'nordlicht.de', name: 'Nordlicht TV', tvgId: 'nordlicht.de', pos: 0, url: 'https://iptv.example.com/live/anna/geheim/0.ts', kind: 'ts' }];
    const id = await addSource({ epg: EPG_A });
    await refreshSource(env.ctx, id, 'admin');
    const s = await src(id);
    expect(s.last_error).toBeNull();
    expect(s.epg_last_error).toBeNull();
    expect(s.epg_last_ok_at).not.toBeNull();
    const ch = (await env.pool.query('select * from livetv_channels where source_id = $1', [id])).rows[0];
    expect(ch).toMatchObject({ epg_source_id: id, epg_channel_id: 'nordlicht.de' });
    // a failing EPG leaves the list result alone
    guides.set(EPG_A, { ...nordGuide(), fail: 'error' });
    await refreshSource(env.ctx, id, 'admin');
    expect(await src(id)).toMatchObject({ last_error: null, epg_last_error: 'invalid' });
  });

  it("a source with refresh 'manual' still refreshes its EPG every 24 h", async () => {
    guides.set(EPG_A, nordGuide());
    const hour = 3600_000;
    const id = await addSource({ epg: EPG_A, refresh: 'manual', epgAt: new Date(Date.now() - 25 * hour) });
    await addChannel(id, 'Nordlicht TV');
    await addChannel(id, 'Hafenkanal');
    await livetvRefreshTick(env.ctx);
    expect(calls.filter((c) => c.path === '/v1/fetch/m3u')).toHaveLength(0);
    expect(xmltvCalls().length).toBeGreaterThan(0);
    expect((await src(id)).epg_last_ok_at).not.toBeNull();
    expect(await progs(id)).toHaveLength(3);
    // refreshed 23 h ago: not due
    calls.length = 0;
    await env.pool.query('update livetv_sources set epg_last_refresh_at = $2 where id = $1', [id, new Date(Date.now() - 23 * hour)]);
    await livetvRefreshTick(env.ctx);
    expect(xmltvCalls()).toHaveLength(0);
    // a disabled source is not refreshed
    await env.pool.query('update livetv_sources set epg_last_refresh_at = null, enabled = false where id = $1', [id]);
    await livetvRefreshTick(env.ctx);
    expect(xmltvCalls()).toHaveLength(0);
    // the single-flight lock of the source is respected
    await env.pool.query('update livetv_sources set enabled = true where id = $1', [id]);
    await env.kv.set(`ltv:refresh:${id}`, 'other', 60);
    await livetvRefreshTick(env.ctx);
    expect(xmltvCalls()).toHaveLength(0);
  });
});

describe('prune and summary', () => {
  it('prune', async () => {
    const now = new Date(at(4, 15));
    const day = 24 * 3600_000;
    const id = await addSource({ epg: EPG_A });
    await addProg(id, 'nordlicht.de', 'Abendjournal', now.getTime() - 2 * day, now.getTime() - day - 60_000);
    await addProg(id, 'nordlicht.de', 'Wetter am Hafen', now.getTime() - day + 60_000 - 3600_000, now.getTime() - day + 60_000);
    const used = 'b'.repeat(64);
    const orphan = 'c'.repeat(64);
    const fresh = 'd'.repeat(64);
    const old = new Date(now.getTime() - 2 * day);
    for (const [h, t] of [[used, old], [orphan, old], [fresh, now]] as const) {
      await env.pool.query("insert into livetv_logos(hash, mime, bytes, fetched_at) values ($1, 'image/png', $2, $3)", [h, PNG, t]);
    }
    await addChannel(id, 'Nordlicht TV', { importLogo: used, missingSince: new Date(now.getTime() - 29 * day) });
    await addChannel(id, 'Hafenkanal', { missingSince: new Date(now.getTime() - 31 * day) });
    expect(await epgPrune(env.ctx, now)).toEqual({ programmes: 1, channels: 1, logos: 1 });
    expect((await progs(id)).map((p) => p.title)).toEqual(['Wetter am Hafen']);
    expect((await env.pool.query('select hash from livetv_logos order by hash')).rows.map((r) => r.hash)).toEqual([used, fresh]);
    expect(await epgPrune(env.ctx, now)).toEqual({ programmes: 0, channels: 0, logos: 0 });
  });

  it('the prune tick runs once a day from 04:10 server time', async () => {
    const local = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
    expect(await livetvEpgPruneTick(env.ctx, local(4, 5))).toBe(false);
    expect(await livetvEpgPruneTick(env.ctx, local(3, 59))).toBe(false);
    expect(await livetvEpgPruneTick(env.ctx, local(4, 10))).toBe(true);
    expect(await livetvEpgPruneTick(env.ctx, local(4, 20))).toBe(false);
    expect(await livetvEpgPruneTick(env.ctx, local(5, 10))).toBe(false);
  });

  it('summary counts', async () => {
    const id = await addSource({ epg: EPG_A });
    await addChannel(id, 'Nordlicht TV', { map: [id, 'nordlicht.de'] });
    await addChannel(id, 'Hafenkanal', { map: [id, 'hafenkanal.de'], match: 'auto' });
    await addChannel(id, 'Kinderinsel');
    await addChannel(id, 'Sternwarte 24', { match: 'none' });
    await addChannel(id, 'Bergblick Sport', { map: [id, 'bergblick.de'], missingSince: new Date() });
    const r = await call('GET', '/api/admin/livetv/epg/summary');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ matched: 2, total: 4, unmatched: 2 });
    await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values (gen_random_uuid(), 'sub-ben', 'ben@friend.example.com', 'Ben Muster', 'family', $1, 'Ben', $2) on conflict do nothing`,
      ['2'.repeat(32), encrypt(key, 'pw')]);
    const user = await env.login({ sub: 'sub-ben', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] });
    expect((await call('GET', '/api/admin/livetv/epg/summary', user)).statusCode).toBe(403);
  });
});

describe('wire.ts (F4)', () => {
  it('XmlItem and XmltvLine are the declarations of livetv, field for field', () => {
    const norm = (x: string) => x.replace(/\/\*.*?\*\//g, '').replace(/\s+/g, ' ').trim();
    const ours = readFileSync(new URL('../src/livetv/wire.ts', import.meta.url), 'utf8');
    const xmltv = readFileSync(new URL('../../livetv/src/xmltv.ts', import.meta.url), 'utf8');
    const fetchTs = readFileSync(new URL('../../livetv/src/fetch.ts', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../../livetv/src/routes/fetch.ts', import.meta.url), 'utf8');
    /** `export type <name> = … ;` up to the first `;` that ends a line followed by an unindented one */
    const decl = (src: string, name: string) => {
      const i = src.indexOf(`export type ${name} =`);
      expect(i, name).toBeGreaterThanOrEqual(0);
      const end = /;\n(?=[^ \t]|$)/g;
      end.lastIndex = i;
      return norm(src.slice(i, end.exec(src)!.index + 1));
    };
    expect(decl(ours, 'XmlItem')).toBe(decl(xmltv, 'XmlItem'));
    expect(decl(ours, 'XmltvLine')).toBe(decl(route, 'XmltvLine'));
    expect(decl(ours, 'FetchErrorCode')).toBe(decl(fetchTs, 'FetchErrorCode'));
    expect(decl(ours, 'XmltvErrorCode')).toBe(decl(xmltv, 'XmltvErrorCode'));
  });
});
