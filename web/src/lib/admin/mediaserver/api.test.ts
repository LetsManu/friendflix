// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setCsrf } from '#lib/api';
import { adminMediaApi, encodePassphrase, PASSPHRASE_HEADER, pickSaveTarget, setupMediaApi, type SaveTarget } from './api';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let answer: () => Response = () => new Response('{}', { status: 200 });

beforeEach(() => {
  calls = [];
  answer = () => new Response('{}', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return answer(); }));
  vi.stubGlobal('document', { cookie: 'ff_setup_csrf=setup%2Btok', createElement: () => ({ click: vi.fn(), remove: vi.fn() }), body: { append: vi.fn() } });
  setCsrf('app-tok');
});
afterEach(() => { vi.unstubAllGlobals(); });

const headers = (c: Call) => c.init.headers as Record<string, string>;
const body = (c: Call) => (c.init.body ? JSON.parse(String(c.init.body)) : undefined);

describe('media server API', () => {
  it('admin and setup APIs call their paths with their CSRF header', async () => {
    answer = () => new Response(JSON.stringify({ status: { job: { id: 'j1', action: 'mediaserver-apply' } }, present: true }), { status: 200 });
    await adminMediaApi.view();
    await adminMediaApi.requestBase('/srv/media');
    await adminMediaApi.confirmBase('ABCD-EFGH-JKMN');
    await adminMediaApi.clearBase();
    await adminMediaApi.browse('Filme');
    await adminMediaApi.gpu();
    await adminMediaApi.apply({ kind: 'jellyfin', folders: [{ rel: 'Filme', name: 'Filme', type: 'movies' }], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true });
    await adminMediaApi.action({ op: 'restart' });
    await adminMediaApi.logs(300);
    await adminMediaApi.libraries();
    await adminMediaApi.deleteLibrary('filme');
    await adminMediaApi.mode(false);
    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/admin/mediaserver', 'POST /api/admin/mediaserver/base', 'POST /api/admin/mediaserver/base/confirm', 'DELETE /api/admin/mediaserver/base',
      'POST /api/admin/mediaserver/browse', 'POST /api/admin/mediaserver/gpu', 'POST /api/admin/mediaserver/apply', 'POST /api/admin/mediaserver/action',
      'POST /api/admin/mediaserver/logs', 'GET /api/admin/mediaserver/libraries', 'DELETE /api/admin/mediaserver/libraries/filme', 'POST /api/admin/mediaserver/mode',
    ]);
    for (const c of calls) expect(headers(c)['x-csrf-token']).toBe('app-tok');
    expect(body(calls[1]!)).toEqual({ path: '/srv/media' });
    expect(body(calls[8]!)).toEqual({ tail: 300 });
    expect(body(calls[11]!)).toEqual({ mode: 'external', restore: false });
    expect(adminMediaApi.scope).toBe('admin');

    // the last job: only a media job counts
    expect(await adminMediaApi.lastJob()).toMatchObject({ id: 'j1' });
    answer = () => new Response(JSON.stringify({ present: true, status: { job: { id: 'u', action: 'update' } } }), { status: 200 });
    expect(await adminMediaApi.lastJob()).toBeNull();
    answer = () => new Response(JSON.stringify({ present: false }), { status: 200 });
    expect(await adminMediaApi.lastJob()).toBeNull();

    calls = [];
    answer = () => new Response('{"pending":true}', { status: 200 });
    const s = setupMediaApi();
    expect(s.scope).toBe('setup');
    await s.view();
    await s.requestBase('/srv/media');
    await s.confirmBase('ABCD');
    await s.browse('');
    await s.gpu();
    await s.apply({ kind: 'ferrofin', folders: [], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: 44, egress: false });
    await s.action({ op: 'retry' });
    expect(await s.lastJob()).toBeNull();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/setup/mediaserver', 'POST /api/setup/mediaserver/base', 'POST /api/setup/mediaserver/base/confirm', 'POST /api/setup/mediaserver/browse',
      'POST /api/setup/mediaserver/gpu', 'POST /api/setup/mediaserver/apply', 'POST /api/setup/mediaserver/action',
    ]);
    // the GET carries no CSRF header, every write the setup one (never the app's)
    expect(headers(calls[0]!)['x-ff-setup-csrf']).toBeUndefined();
    for (const c of calls.slice(1)) { expect(headers(c)['x-ff-setup-csrf']).toBe('setup+tok'); expect(headers(c)['x-csrf-token']).toBeUndefined(); }
    // what the wizard has no route for is refused before anything is sent
    calls = [];
    for (const p of [s.clearBase(), s.logs(300), s.libraries(), s.deleteLibrary('x'), s.mode(true), s.download('x', 'p'), s.upload(new File([], 'x'), 'p')]) {
      await expect(p).rejects.toMatchObject({ body: { error: 'not_supported' } });
    }
    expect(calls).toEqual([]);
    // a refusal is an ApiError with the code (a proxy page without JSON: an empty body)
    answer = () => new Response('{"error":"busy"}', { status: 409 });
    await expect(s.apply({ kind: 'ferrofin', folders: [], uid: 1, gid: 1, gpu: 'off', mediaGid: null, egress: true })).rejects.toMatchObject({ status: 409, body: { error: 'busy' } });
    answer = () => new Response('<html>', { status: 502 });
    await expect(s.view()).rejects.toBeInstanceOf(ApiError);
  });

  it('download prefers showSaveFilePicker and falls back to a Blob link', async () => {
    const written: Uint8Array[] = [];
    const picker = vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>({ write: (c) => { written.push(c); } }) }));
    vi.stubGlobal('showSaveFilePicker', picker);
    answer = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    await adminMediaApi.download('jellyfin-20261117-1030-10.11.0', 'Ein langer Satz');
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'jellyfin-20261117-1030-10.11.0.tar.gz.age' });
    expect(written.flatMap((c) => [...c])).toEqual([1, 2, 3]);
    expect(calls[0]!.url).toBe('/api/admin/mediaserver/backups/jellyfin-20261117-1030-10.11.0/download');
    expect(headers(calls[0]!)[PASSPHRASE_HEADER]).toBe(encodePassphrase('Ein langer Satz'));
    expect(headers(calls[0]!)['x-csrf-token']).toBe('app-tok');

    // no picker: a Blob behind an object URL, clicked once as a download link
    vi.stubGlobal('showSaveFilePicker', undefined);
    const link = { click: vi.fn(), remove: vi.fn(), href: '', download: '', rel: '' };
    const append = vi.fn();
    vi.stubGlobal('document', { createElement: () => link, body: { append } });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      await adminMediaApi.download('ferrofin-20261117-1030-10.11.0', 'Ein langer Satz');
      expect(create).toHaveBeenCalledOnce();
      expect(link).toMatchObject({ href: 'blob:x', download: 'ferrofin-20261117-1030-10.11.0.tar.gz.age' });
      expect(link.click).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledWith(link);
      vi.advanceTimersByTime(60_000);
      expect(revoke).toHaveBeenCalledWith('blob:x');
    } finally {
      vi.useRealTimers();
      create.mockRestore();
      revoke.mockRestore();
    }

    // a refusal: its code, nothing saved
    answer = () => new Response('{"error":"invalid_passphrase"}', { status: 400 });
    await expect(adminMediaApi.download('ferrofin-20261117-1030-10.11.0', 'x')).rejects.toMatchObject({ status: 400, body: { error: 'invalid_passphrase' } });
  });

  it('download into a picked file: the target is asked once and reused, a refusal or a broken stream leaves no file', async () => {
    const target = (opts: { breaks?: boolean } = {}) => {
      const t = { writable: vi.fn(), remove: vi.fn(async () => undefined), aborted: false };
      const handle: SaveTarget = {
        createWritable: async () => { t.writable(); return new WritableStream<Uint8Array>({ abort: () => { t.aborted = true; } }); },
        remove: t.remove,
      };
      if (opts.breaks) answer = () => new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error('cut')) }), { status: 200 });
      return { t, handle };
    };
    const picker = vi.fn();
    vi.stubGlobal('showSaveFilePicker', picker);
    // a target handed in: no second picker (a retry after a fresh sign-in has no user activation)
    const ok = target();
    answer = () => new Response(new Uint8Array([1]), { status: 200 });
    await adminMediaApi.download('jellyfin-20261117-1030-10.11.0', 'Ein langer Satz', ok.handle);
    expect(picker).not.toHaveBeenCalled();
    expect(ok.t.writable).toHaveBeenCalledOnce();
    expect(ok.t.remove).not.toHaveBeenCalled();
    // refused (a fresh sign-in needed, a wrong passphrase): nothing written, the picked file removed
    const refused = target();
    answer = () => new Response('{"error":"reauth_required"}', { status: 401 });
    await expect(adminMediaApi.download('jellyfin-20261117-1030-10.11.0', 'Ein langer Satz', refused.handle)).rejects.toMatchObject({ status: 401 });
    expect(refused.t.writable).not.toHaveBeenCalled();
    expect(refused.t.remove).toHaveBeenCalledOnce();
    // the stream breaks halfway: the writable is aborted (nothing kept) and the file removed
    const broken = target({ breaks: true });
    await expect(adminMediaApi.download('jellyfin-20261117-1030-10.11.0', 'Ein langer Satz', broken.handle)).rejects.toThrow();
    expect(broken.t.aborted).toBe(true);
    expect(broken.t.remove).toHaveBeenCalledOnce();
    // a browser without remove(): the error still arrives
    const old = target();
    delete (old.handle as { remove?: unknown }).remove;
    answer = () => new Response('{"error":"backup_invalid"}', { status: 400 });
    await expect(adminMediaApi.download('x', 'Ein langer Satz', old.handle)).rejects.toMatchObject({ body: { error: 'backup_invalid' } });
  });

  it('pickSaveTarget asks with the file name, null without a picker; a cancel rejects as AbortError', async () => {
    const handle = { createWritable: vi.fn() };
    const picker = vi.fn(async () => handle);
    vi.stubGlobal('showSaveFilePicker', picker);
    expect(await pickSaveTarget('ferrofin-20261117-1030-10.11.0')).toBe(handle);
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'ferrofin-20261117-1030-10.11.0.tar.gz.age' });
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); }));
    await expect(pickSaveTarget('x')).rejects.toMatchObject({ name: 'AbortError' });
    vi.stubGlobal('showSaveFilePicker', undefined);
    expect(await pickSaveTarget('x')).toBeNull();
  });

  it('upload sends the file as octet-stream with the passphrase header', async () => {
    const pass = 'zażółć gęślą jaźń';
    // base64url of the UTF-8 bytes, no padding (backend decodePassphrase: Buffer.from(p, 'utf8').toString('base64url'))
    const want = btoa(String.fromCharCode(...new TextEncoder().encode(pass))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(encodePassphrase(pass)).toBe(want);
    expect(encodePassphrase(pass)).toMatch(/^[A-Za-z0-9_-]+$/);
    answer = () => new Response(JSON.stringify({ backup: { id: 'b' }, job: { id: 'j' } }), { status: 202 });
    const file = new File([new Uint8Array([9, 9])], 'sicherung.tar.gz.age', { type: '' });
    expect(await adminMediaApi.upload(file, pass)).toEqual({ backup: { id: 'b' }, job: { id: 'j' } });
    const c = calls[0]!;
    expect(c.url).toBe('/api/admin/mediaserver/backups/upload');
    expect(c.init.method).toBe('POST');
    expect(c.init.body).toBe(file);
    expect(headers(c)).toMatchObject({ 'content-type': 'application/octet-stream', [PASSPHRASE_HEADER]: want, 'x-csrf-token': 'app-tok' });
    // a refused restore after a good upload: the code (the backup is kept, the card reloads the list)
    answer = () => new Response('{"error":"busy","backup":{"id":"b"}}', { status: 409 });
    await expect(adminMediaApi.upload(file, pass)).rejects.toMatchObject({ status: 409, body: { error: 'busy' } });
  });
});
