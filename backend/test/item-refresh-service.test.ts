// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * *Neu einlesen* on the detail page (admin): the Jellyfin / Ferrofin query of each mode (`POST /Items/{id}/Refresh`, as jellyfin-web's
 * refresh dialog sends it), the admin-key kind lookup, and the capability the web reads. Ids are fictional.
 */
import { describe, expect, it } from 'vitest';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { JELLYFIN_CAPABILITIES, JellyfinService } from '../src/jellyfin/service.js';
import { MemoryKV } from '../src/kv.js';
import { keyFromBase64 } from '../src/crypto.js';
import { MediaError, publicCapabilities, REFRESH_MODES } from '../src/media/types.js';
import { ENC_KEY, fakeHttp, type Call } from './helpers.js';

const SERIES = '5'.repeat(32), SEASON = '6'.repeat(32), GONE = '0'.repeat(32), BROKEN = 'e'.repeat(32);

function server() {
  const calls: Call[] = [];
  const fetchImpl = fakeHttp({
    'POST /Items/[0-9a-f]+/Refresh': (u) => {
      const id = u.pathname.split('/')[2];
      return { status: id === GONE ? 404 : id === BROKEN ? 500 : 204 };
    },
    'GET /Items': (u) => {
      const id = u.searchParams.get('ids');
      if (id === BROKEN) return { status: 500 };
      return { json: { Items: id === SERIES ? [{ Id: SERIES, Name: 'Serie', Type: 'Series' }] : id === SEASON ? [{ Id: SEASON, Name: 'Staffel 1', Type: 'Season' }] : [] } };
    },
  }, calls);
  const svc = new JellyfinService(new JellyfinClient('http://jf.test:8096', 'adminkey', fetchImpl), new MemoryKV(), keyFromBase64(ENC_KEY));
  return { svc, calls };
}

describe('Jellyfin refreshItem: the query of each mode', () => {
  const want = {
    scan: { recursive: 'true', metadataRefreshMode: 'Default', imageRefreshMode: 'Default', replaceAllMetadata: 'false', replaceAllImages: 'false' },
    missing: { recursive: 'true', metadataRefreshMode: 'FullRefresh', imageRefreshMode: 'FullRefresh', replaceAllMetadata: 'false', replaceAllImages: 'false' },
    replace: { recursive: 'true', metadataRefreshMode: 'FullRefresh', imageRefreshMode: 'FullRefresh', replaceAllMetadata: 'true', replaceAllImages: 'true' },
  } as const;

  it('knows exactly the three modes', () => {
    expect([...REFRESH_MODES]).toEqual(['scan', 'missing', 'replace']);
  });

  for (const mode of REFRESH_MODES) {
    it(`${mode}: POST /Items/<id>/Refresh with the admin key and the mode's flags`, async () => {
      const { svc, calls } = server();
      await svc.refreshItem!(SERIES, mode);
      expect(calls).toHaveLength(1);
      const c = calls[0]!;
      expect(c).toMatchObject({ method: 'POST', path: `/Items/${SERIES}/Refresh` });
      expect(Object.fromEntries(new URLSearchParams(c.search))).toEqual(want[mode]);
      expect(c.auth).toContain('Token="adminkey"');
    });
  }

  it('an unknown id is MediaError(404); any other failure MediaError(502) whose message names no URL or key', async () => {
    const { svc } = server();
    const gone = await svc.refreshItem!(GONE, 'scan').catch((e) => e);
    expect(gone).toBeInstanceOf(MediaError);
    expect(gone.status).toBe(404);
    const broken = await svc.refreshItem!(BROKEN, 'replace').catch((e) => e);
    expect(broken).toBeInstanceOf(MediaError);
    expect(broken.status).toBe(502);
    expect(String(broken.message)).not.toMatch(/jf\.test|adminkey|api_key/);
  });

  it('refreshMetadata (Bibliothekspflege) keeps its own query: a full refresh that keeps what is there', async () => {
    const { svc, calls } = server();
    await svc.refreshMetadata!(SERIES);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.search))).toEqual({ metadataRefreshMode: 'FullRefresh', imageRefreshMode: 'FullRefresh', replaceAllMetadata: 'false', replaceAllImages: 'false' });
  });
});

describe('Jellyfin itemKind: the item type with the admin key', () => {
  it('answers the type of a known id and null for an unknown one', async () => {
    const { svc, calls } = server();
    expect(await svc.itemKind!(SERIES)).toBe('Series');
    expect(await svc.itemKind!(SEASON)).toBe('Season');
    expect(await svc.itemKind!(GONE)).toBeNull();
    expect(calls.every((c) => c.auth?.includes('Token="adminkey"'))).toBe(true);
    expect(calls.every((c) => !new URLSearchParams(c.search).has('userId'))).toBe(true);
  });
  it('a malformed id is null without a request; a failing server throws a MediaError', async () => {
    const { svc, calls } = server();
    expect(await svc.itemKind!('not-an-id')).toBeNull();
    expect(calls).toHaveLength(0);
    await expect(svc.itemKind!(BROKEN)).rejects.toBeInstanceOf(MediaError);
  });
});

describe('itemRefresh capability', () => {
  it('Jellyfin offers it; the web reads it from the public capabilities (absent = false)', () => {
    expect(JELLYFIN_CAPABILITIES.itemRefresh).toBe(true);
    expect(publicCapabilities(JELLYFIN_CAPABILITIES).itemRefresh).toBe(true);
    const { itemRefresh: _i, ...rest } = JELLYFIN_CAPABILITIES;
    expect(publicCapabilities(rest).itemRefresh).toBe(false);
  });
});
