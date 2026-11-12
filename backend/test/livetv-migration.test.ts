// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/db.js';
import { CHANNEL_SELECT, srtHost, toEffective, type EffectiveChannel } from '../src/livetv/channels.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { settingsView } from '../src/routes/adminSettings.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Live TV Phase 1, Task 12: migration 48 (spec §6.1), the `livetv` settings group (§6.4, ruling 25) and the effective channel values
// (§6.1 "Derived values", channels.ts). The migration is tested against the real one: rewind past 47, migrate again.
const TABLES = ['livetv_channels', 'livetv_epg_channels', 'livetv_favourites', 'livetv_group_map', 'livetv_group_roles', 'livetv_group_users',
  'livetv_groups', 'livetv_logos', 'livetv_programmes', 'livetv_recent', 'livetv_sources'];

let env: TestEnv;
let livetvUp = false;
const pool = () => env.pool;
const q = (sql: string, args: unknown[] = []) => env.pool.query(sql, args);

/** drops everything migration 48 creates and forgets it ran */
async function rewind(drop = true) {
  if (drop) {
    await q(`drop table if exists ${[...TABLES].reverse().join(', ')} cascade;
      alter table devices drop column if exists start_live;`);
  }
  await q('delete from schema_migrations where version >= 48');
  await migrate(pool());
}

