// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { baseCodeLogLine, hashBaseCode, newBaseCode, normalizeBaseCode } from '../src/mediaserver/code.js';
import { parseMediaBody } from '../src/mediaserver/parse.js';
import { checkBasePath, isRel, isTarget, nestedFolders } from '../src/mediaserver/paths.js';

const none = { dockerRoot: null, stackDir: null };
const spec = (over: Record<string, unknown> = {}) => ({
  kind: 'jellyfin', folders: [{ rel: 'Filme', target: '/media/filme' }], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: false, tz: 'Europe/Berlin', ...over,
});
const pw = 'A'.repeat(43);

describe('media body parsing', () => {
  it('parses every op exactly', () => {
    const s = spec();
    const bodies: unknown[] = [
      { op: 'base-request', path: '/srv/media' }, { op: 'base-confirm', code: 'K7QM-2D9X-HT4R' }, { op: 'base-clear' },
      { op: 'browse', rel: '' }, { op: 'browse', rel: 'Filme/Kinder' }, { op: 'gpu' }, { op: 'logs', tail: 50 }, { op: 'logs', tail: 500 },
      { op: 'apply', spec: s }, { op: 'apply', spec: spec({ kind: 'ferrofin', mediaGid: 44, gpu: 'dri', egress: true, tz: 'UTC', folders: [] }), firstRun: { password: pw } },
      { op: 'finish-setup' }, { op: 'start' }, { op: 'stop' }, { op: 'restart' }, { op: 'update' },
      { op: 'hdr-test', kind: 'ferrofin' }, { op: 'backup', trickplay: true }, { op: 'restore', id: 'jellyfin-20261117-1432-10.11.4' },
      { op: 'remove', data: false },
    ];
    for (const b of bodies) expect(parseMediaBody(b)).toEqual(b);
  });

  it('firstRun only with ferrofin', () => {
    expect(parseMediaBody({ op: 'apply', spec: spec({ kind: 'jellyfin' }), firstRun: { password: pw } })).toBeNull();
    expect(parseMediaBody({ op: 'apply', spec: spec({ kind: 'ferrofin' }), firstRun: { password: 'A'.repeat(42) } })).toBeNull();
    expect(parseMediaBody({ op: 'apply', spec: spec({ kind: 'ferrofin' }), firstRun: { password: pw, x: 1 } })).toBeNull();
  });

  it('refuses malformed bodies', () => {
    for (const b of [
      { op: 'start', x: 1 }, { op: 'logs', tail: 49 }, { op: 'logs', tail: 501 }, { op: 'logs', tail: '300' }, { op: 'logs', tail: 300.5 },
      { op: 'remove' }, { op: 'restore', id: '../x' }, { op: 'nope' }, { op: 'apply' }, { op: 'browse', rel: '../x' }, { op: 'browse', rel: 'a/b/c/d' },
      { op: 'hdr-test', kind: 'plex' }, { op: 'backup', trickplay: 'yes' }, { op: 'base-request', path: 5 },
      [], [{ op: 'gpu' }], null, 'gpu', 5, undefined,
    ]) expect(parseMediaBody(b)).toBeNull();
  });

  it('refuses a bad spec', () => {
    const bad: Record<string, unknown>[] = [
      { uid: 0 }, { gid: 65536 }, { uid: 1.5 }, { mediaGid: 0 }, { tz: 'Europe/Berlin;rm' }, { gpu: 'amd' }, { kind: 'plex' }, { egress: 'no' },
      { folders: Array.from({ length: 21 }, (_, i) => ({ rel: `f${i}`, target: `/media/f${i}` })) },
      { folders: [{ rel: 'a', target: '/media/x' }, { rel: 'b', target: '/media/x' }] },
      { folders: [{ rel: 'a', target: '/media/x' }, { rel: 'a', target: '/media/y' }] },
      { folders: [{ rel: 'a', target: '/media/x', extra: 1 }] }, { folders: [{ rel: 'a' }] }, { folders: [{ rel: '../a', target: '/media/x' }] },
      { folders: [{ rel: 'a', target: '/data/x' }] }, { folders: 'x' },
    ];
    for (const o of bad) expect(parseMediaBody({ op: 'apply', spec: spec(o) }), JSON.stringify(o)).toBeNull();
    expect(parseMediaBody({ op: 'apply', spec: { ...spec(), extra: 1 } })).toBeNull();
    const { mediaGid: _m, ...missing } = spec();
    expect(parseMediaBody({ op: 'apply', spec: missing })).toBeNull();
  });

  it('accepts 20 folders and valid time zones', () => {
    const folders = Array.from({ length: 20 }, (_, i) => ({ rel: `f${i}`, target: `/media/f${i}` }));
    expect(parseMediaBody({ op: 'apply', spec: spec({ folders }) })).not.toBeNull();
    for (const tz of ['America/Argentina/Buenos_Aires', 'UTC']) expect(parseMediaBody({ op: 'apply', spec: spec({ tz }) })).not.toBeNull();
  });
});

