// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The libraries with their ids (Live TV recordings, library mode): `/Library/VirtualFolders` as a real Jellyfin 12.4 answered it. After a
 * restart its ItemId was null for the libraries created on the server's first start (and stayed null); a library created later answered
 * one, also after the next restart; and with two libraries whose names differ only in case ("Filme", "filme") 12.4 answered the id of the
 * newer one for both. `/Library/MediaFolders` names the right CollectionFolder by exact name (it also lists the ManualPlaylistsFolder
 * "Playlists", which is no library). The fake's restart() simply forgets every ItemId. Ids and paths are fictional.
 */
import { describe, expect, it } from 'vitest';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { JellyfinService } from '../src/jellyfin/service.js';
import { MemoryKV } from '../src/kv.js';
import { keyFromBase64 } from '../src/crypto.js';
import { ENC_KEY, fakeHttp, type Call } from './helpers.js';

const hex = (c: string) => c.repeat(32);
const FILME = hex('1'), SERIEN = hex('2'), PL_LIB = hex('3'), PL_FOLDER = hex('4'), LOWER = hex('5'), AUFN = hex('6');

type Lib = { id: string; name: string; path: string; type?: string };

/** a stateful 12.4 fake: `restart()` forgets every ItemId; a library created afterwards answers its own */
function jellyfin124(libs: Lib[], opts: { mediaFolders500?: boolean } = {}) {
  const calls: Call[] = [];
  let known = new Set(libs.map((l) => l.id));
  const state = { libs: [...libs], restart: () => { known = new Set(); } };
  const itemIdOf = (l: Lib) => {
    if (!known.has(l.id)) return null;
    // 12.4 looks the library up by name without regard to case: the last one created of the same folded name wins
    return [...state.libs].reverse().find((o) => o.name.toLowerCase() === l.name.toLowerCase() && known.has(o.id))!.id;
  };
  const fetchImpl = fakeHttp({
    'GET /Library/VirtualFolders': () => ({ json: state.libs.map((l) => ({ Name: l.name, Locations: [l.path], CollectionType: 'homevideos', ItemId: itemIdOf(l) })) }),
    'GET /Library/MediaFolders': () => (opts.mediaFolders500 ? { status: 500 } : {
      json: { Items: [
        ...state.libs.map((l) => ({ Name: l.name, Id: l.id, Type: 'CollectionFolder', Path: `/config/root/default/${l.name}` })),
        { Name: 'Playlists', Id: PL_FOLDER, Type: 'ManualPlaylistsFolder', Path: '/config/data/playlists' },
      ] },
    }),
    'POST /Library/VirtualFolders': (u) => {
      const lib = { id: AUFN, name: u.searchParams.get('name')!, path: u.searchParams.get('paths')! };
      state.libs.push(lib);
      known.add(lib.id);
      return { status: 204 };
    },
  }, calls);
  const svc = new JellyfinService(new JellyfinClient('http://jf.test:8096', 'adminkey', fetchImpl), new MemoryKV(), keyFromBase64(ENC_KEY));
  return { svc, calls, state, mediaFolderCalls: () => calls.filter((c) => c.path === '/Library/MediaFolders').length };
}

const BASE: Lib[] = [{ id: FILME, name: 'Filme', path: '/media/filme' }, { id: SERIEN, name: 'Serien', path: '/media/serien' }];

describe('Jellyfin libraryFolders / createLibrary: the library ids', () => {
  it('a server that names every ItemId: those ids, and MediaFolders is not asked', async () => {
    const { svc, mediaFolderCalls } = jellyfin124(BASE);
    expect(await svc.admin.libraryFolders!()).toEqual([
      { id: FILME, name: 'Filme', paths: ['/media/filme'] }, { id: SERIEN, name: 'Serien', paths: ['/media/serien'] },
    ]);
    expect(mediaFolderCalls()).toBe(0);
  });

  it('after a restart (ItemId null) the ids come from the CollectionFolders of the same name, not from the playlists folder', async () => {
    const { svc, state } = jellyfin124([...BASE, { id: PL_LIB, name: 'Playlists', path: '/media/pl' }]);
    state.restart();
    expect(await svc.admin.libraryFolders!()).toEqual([
      { id: FILME, name: 'Filme', paths: ['/media/filme'] }, { id: SERIEN, name: 'Serien', paths: ['/media/serien'] },
      { id: PL_LIB, name: 'Playlists', paths: ['/media/pl'] },
    ]);
  });

  it('two libraries whose names differ only in case: each gets its own id, not the one 12.4 answers for both', async () => {
    const { svc } = jellyfin124([...BASE, { id: LOWER, name: 'filme', path: '/media/lower' }]);
    const folders = await svc.admin.libraryFolders!();
    expect(folders.find((f) => f.name === 'Filme')!.id).toBe(FILME);
    expect(folders.find((f) => f.name === 'filme')!.id).toBe(LOWER);
  });

  it('a library created after a restart answers its id', async () => {
    const { svc, state } = jellyfin124(BASE);
    state.restart();
    expect(await svc.admin.createLibrary!('Aufnahmen', '/media/aufnahmen', 'homevideos')).toEqual({ id: AUFN });
    expect((await svc.admin.libraryFolders!()).map((f) => f.id)).toEqual([FILME, SERIEN, AUFN]);
  });

  it('MediaFolders failing leaves the missing ids unknown: those libraries are left out, no error', async () => {
    const { svc, state } = jellyfin124(BASE, { mediaFolders500: true });
    expect((await svc.admin.libraryFolders!()).map((f) => f.id)).toEqual([FILME, SERIEN]);
    state.restart();
    expect(await svc.admin.libraryFolders!()).toEqual([]);
  });
});

describe('findItems / findItem: the library folders are read alongside the search, not after it', () => {
  /** a server whose search (or by-id lookup) answers only once the library folders have been asked for */
  function searchWaitsForFolders() {
    let asked!: () => void;
    const folders = new Promise<void>((r) => { asked = r; });
    const base = fakeHttp({
      'GET /Library/VirtualFolders': () => { asked(); return { json: [{ Name: 'Filme', Locations: ['/media/filme'], ItemId: null }] }; },
      'GET /Items': () => ({ json: { Items: [{ Id: hex('a'), Name: 'Wrenfield Pier', Type: 'Movie', Path: '/media/filme/Wrenfield Pier.mkv' }] } }),
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/Items') {
        await Promise.race([folders, new Promise((_, reject) => setTimeout(() => reject(new Error('the search waited for nothing: folders not asked')), 1000))]);
      }
      return base(input, init);
    }) as typeof fetch;
    return new JellyfinService(new JellyfinClient('http://jf.test:8096', 'adminkey', fetchImpl), new MemoryKV(), keyFromBase64(ENC_KEY));
  }
  it('findItems', async () => {
    expect(await searchWaitsForFolders().admin.findItems!('wren', 5)).toMatchObject([{ id: hex('a'), library: 'Filme' }]);
  });
  it('findItem', async () => {
    expect(await searchWaitsForFolders().admin.findItem!(hex('a'))).toMatchObject({ id: hex('a'), library: 'Filme' });
  });
});