const addSource = async (over: Record<string, unknown> = {}) => {
  const id = randomUUID();
  const row = { id, kind: 'm3u', name: 'Testliste', url_enc: 'enc-url', ...over };
  const keys = Object.keys(row);
  await q(`insert into livetv_sources(${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  return id;
};
const addChannel = async (sourceId: string, over: Record<string, unknown> = {}) => {
  const id = randomUUID();
  const row = { id, source_id: sourceId, source_key: `k-${id}`, stream_url_enc: 'enc-stream', stream_kind: 'hls', import_name: 'Nordlicht TV', ...over };
  const keys = Object.keys(row);
  await q(`insert into livetv_channels(${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  return id;
};
const addGroup = async (name: string, over: Record<string, unknown> = {}) => {
  const id = randomUUID();
  const row = { id, name, ...over };
  const keys = Object.keys(row);
  await q(`insert into livetv_groups(${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  return id;
};
const addProfile = async (name: string) => {
  const uid = randomUUID();
  await q("insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,$2,$3,'family','j','j','x')", [uid, `sub-${uid}`, name]);
  await q('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [uid, name]);
  return uid;
};
const pushCreds = (port: number) => ({ stream_url_enc: null, ingest: 'push', stream_kind: 'srt', push_port: port, push_stream_id_enc: 'enc-id', push_stream_id_hint: 'ff-AB12CD', push_passphrase_enc: 'enc-pass' });
const effective = async (id: string): Promise<EffectiveChannel> => toEffective((await q(`${CHANNEL_SELECT} where c.id = $1`, [id])).rows[0]);
const count = async (sql: string, args: unknown[]) => Number((await q(`select count(*)::int n from ${sql}`, args)).rows[0].n);

beforeAll(async () => {
  env = await makeEnv({}, {
    ctxPatch: (c) => {
      const orig = c.fetchImpl;
      c.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(String(input));
        if (u.host !== 'livetv:8090') return orig(input, init);
        if (!livetvUp) throw new TypeError('fetch failed');
        if (u.pathname === '/healthz') return new Response(JSON.stringify({ ok: true, api: 1, version: '1.0.0', bootId: '0123456789abcdef' }));
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }) as typeof fetch;
    },
  });
});
afterAll(async () => { await env.close(); });

describe('migration 48', () => {
  it('is the 48th migration', () => {
    expect(MIGRATIONS.length).toBe(48);
  });

  it('all tables and the devices column exist', async () => {
    await rewind();
    const tables = (await q("select table_name from information_schema.tables where table_schema = 'public' and table_name like 'livetv\\_%' order by table_name")).rows.map((r) => r.table_name);
    expect(tables).toEqual(TABLES);
    expect(tables).not.toContain('livetv_last');
    const dev = (await q("select data_type, is_nullable, column_default from information_schema.columns where table_name = 'devices' and column_name = 'start_live'")).rows[0];
    expect(dev).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });

    const sid = await addSource();
    const s = (await q('select skip_groups, numbering, number_base, logo_pref, epg_shift_min, refresh, allow_lan, enabled, max_streams from livetv_sources where id = $1', [sid])).rows[0];
    expect(s).toEqual({ skip_groups: [], numbering: 'chno', number_base: 1, logo_pref: 'm3u', epg_shift_min: 0, refresh: '24h', allow_lan: false, enabled: true, max_streams: null });
    const gid = await addGroup('Nachrichten');
    expect((await q('select released, kid_friendly, position from livetv_groups where id = $1', [gid])).rows[0]).toEqual({ released: true, kid_friendly: false, position: 0 });
    const cid = await addChannel(sid);
    const c = (await q('select ingest, hidden, epg_match, import_epg_shift_min, epg_shift_override_min, epg_logo_hash from livetv_channels where id = $1', [cid])).rows[0];
    expect(c).toEqual({ ingest: 'pull', hidden: false, epg_match: 'auto', import_epg_shift_min: null, epg_shift_override_min: null, epg_logo_hash: null });
    expect((await q('select count(*)::int n from schema_migrations where version = 48')).rows[0].n).toBe(1);
  });

  it('checks hold', async () => {
    const sid = await addSource();
    const manual = await addSource({ kind: 'manual', name: 'Eigene Feeds', url_enc: null });
    await expect(addSource({ epg_shift_min: 900 })).rejects.toThrow(/check constraint/);
    await expect(addSource({ epg_shift_min: -721 })).rejects.toThrow(/check constraint/);
    await expect(addChannel(sid, { epg_shift_override_min: -800 })).rejects.toThrow(/check constraint/);
    await expect(addSource({ numbering: 'x' })).rejects.toThrow(/check constraint/);
    await expect(addSource({ logo_pref: 'svg' })).rejects.toThrow(/check constraint/);
    await expect(addSource({ url_enc: null })).rejects.toThrow(/check constraint/); // m3u needs its URL
    await expect(addSource({ kind: 'manual' })).rejects.toThrow(/check constraint/); // own feeds have none
    await expect(addSource({ kind: 'xtream' })).rejects.toThrow(/check constraint/);
    await expect(addGroup('')).rejects.toThrow(/check constraint/);

    // push feeds: all three credentials and SRT, never a stream URL
    await expect(addChannel(manual, { ...pushCreds(9001), push_passphrase_enc: null })).rejects.toThrow(/check constraint/);
    await expect(addChannel(manual, { ...pushCreds(9001), stream_kind: 'hls' })).rejects.toThrow(/check constraint/);
    await expect(addChannel(manual, { ...pushCreds(9001), stream_url_enc: 'enc-stream' })).rejects.toThrow(/check constraint/);
    await expect(addChannel(sid, { stream_url_enc: null })).rejects.toThrow(/check constraint/); // a pull feed needs its URL
    await addChannel(manual, pushCreds(9001));
    await expect(addChannel(manual, pushCreds(9001))).rejects.toThrow(/duplicate key/);
    await expect(addChannel(manual, pushCreds(70000))).rejects.toThrow(/check constraint/);

    // one channel per source key
    await addChannel(sid, { source_key: 'nordlicht' });
    await expect(addChannel(sid, { source_key: 'nordlicht' })).rejects.toThrow(/duplicate key/);
    // group names are unique regardless of case
    await addGroup('Sport');
    await expect(addGroup('sport')).rejects.toThrow(/duplicate key/);

    await q("insert into livetv_logos(hash, mime, bytes) values ('small', 'image/png', $1)", [Buffer.alloc(1024)]);
    await expect(q("insert into livetv_logos(hash, mime, bytes) values ('big', 'image/png', $1)", [Buffer.alloc(600 * 1024)])).rejects.toThrow(/check constraint/);
    await expect(q("insert into livetv_logos(hash, mime, bytes) values ('svg', 'image/svg+xml', $1)", [Buffer.alloc(10)])).rejects.toThrow(/check constraint/);

    const gid = await addGroup('Kinder');
    await q("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [gid]);
    await expect(q("insert into livetv_group_roles(group_id, role) values ($1, 'nobody')", [gid])).rejects.toThrow(/foreign key/);
  });

  it('cascades', async () => {
    const sid = await addSource();
    const gid = await addGroup('Kultur');
    const cid = await addChannel(sid, { import_group: 'Kultur' });
    await q("insert into livetv_group_map(source_id, provider_group, group_id) values ($1, 'Kultur', $2)", [sid, gid]);
    await q("insert into livetv_epg_channels(source_id, xml_id, names) values ($1, 'hafen.de', '{Hafenkanal}')", [sid]);
    await q("insert into livetv_programmes(source_id, xml_channel, start_at, end_at, title) values ($1, 'hafen.de', now(), now() + interval '1 hour', 'Wetter am Hafen')", [sid]);
    const other = await addSource({ name: 'EPG-Quelle' });
    const ch2 = await addChannel(other, { epg_source_id: sid, epg_channel_id: 'hafen.de' });
    await q('delete from livetv_sources where id = $1', [sid]);
    expect(await count('livetv_channels where source_id = $1', [sid])).toBe(0);
    expect(await count('livetv_channels where id = $1', [cid])).toBe(0);
    expect(await count('livetv_group_map where source_id = $1', [sid])).toBe(0);
    expect(await count('livetv_epg_channels where source_id = $1', [sid])).toBe(0);
    expect(await count('livetv_programmes where source_id = $1', [sid])).toBe(0);
    expect(await count('livetv_groups where id = $1', [gid])).toBe(1); // groups outlive a source
    expect((await q('select epg_source_id, epg_channel_id from livetv_channels where id = $1', [ch2])).rows[0]).toEqual({ epg_source_id: null, epg_channel_id: 'hafen.de' });

    // a deleted group: its overrides fall back to the map, its maps and rights go
    const g2 = await addGroup('Doku');
    const ch3 = await addChannel(other, { group_override: g2 });
    await q("insert into livetv_group_roles(group_id, role) values ($1, 'friend')", [g2]);
    await q('delete from livetv_groups where id = $1', [g2]);
    expect((await q('select group_override from livetv_channels where id = $1', [ch3])).rows[0].group_override).toBeNull();
    expect(await count('livetv_group_roles where group_id = $1', [g2])).toBe(0);

    // profiles: favourites and recent channels go with the profile; a deleted channel leaves no recent row
    const anna = await addProfile('Anna Beispiel');
    const ben = await addProfile('Ben Muster');
    await q('insert into livetv_favourites(profile_id, channel_id) values ($1, $2), ($3, $2)', [anna, ch2, ben]);
    await q('insert into livetv_recent(profile_id, channel_id) values ($1, $2), ($1, $3), ($4, $2)', [anna, ch2, ch3, ben]);
    await q('delete from profiles where id = $1', [anna]);
    expect(await count('livetv_favourites where profile_id = $1', [anna])).toBe(0);
    expect(await count('livetv_recent where profile_id = $1', [anna])).toBe(0);
    await q('delete from livetv_channels where id = $1', [ch2]);
    expect(await count('livetv_recent where channel_id = $1', [ch2])).toBe(0);
    expect(await count('livetv_favourites where channel_id = $1', [ch2])).toBe(0);
    expect(await count('livetv_recent where profile_id = $1', [ben])).toBe(0);
    // a user's deletion removes their group exceptions
    const uid = await addProfile('Carla Probe');
    const g3 = await addGroup('Musik');
    await q('insert into livetv_group_users(group_id, user_id, allow) values ($1, $2, true)', [g3, uid]);
    await q('delete from users where id = $1', [uid]);
    expect(await count('livetv_group_users where user_id = $1', [uid])).toBe(0);
  });

  it('migration 48 runs twice after a rewind', async () => {
    await rewind(false); // the objects stay: every statement is rerunnable
    await rewind(false);
    expect((await q('select count(*)::int n from schema_migrations where version = 48')).rows[0].n).toBe(1);
    expect((await q("select count(*)::int n from information_schema.columns where table_name = 'devices' and column_name = 'start_live'")).rows[0].n).toBe(1);
  });
});

describe('effective values', () => {
  it('number, name and group', async () => {
    const sid = await addSource({ name: 'Zahlenliste' });
    const sport = await addGroup('Bergblick');
    const kids = await addGroup('Kinderinsel');
    await q("insert into livetv_group_map(source_id, provider_group, group_id) values ($1, 'Sport DE', $2)", [sid, sport]);
    const id = await addChannel(sid, { import_name: 'Bergblick Sport', import_number: 7, import_group: 'Sport DE' });
    let e = await effective(id);
    expect(e).toMatchObject({ id, sourceId: sid, number: 7, name: 'Bergblick Sport', groupId: sport, hidden: false, missing: false, streamKind: 'hls', ingest: 'pull', epg: null, probe: null });
    await q("update livetv_channels set number_override = 12, name_override = 'Bergblick', group_override = $2 where id = $1", [id, kids]);
    e = await effective(id);
    expect([e.number, e.name, e.groupId]).toEqual([12, 'Bergblick', kids]);

    // no override and no map: no group; a group of another source's map does not apply
    const other = await addSource({ name: 'Andere Liste' });
    await q("insert into livetv_group_map(source_id, provider_group, group_id) values ($1, 'Sport DE', $2)", [other, kids]);
    const plain = await addChannel(sid, { import_name: 'Sternwarte 24', import_group: 'Unbekannt' });
    expect(await effective(plain)).toMatchObject({ number: null, groupId: null, name: 'Sternwarte 24' });

    await q("update livetv_channels set hidden = true, missing_since = now(), epg_source_id = $2, epg_channel_id = 'sternwarte.de' where id = $1", [plain, other]);
    const probe = { at: '2026-11-12T10:00:00.000Z', ok: true, video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'passthrough' };
    await q('update livetv_channels set probe = $2 where id = $1', [plain, JSON.stringify(probe)]);
    expect(await effective(plain)).toMatchObject({ hidden: true, missing: true, epg: { sourceId: other, channelId: 'sternwarte.de' }, probe });
    // filtering by the effective group: wrap the select (group_id is a select-list alias)
    const inSport = (await q(`select e.id from (${CHANNEL_SELECT}) e where e.group_id = $1`, [sport])).rows.map((r) => r.id);
    expect(inSport).toEqual([]); // the override moved the only mapped channel to kids
    expect((await q(`select e.id from (${CHANNEL_SELECT}) e where e.group_id = $1`, [kids])).rows.map((r) => r.id)).toEqual([id]);
    // the effective row carries no encrypted column
    const raw = (await q(`${CHANNEL_SELECT} where c.id = $1`, [plain])).rows[0];
    expect(Object.keys(raw).filter((k) => k.endsWith('_enc'))).toEqual([]);
  });

  it('logo: preference of the source, an override always wins', async () => {
    const sid = await addSource({ name: 'Logoliste' });
    const id = await addChannel(sid, { import_name: 'Hafenkanal', import_logo_hash: 'm3u-logo', epg_logo_hash: 'xmltv-logo' });
    expect((await effective(id)).logoHash).toBe('m3u-logo');
    await q('update livetv_channels set import_logo_hash = null where id = $1', [id]);
    expect((await effective(id)).logoHash).toBe('xmltv-logo');
    await q("update livetv_channels set import_logo_hash = 'm3u-logo' where id = $1", [id]);
    await q("update livetv_sources set logo_pref = 'xmltv' where id = $1", [sid]);
    expect((await effective(id)).logoHash).toBe('xmltv-logo');
    await q('update livetv_channels set epg_logo_hash = null where id = $1', [id]);
    expect((await effective(id)).logoHash).toBe('m3u-logo');
    await q("update livetv_channels set logo_override_hash = 'own-logo', epg_logo_hash = 'xmltv-logo' where id = $1", [id]);
    expect((await effective(id)).logoHash).toBe('own-logo');
    await q("update livetv_sources set logo_pref = 'm3u' where id = $1", [sid]);
    expect((await effective(id)).logoHash).toBe('own-logo');
    await q('update livetv_channels set logo_override_hash = null, import_logo_hash = null, epg_logo_hash = null where id = $1', [id]);
    expect((await effective(id)).logoHash).toBeNull();
  });

  it('EPG offset: channel, then list, then source', async () => {
    const sid = await addSource({ name: 'Zeitliste', epg_shift_min: 60 });
    const id = await addChannel(sid, { import_name: 'Kanal Wolkenlos', import_epg_shift_min: -90, epg_shift_override_min: 30 });
    const shift = async () => { const e = await effective(id); return [e.epgShiftMin, e.epgShiftFrom]; };
    expect(await shift()).toEqual([30, 'channel']);
    await q('update livetv_channels set epg_shift_override_min = null where id = $1', [id]);
    expect(await shift()).toEqual([-90, 'list']);
    await q('update livetv_channels set import_epg_shift_min = null where id = $1', [id]);
    expect(await shift()).toEqual([60, 'source']);
    await q('update livetv_sources set epg_shift_min = 0 where id = $1', [sid]);
    expect(await shift()).toEqual([0, 'none']);
    // an explicit 0 on the channel is still the channel's value
    await q('update livetv_channels set epg_shift_override_min = 0 where id = $1', [id]);
    expect(await shift()).toEqual([0, 'channel']);
  });

  it('push feeds and the SRT host', async () => {
    const manual = await addSource({ kind: 'manual', name: 'Studio', url_enc: null });
    const id = await addChannel(manual, { ...pushCreds(9005), import_name: 'Kinderinsel' });
    expect(await effective(id)).toMatchObject({ streamKind: 'srt', ingest: 'push', sourceId: manual });
    expect(srtHost(env.ctx)).toBe(new URL(env.ctx.cfg.PUBLIC_URL).hostname);
    const saved = env.ctx.cfg;
    env.ctx.cfg = { ...saved, LIVETV_SRT_HOST: 'srt.example.com' };
    try {
      expect(srtHost(env.ctx)).toBe('srt.example.com');
      // before setup PUBLIC_URL is '': no host, no throw; a set LIVETV_SRT_HOST still wins
      env.ctx.cfg = { ...saved, PUBLIC_URL: '', LIVETV_SRT_HOST: undefined };
      expect(srtHost(env.ctx)).toBeNull();
      env.ctx.cfg = { ...saved, PUBLIC_URL: '', LIVETV_SRT_HOST: '192.0.2.10' };
      expect(srtHost(env.ctx)).toBe('192.0.2.10');
    } finally { env.ctx.cfg = saved; }
  });
});

describe('settings', () => {
  it('settings group livetv only while installed', async () => {
    livetvUp = false;
    await detectLivetv(env.ctx, 0);
    const before = await settingsView(env.ctx);
    expect(before.groups.map((g) => g.id)).not.toContain('livetv');
    livetvUp = true;
    await detectLivetv(env.ctx, 0);
    const after = await settingsView(env.ctx);
    const group = after.groups.find((g) => g.id === 'livetv');
    expect(group?.items.map((i) => i.key)).toEqual(['LIVETV_ENCODER', 'LIVETV_SRT_HOST']);
    expect(group?.items[0]).toMatchObject({ kind: 'enum', value: 'auto', options: ['auto', 'qsv', 'vaapi', 'nvenc', 'software'] });
    expect(group?.items[1]).toMatchObject({ kind: 'string', set: false, value: null });
    livetvUp = false;
    await detectLivetv(env.ctx, 0);
  });
});