describe('media paths', () => {
  it('base path syntax', () => {
    for (const p of ['/srv/media', '/mnt/nas/Filme & Serien', '/volume1/Medien (alt)', '/srv/médias', "/srv/media's"]) expect(checkBasePath(p, none), p).toBeNull();
    for (const p of ['srv/media', '/srv/media/', '/srv//media', '/srv/./media', '/srv/../etc', '/srv/.hidden', '/srv/media$x', '', '/' + 'a'.repeat(200)]) expect(checkBasePath(p, none), p).toBe('path_invalid');
  });

  it('refused bases', () => {
    for (const p of ['/', '/etc', '/etc/x', '/lib64/x', '/usr/share/media', '/var/run', '/var/lib/docker/volumes', '/home', '/var', '/opt', '/mnt', '/media', '/srv', '/volume1']) expect(checkBasePath(p, none), p).toBe('path_refused');
    for (const p of ['/home/anna/Filme', '/mnt/nas', '/srv/media', '/volume1/video', '/var/media', '/etcetera/x']) expect(checkBasePath(p, none), p).toBeNull();
  });

  it('refuses a path around the Docker root and accepts one below the stack dir', () => {
    const f = { dockerRoot: '/data/docker', stackDir: '/srv/friendflix' };
    for (const p of ['/data', '/data/docker', '/data/docker/volumes', '/srv', '/srv/friendflix']) expect(checkBasePath(p, f), p).toBe('path_refused');
    for (const p of ['/srv/friendflix/media', '/data/dockerx', '/data/other']) expect(checkBasePath(p, f), p).toBeNull();
  });

  it('folder rules', () => {
    expect(isRel('Filme', 1, 3)).toBe(true);
    expect(isRel('Serien/Kinder/Neu', 1, 3)).toBe(true);
    for (const r of ['', 'a/b/c/d', '/Filme', 'Filme/', '.cache', 'a/../b', 'a//b', 'a'.repeat(201)]) expect(isRel(r, 1, 3), r).toBe(false);
    expect(isRel('', 0, 2)).toBe(true);
    expect(nestedFolders(['Filme', 'Filme/Kinder'])).toBe(true);
    expect(nestedFolders(['Filme', 'Filmeklassiker'])).toBe(false);
    expect(isTarget('/media/filme')).toBe(true);
    expect(isTarget('/media/a/b/c')).toBe(true);
    for (const t of ['/media', '/data/x', '/media/../data', '/media/Filme', '/media/a/b/c/d', '/media/']) expect(isTarget(t), t).toBe(false);
  });
});

describe('base code', () => {
  it('generates well-formed codes with a matching hash', () => {
    const re = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
    for (let i = 0; i < 1000; i++) {
      const { display, hash } = newBaseCode();
      expect(display).toMatch(re);
      expect(hash).toBe(hashBaseCode(normalizeBaseCode(display)));
    }
  });

  it('normalises like the setup code', () => {
    expect(normalizeBaseCode('k7qm 2d9x-ht4r')).toBe('K7QM2D9XHT4R');
    expect(normalizeBaseCode('oil')).toBe('011');
    expect(hashBaseCode('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('the log line', () => {
    expect(baseCodeLogLine('/srv/media', 'K7QM-2D9X-HT4R', new Date('2026-11-17T14:32:10Z'))).toBe('FriendFlix media folder: to allow /srv/media as the media base folder, enter the code K7QM-2D9X-HT4R in Admin (valid until 14:32 UTC).');
  });
});
