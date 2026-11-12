// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanDeviceName } from '../src/deviceName.js';
import { makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
afterEach(async () => { const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

// shared with the web form (web reads the same file)
const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/device-names.json', import.meta.url), 'utf8')) as { input: string; ok: boolean; normalized?: string | null }[];

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const rename = (s: Sess, id: string, name: unknown) => call(s, 'PATCH', `/api/devices/${id}`, { name });
const sessOf = async (s: Sess) => JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!) as { userId: string; deviceId: string };

describe('cleanDeviceName (shared vectors)', () => {
  it('matches every vector', () => {
    for (const v of vectors) {
      const r = cleanDeviceName(v.input);
      expect(r.ok, JSON.stringify(v.input)).toBe(v.ok);
      if (v.ok && r.ok) expect(r.name, JSON.stringify(v.input)).toBe(v.normalized ?? null);
    }
    expect(cleanDeviceName(null)).toEqual({ ok: true, name: null });
    expect(cleanDeviceName(5)).toEqual({ ok: false });
  });
});

describe('PATCH /api/devices/:id', () => {
  it('renames the own device and lists it', async () => {
    env = await makeEnv();
    const s = await env.login();
    const { deviceId } = await sessOf(s);
    const before = (await call(s, 'GET', '/api/devices')).json().devices[0];
    const r = await rename(s, deviceId, '  Wohnzimmer  ');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, name: 'Wohnzimmer' });
    const row = (await call(s, 'GET', '/api/devices')).json().devices[0];
    expect(row).toMatchObject({ name: 'Wohnzimmer', label: before.label });
    expect(row.kind).toBe('web'); // light-my-request's default user agent
  });

  it('blank or null resets', async () => {
    env = await makeEnv();
    const s = await env.login();
    const { deviceId } = await sessOf(s);
    await rename(s, deviceId, 'Wohnzimmer');
    expect((await rename(s, deviceId, '   ')).json()).toEqual({ ok: true, name: null });
    await rename(s, deviceId, 'Wohnzimmer');
    expect((await rename(s, deviceId, null)).json()).toEqual({ ok: true, name: null });
    expect((await call(s, 'GET', '/api/devices')).json().devices[0].name).toBeNull();
  });

  it('refuses invalid names, keeps emoji', async () => {
    env = await makeEnv();
    const s = await env.login();
    const { deviceId } = await sessOf(s);
    for (const bad of ['a'.repeat(41), 'Wohn\u0000zimmer', 'a\tb', '\u202eevil', '\u2066x', '\ud800', '\u200e', '📺'.repeat(41)]) {
      const r = await rename(s, deviceId, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json()).toEqual({ error: 'invalid_name' });
    }
    for (const good of ['Wohnzimmer 📺', '👨\u200d👩\u200d👧 Familie', '📺'.repeat(40)]) expect((await rename(s, deviceId, good)).statusCode).toBe(200);
    expect((await rename(s, deviceId, 'Wohn   zimmer')).json()).toEqual({ ok: true, name: 'Wohn zimmer' });
  });

  it('a foreign or missing device is 404', async () => {
    env = await makeEnv();
    const s = await env.login();
    const other = (await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-x', 'x@example.com', 'Xaver', 'friend', $1, 'xaver', 'x') returning id", ['x'.repeat(32)])).rows[0].id;
    await env.pool.query('insert into devices (user_id, device_id, label, approved) values ($1, $2, $3, true)', [other, 'dev-foreign-000000000001', 'Fremd']);
    for (const id of ['dev-foreign-000000000001', 'dev-unknown-00000000001']) {
      const r = await rename(s, id, 'Wohnzimmer');
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: 'not_found' });
    }
    expect((await env.pool.query("select name from devices where device_id='dev-foreign-000000000001'")).rows).toEqual([{ name: null }]);
  });

  it('kids profiles cannot rename', async () => {
    env = await makeEnv();
    const s = await env.login();
    const { deviceId, userId } = await sessOf(s);
    await env.pool.query('update profiles set kids = true where user_id = $1', [userId]); // the session's profile becomes a kids profile
    const r = await rename(s, deviceId, 'Wohnzimmer');
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'kids_profile' });
  });

  it('audited without the name', async () => {
    env = await makeEnv();
    const s = await env.login();
    const { deviceId, userId } = await sessOf(s);
    await rename(s, deviceId, 'Wohnzimmer');
    const a = await env.pool.query("select actor, target, meta from audit_log where action='device.rename'");
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ actor: userId, target: userId });
    expect(JSON.stringify(a.rows[0].meta)).not.toContain('Wohnzimmer');
  });

  it('admin views and the export show the custom name', async () => {
    env = await makeEnv();
    const s = await env.login(); // the first user is the admin of the test instance
    const { deviceId, userId } = await sessOf(s);
    await rename(s, deviceId, 'Wohnzimmer');
    const list = await call(s, 'GET', '/api/admin/devices?q=Wohnzimmer');
    expect(list.statusCode).toBe(200);
    expect(list.json().devices.map((d: { label: string }) => d.label)).toEqual(['Wohnzimmer']);
    const detail = await call(s, 'GET', `/api/admin/users/${userId}`);
    expect(JSON.stringify(detail.json().devices)).toContain('Wohnzimmer');
    const exp = await env.app.inject({ method: 'GET', url: '/api/account/export', cookies: s.cookies });
    expect(JSON.parse(exp.body).devices[0]).toMatchObject({ name: 'Wohnzimmer' });
  });
});
