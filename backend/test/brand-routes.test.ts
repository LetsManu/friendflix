// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TOKENS, deriveTokens } from '../src/brand/colors.js';
import { DEFAULT_BRAND } from '../src/brand/schema.js';
import { encrypt } from '../src/crypto.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// Branding stage A, Task 1: the brand routes. The public one answers without a session and during setup and carries only the public
// fields; the admin ones validate, detect a stale rev, audit with field names only and keep images deduplicated by content hash.
type Sess = { cookies: Record<string, string>; csrf: string };
const DORA = { sub: 'sub-dora', email: 'dora@example.com', name: 'Dora', groups: [] as string[] };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** an RGB PNG of w × h pixels whose first byte is `seed` (different seeds: different images) plus an optional tEXt chunk */
function png(w: number, h: number, seed = 0, comment?: string): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = 8; d[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  raw[1] = seed;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', d), ...(comment ? [chunk('tEXt', Buffer.from(`Comment\0${comment}`))] : []),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** a lossy WebP of w × h: a VP8 key frame header (plus filler: only the header is parsed) */
function webp(w: number, h: number): Buffer {
  const d = Buffer.alloc(30);
  d.writeUIntLE(0x10 | (20 << 5), 0, 3);
  d[3] = 0x9d; d[4] = 0x01; d[5] = 0x2a;
  d.writeUInt16LE(w, 6);
  d.writeUInt16LE(h, 8);
  const body = Buffer.concat([Buffer.from('WEBPVP8 ', 'latin1'), Buffer.from([d.length, 0, 0, 0]), d]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([body.length, 0, 0, 0]), body]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PUBLIC_KEYS = ['name', 'byline', 'shortName', 'website', 'about', 'header', 'accent', 'glow', 'signInBg', 'logo', 'symbol', 'signInImage'].sort();

describe('brand routes', () => {
  let env: TestEnv;
  let admin: Sess;
  let dora: Sess;
  const as = (s: Sess | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    env.app.inject({ method: method as 'GET', url, ...(s ? { cookies: s.cookies } : {}), headers: { ...(s ? { 'x-csrf-token': s.csrf } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const upload = (s: Sess, kind: string, body: Buffer, type = 'image/png') => as(s, 'PUT', `/api/admin/brand/image/${kind}`, body, { 'content-type': type });
  const audits = async (action: string) => (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 order by id', [action])).rows;
  const current = async () => (await as(admin, 'GET', '/api/admin/brand')).json() as { rev: number; brand: typeof DEFAULT_BRAND };

  beforeAll(async () => {
    env = await makeEnv();
    admin = await env.login(ADMIN);
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-dora', 'dora@example.com', 'Dora', 'friend', $1, 'Dora', $2)", ['sub-dora'.padEnd(32, '0'), encrypt(env.ctx.encKey, 'pw')]);
    dora = await env.login(DORA);
  });
  afterAll(() => env.close());

  it('public GET without a session gives 200 and the defaults, with an ETag of the rev', async () => {
    const r = await env.app.inject('/api/public/brand');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toEqual({ rev: 0, brand: DEFAULT_BRAND, tokens: DEFAULT_TOKENS, images: {} });
    expect(r.headers.etag).toMatch(/^"brand-0-\w+"$/);
    expect(String(r.headers['cache-control'])).toMatch(/no-cache/);
    const again = await env.app.inject({ url: '/api/public/brand', headers: { 'if-none-match': String(r.headers.etag) } });
    expect([again.statusCode, again.body]).toEqual([304, '']);
  });

  it('a non-admin PUT gives 403 (and so do the other admin routes); no session gives 401', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/brand'], ['PUT', '/api/admin/brand', { rev: 0, brand: { name: 'Doraflix' } }], ['POST', '/api/admin/brand/reset', { rev: 0 }],
    ];
    for (const [m, url, body] of routes) {
      expect((await as(dora, m, url, body)).statusCode, `${m} ${url}`).toBe(403);
      expect((await as(null, m, url, body)).statusCode, `${m} ${url}`).toBe(401);
    }
    expect((await upload(dora, 'logo', png(4, 2))).statusCode).toBe(403);
    expect((await as(null, 'PUT', '/api/admin/brand/image/logo', png(4, 2), { 'content-type': 'image/png' })).statusCode).toBe(401);
    expect((await env.pool.query('select count(*)::int as n from brand_images')).rows[0].n).toBe(0);
    expect((await env.app.inject('/api/public/brand')).json().brand.name).toBe('FriendFlix');
  });

  it('an admin PUT saves, bumps the rev and writes the audit row with field names only', async () => {
    const r = await as(admin, 'PUT', '/api/admin/brand', { rev: 0, brand: { name: '  Kinoabend ', byline: 'by AetherSpire', accent: '#A37CFF', glow: 'neutral' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ rev: 1, brand: { ...DEFAULT_BRAND, name: 'Kinoabend', byline: 'by AetherSpire', accent: '#a37cff', glow: 'neutral' } });
    const a = await audits('brand.update');
    expect(a).toHaveLength(1);
    expect(a[0]!.meta).toEqual({ fields: ['accent', 'byline', 'glow', 'name'] });
    expect(JSON.stringify(a[0]!.meta)).not.toContain('Kinoabend');
    const pub = (await env.app.inject('/api/public/brand')).json();
    expect(pub.rev).toBe(1);
    expect(pub.brand.name).toBe('Kinoabend');
    expect(pub.tokens).toEqual(deriveTokens('#a37cff'));
    // the row keeps who saved it (never public)
    const row = (await env.pool.query('select rev, updated_by, updated_at from brand where id = 1')).rows[0];
    expect(row.rev).toBe('1');
    expect(row.updated_by).not.toBeNull();
    expect(row.updated_at).not.toBeNull();
    // the same values again: nothing changes, no new rev, no audit row
    const same = await as(admin, 'PUT', '/api/admin/brand', { rev: 1, brand: { name: 'Kinoabend' } });
    expect(same.json().rev).toBe(1);
    expect(await audits('brand.update')).toHaveLength(1);
  });

  it('a stale rev gives 409 brand_conflict and changes nothing', async () => {
    const before = await current();
    const r = await as(admin, 'PUT', '/api/admin/brand', { rev: before.rev - 1, brand: { name: 'Late' } });
    expect([r.statusCode, r.json().error]).toEqual([409, 'brand_conflict']);
    expect(r.json().rev).toBe(before.rev);
    expect((await current()).brand.name).toBe(before.brand.name);
  });

  it('an invalid name (empty, 25 chars, control chars) or a bad hex gives 400 with the field', async () => {
    const { rev } = await current();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: '' }, 'name'], [{ name: '   ' }, 'name'], [{ name: 'x'.repeat(25) }, 'name'], [{ name: 'Kino\u0007' }, 'name'], [{ name: 'Kino\nabend' }, 'name'],
      [{ name: 'Kino\u202eabend' }, 'name'],
      // invisible or format characters: a zero-width space, a Hangul filler, a BOM inside, line / paragraph separators, a tag
      // character, a soft hyphen; and a name with nothing visible (a combining mark alone, the blank braille pattern)
      [{ name: '\u200b' }, 'name'], [{ name: '\u3164' }, 'name'], [{ name: 'Ki\ufeffno' }, 'name'], [{ name: 'A\u2028B' }, 'name'], [{ name: 'A\u2029B' }, 'name'],
      [{ name: 'A\u{e0041}' }, 'name'], [{ name: 'Ki\u00adno' }, 'name'], [{ name: '\u0301' }, 'name'], [{ name: '\u2800' }, 'name'],
      [{ byline: 'by\u200bme' }, 'byline'], [{ shortName: '\u2066Kino' }, 'shortName'], [{ about: 'Zeile\u2028zwei' }, 'about'],
      [{ accent: '#ff4f6' }, 'accent'], [{ accent: 'red' }, 'accent'], [{ accent: '#ff4f6dzz' }, 'accent'],
      [{ byline: 'x'.repeat(33) }, 'byline'], [{ shortName: 'x'.repeat(13) }, 'shortName'], [{ about: 'x'.repeat(281) }, 'about'],
      [{ website: 'javascript:alert(1)' }, 'website'], [{ website: 'https://user:pw@example.com/' }, 'website'], [{ website: 'ftp://files.example.com/' }, 'website'],
      [{ header: 'banner' }, 'header'], [{ glow: 'rainbow' }, 'glow'], [{ signInBg: 'video' }, 'signInBg'],
      [{ logo: 'abc' }, 'logo'], [{ symbol: 'f'.repeat(64) }, 'symbol'], [{ updatedBy: 'x' }, 'updatedBy'],
    ];
    for (const [brand, field] of cases) {
      const r = await as(admin, 'PUT', '/api/admin/brand', { rev, brand });
      expect([r.statusCode, r.json()], JSON.stringify(brand)).toEqual([400, { error: 'invalid', field }]);
    }
    expect((await as(admin, 'PUT', '/api/admin/brand', { brand: { name: 'x' } })).statusCode).toBe(400);
    expect((await current()).rev).toBe(rev);
    // 24 characters (counted as characters, not UTF-16 units) and a website are fine
    const ok = await as(admin, 'PUT', '/api/admin/brand', { rev, brand: { name: '🎬'.repeat(24), website: 'https://kino.example.com/about', about: 'Zeile 1\nZeile 2' } });
    expect(ok.statusCode).toBe(200);
    // an emoji sequence keeps its joiner
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
    const zwj = await as(admin, 'PUT', '/api/admin/brand', { rev: rev + 1, brand: { name: `Kino ${family}` } });
    expect([zwj.statusCode, zwj.json().brand.name]).toEqual([200, `Kino ${family}`]);
    // the non-joiner of Persian and Indic names (Persian "Filmkhaneh" with U+200C), and a subdivision flag (Scotland: tag characters)
    const persian = '\u0641\u06cc\u0644\u0645\u200c\u062e\u0627\u0646\u0647';
    const scotland = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}';
    let r2 = zwj.json().rev as number;
    for (const name of [persian, `Kino ${scotland}`]) {
      const ok2 = await as(admin, 'PUT', '/api/admin/brand', { rev: r2, brand: { name } });
      expect([ok2.statusCode, ok2.json().brand.name], name).toEqual([200, name]);
      r2 = ok2.json().rev;
    }
    // tag characters anywhere else stay refused: alone, after another emoji, without the cancel tag
    for (const name of ['Kino\u{e0067}\u{e0062}', '\u{1f3ac}\u{e0067}\u{e007f}', '\u{1f3f4}\u{e0067}\u{e0062}']) {
      const bad = await as(admin, 'PUT', '/api/admin/brand', { rev: r2, brand: { name } });
      expect([bad.statusCode, bad.json()], name).toEqual([400, { error: 'invalid', field: 'name' }]);
    }
  });

  it('the website is stored as one canonical absolute URL', async () => {
    const cases: Array<[string, string]> = [
      ['http:example.com', 'http://example.com/'], ['HTTPS://Kino.Example.com', 'https://kino.example.com/'],
      ['https://example.com/"><script>', 'https://example.com/%22%3E%3Cscript%3E'], ['', ''],
    ];
    for (const [typed, stored] of cases) {
      const { rev } = await current();
      const r = await as(admin, 'PUT', '/api/admin/brand', { rev, brand: { website: typed } });
      expect([r.statusCode, r.json().brand.website], typed).toEqual([200, stored]);
      expect((await env.app.inject('/api/public/brand')).json().brand.website, typed).toBe(stored);
    }
  });

  it('an image upload stores the sanitized image, dedups by hash and does not set the brand', async () => {
    const before = await current();
    const src = png(4, 2, 1, 'secret comment');
    const r = await upload(admin, 'logo', src);
    expect(r.statusCode).toBe(200);
    const { hash, url, width, height } = r.json();
    expect([width, height]).toEqual([4, 2]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(sha(src));
    expect(url).toBe(`/api/public/brand/img/${hash}.png`);
    const again = await upload(admin, 'logo', png(4, 2, 1, 'another comment')); // the same pixels: the same sanitized bytes
    expect(again.json().hash).toBe(hash);
    expect((await env.pool.query('select count(*)::int as n from brand_images')).rows[0].n).toBe(1);
    const stored = (await env.pool.query('select bytes from brand_images where hash = $1', [hash])).rows[0].bytes as Buffer;
    expect(sha(stored)).toBe(hash);
    expect(stored.includes(Buffer.from('secret comment'))).toBe(false);
    expect((await current()).rev).toBe(before.rev);
    expect((await current()).brand.logo).toBeNull();
    expect((await audits('brand.image')).map((a) => a.meta)).toEqual([{ kind: 'logo' }]);
    // then the brand PUT sets it, and the public route lists its URL
    const set = await as(admin, 'PUT', '/api/admin/brand', { rev: before.rev, brand: { logo: hash, header: 'logo' } });
    expect(set.statusCode).toBe(200);
    const pub = (await env.app.inject('/api/public/brand')).json();
    expect(pub.brand.logo).toBe(hash);
    expect(pub.images).toEqual({ logo: url });
  });

  it('upload refusals: wrong type 415, a mismatch of declared and real type 415, > 2 MB 413, a bad kind 404, wrong size 400', async () => {
    expect((await upload(admin, 'logo', png(4, 2), 'image/jpeg')).statusCode).toBe(415);
    expect((await upload(admin, 'logo', png(4, 2), 'image/webp')).json()).toEqual({ error: 'unsupported_type' });
    expect((await upload(admin, 'logo', Buffer.from('<svg/>'), 'image/svg+xml')).statusCode).toBe(415);
    const big = await upload(admin, 'logo', Buffer.concat([png(4, 2), Buffer.alloc(3 * 1024 * 1024)]));
    expect([big.statusCode, big.json()]).toEqual([413, { error: 'too_large' }]);
    expect((await upload(admin, 'banner', png(4, 2))).statusCode).toBe(404);
    const sq = await upload(admin, 'symbol', png(300, 300));
    expect([sq.statusCode, sq.json()]).toEqual([400, { error: 'dimensions' }]);
    const poly = await upload(admin, 'logo', Buffer.concat([png(4, 2).subarray(0, 8), Buffer.from('<svg onload="alert(1)"/>')]));
    expect([poly.statusCode, poly.json()]).toEqual([400, { error: 'corrupt' }]);
    // the CSRF token is required
    expect((await env.app.inject({ method: 'PUT', url: '/api/admin/brand/image/logo', cookies: admin.cookies, headers: { 'content-type': 'image/png' }, payload: png(4, 2) })).statusCode).toBe(403);
  });

  it('an animated WebP upload is refused like any other type the brand does not take (415)', async () => {
    const frame = Buffer.alloc(16);
    frame.writeUIntLE(100, 12, 3);
    const lossless = Buffer.from([0x2f, 0, 0, 0, 0]); // a 1 × 1 VP8L header
    const sub = Buffer.concat([Buffer.from('VP8L', 'latin1'), Buffer.from([lossless.length, 0, 0, 0]), lossless, Buffer.alloc(1)]);
    const anmfData = Buffer.concat([frame, sub]);
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x02;
    const chunks = Buffer.concat([
      Buffer.from('VP8X', 'latin1'), Buffer.from([10, 0, 0, 0]), vp8x,
      Buffer.from('ANIM', 'latin1'), Buffer.from([6, 0, 0, 0]), Buffer.alloc(6),
      Buffer.from('ANMF', 'latin1'), Buffer.from([anmfData.length, 0, 0, 0]), anmfData,
    ]);
    const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunks]);
    const file = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([body.length, 0, 0, 0]), body]);
    const r = await upload(admin, 'logo', file, 'image/webp');
    expect([r.statusCode, r.json()]).toEqual([415, { error: 'unsupported_type' }]);
  });

  it('the brand writes need the CSRF token: PUT, reset and the image upload answer 403 without it and change nothing', async () => {
    const before = await current();
    const bare = (method: 'PUT' | 'POST', url: string, payload: object | Buffer, headers: Record<string, string> = {}) =>
      env.app.inject({ method, url, cookies: admin.cookies, headers, payload });
    const put = await bare('PUT', '/api/admin/brand', { rev: before.rev, brand: { name: 'Hafenkino' } });
    expect([put.statusCode, put.json()]).toEqual([403, { error: 'csrf' }]);
    const reset = await bare('POST', '/api/admin/brand/reset', { rev: before.rev });
    expect([reset.statusCode, reset.json()]).toEqual([403, { error: 'csrf' }]);
    const img = await bare('PUT', '/api/admin/brand/image/symbol', png(512, 512, 7), { 'content-type': 'image/png' });
    expect([img.statusCode, img.json()]).toEqual([403, { error: 'csrf' }]);
    // a wrong token is no better than none
    const wrong = await bare('PUT', '/api/admin/brand', { rev: before.rev, brand: { name: 'Hafenkino' } }, { 'x-csrf-token': 'x'.repeat(43) });
    expect(wrong.statusCode).toBe(403);
    expect(await current()).toEqual(before);
    const stored = await env.pool.query('select 1 from brand_images where hash = $1', [sha(png(512, 512, 7))]);
    expect(stored.rowCount).toBe(0);
  });

  it('a WebP upload is stored and served as WebP', async () => {
    const r = await upload(admin, 'symbol', webp(640, 640), 'image/webp');
    expect(r.statusCode).toBe(200);
    const { hash, url, width, height } = r.json();
    expect([width, height]).toEqual([640, 640]);
    expect(url).toBe(`/api/public/brand/img/${hash}.webp`);
    const img = await env.app.inject(url);
    expect([img.statusCode, img.headers['content-type']]).toEqual([200, 'image/webp']);
    expect(sha(img.rawPayload)).toBe(hash);
    expect((await env.app.inject(`/api/public/brand/img/${hash}.png`)).statusCode).toBe(404);
    expect((await upload(admin, 'symbol', webp(300, 300), 'image/webp')).json()).toEqual({ error: 'dimensions' });
  });

  it('a stored image of the wrong shape cannot be set as the symbol', async () => {
    const logo = (await upload(admin, 'logo', png(600, 200, 2))).json().hash as string;
    const { rev } = await current();
    const r = await as(admin, 'PUT', '/api/admin/brand', { rev, brand: { symbol: logo } });
    expect([r.statusCode, r.json()]).toEqual([400, { error: 'invalid', field: 'symbol' }]);
  });

  it('the image GET returns the bytes with the immutable cache, nosniff and the CSP; unknown or malformed names are 404', async () => {
    const up = (await upload(admin, 'symbol', png(512, 512, 3))).json();
    const r = await env.app.inject(up.url);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'");
    expect(sha(r.rawPayload)).toBe(up.hash);
    for (const bad of [`${up.hash}.webp`, `${'0'.repeat(64)}.png`, `${up.hash}.svg`, up.hash, `${up.hash.toUpperCase()}.png`, '..%2f..%2fetc.png']) {
      const n = await env.app.inject(`/api/public/brand/img/${bad}`);
      expect(n.statusCode, bad).toBe(404);
      expect(n.headers['cache-control'], bad).toBe('no-store');
    }
  });

  it('the public payload never contains updated_by (nor any other non-public field)', async () => {
    const r = await env.app.inject('/api/public/brand');
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(['brand', 'images', 'rev', 'tokens']);
    expect(Object.keys(body.brand).sort()).toEqual(PUBLIC_KEYS);
    const uid = (await env.pool.query('select updated_by from brand where id = 1')).rows[0].updated_by as string;
    expect(uid).toBeTruthy();
    expect(r.body).not.toContain(uid);
    expect(r.body).not.toMatch(/updated_?(by|at)/i);
    // a stray key in the stored JSON (an older or tampered row) never reaches the public answer
    await env.pool.query(`update brand set data = data || '{"secretNote":"admin-only"}'::jsonb where id = 1`);
    const r2 = await env.app.inject('/api/public/brand');
    expect(r2.body).not.toContain('admin-only');
    expect(Object.keys(r2.json().brand).sort()).toEqual(PUBLIC_KEYS);
  });

  it('unreferenced images are deleted on save once older than 1 hour; referenced and fresh ones stay', async () => {
    const old = (await upload(admin, 'logo', png(8, 2, 9))).json().hash as string;
    const fresh = (await upload(admin, 'logo', png(8, 2, 10))).json().hash as string;
    const { rev, brand: b } = await current();
    expect(b.logo).toMatch(/^[0-9a-f]{64}$/);
    // everything but `fresh` is two hours old: the referenced logo stays, the unreferenced `old` goes, `fresh` stays by its age
    await env.pool.query("update brand_images set created_at = now() - interval '2 hours' where hash <> $1", [fresh]);
    expect((await as(admin, 'PUT', '/api/admin/brand', { rev, brand: { byline: 'gc' } })).statusCode).toBe(200);
    const left = (await env.pool.query<{ hash: string }>('select hash from brand_images')).rows.map((r) => r.hash);
    expect(left).toContain(b.logo);
    expect(left).toContain(fresh);
    expect(left).not.toContain(old);
  });

  it('an upload also cleans up unreferenced images older than 1 hour; the referenced logo and fresh uploads stay', async () => {
    const stale = (await upload(admin, 'logo', png(8, 2, 20))).json().hash as string;
    const { brand: b } = await current();
    expect(b.logo).toMatch(/^[0-9a-f]{64}$/);
    await env.pool.query("update brand_images set created_at = now() - interval '2 hours'");
    const fresh = (await upload(admin, 'logo', png(8, 2, 21))).json().hash as string;
    const left = (await env.pool.query<{ hash: string }>('select hash from brand_images')).rows.map((r) => r.hash);
    expect(left.sort()).toEqual([b.logo!, fresh].sort());
    expect(left).not.toContain(stale);
  });

  it('a reset with a stale rev gives 409 brand_conflict and changes nothing; no rev is a bad request', async () => {
    const before = await current();
    expect(before.brand.name).not.toBe(DEFAULT_BRAND.name);
    const r = await as(admin, 'POST', '/api/admin/brand/reset', { rev: before.rev - 1 });
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'brand_conflict', rev: before.rev }]);
    expect((await as(admin, 'POST', '/api/admin/brand/reset', {})).json()).toEqual({ error: 'bad_request' });
    expect(await current()).toEqual(before);
    expect(await audits('brand.reset')).toHaveLength(0);
  });

  it('reset gives the defaults, bumps the rev and audits brand.reset with the field names', async () => {
    const { rev } = await current();
    const r = await as(admin, 'POST', '/api/admin/brand/reset', { rev });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ rev: rev + 1, brand: DEFAULT_BRAND });
    const pub = (await env.app.inject('/api/public/brand')).json();
    expect(pub).toEqual({ rev: rev + 1, brand: DEFAULT_BRAND, tokens: DEFAULT_TOKENS, images: {} });
    const a = await audits('brand.reset');
    expect(a).toHaveLength(1);
    expect(a[0]!.meta.fields).toEqual(expect.arrayContaining(['name', 'logo', 'byline']));
  });
});

describe('public brand passes the setup gate', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv({}, { setupComplete: false }); });
  afterAll(() => env.close());

  it('an instance in setup mode answers the public brand and its images; the admin routes stay gated', async () => {
    expect((await env.app.inject('/api/me')).statusCode).toBe(503);
    const r = await env.app.inject('/api/public/brand');
    expect(r.statusCode).toBe(200);
    expect(r.json().brand).toEqual(DEFAULT_BRAND);
    expect((await env.app.inject(`/api/public/brand/img/${'0'.repeat(64)}.png`)).statusCode).toBe(404);
    expect((await env.app.inject('/api/admin/brand')).json()).toEqual({ error: 'setup_required' });
    expect((await env.app.inject({ method: 'POST', url: '/api/public/brand' })).statusCode).toBe(503);
  });
});
