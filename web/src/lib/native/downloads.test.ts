// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  licenses: [] as any[], me: { profile: { id: 'p-1' } },
  download: vi.fn(async (_r: unknown): Promise<boolean | 'timeout'> => true), refresh: vi.fn(async () => {}),
  create: vi.fn(), list: vi.fn(async () => [] as Array<{ licenseId: string }>), adopt: vi.fn(async (..._a: unknown[]) => []), discard: vi.fn(async (_id: string) => {}),
}));
vi.mock('#lib/offline/manager', () => ({ createLicenses: h.create, adoptLicenses: h.adopt, discardLicense: h.discard }));
vi.mock('./bridge', () => ({ native: { download: h.download, downloads: h.list }, refreshNativeDownloads: h.refresh }));

import { startNativeDownload, toView, viewForNative } from './downloads';

const req = { itemId: 'i-1', quality: 'hd' as const, subLangs: [] };
beforeEach(() => {
  h.licenses = [{ id: 'L-1', itemId: 'i-1', profileId: 'p-1' }, { id: 'L-2', itemId: 'i-2', profileId: '' }];
  h.create.mockReset(); h.create.mockImplementation(async () => ({ licenses: h.licenses, me: h.me }));
  h.download.mockReset(); h.download.mockResolvedValue(true);
  h.list.mockClear(); h.list.mockResolvedValue([]); h.adopt.mockClear(); h.discard.mockClear(); h.refresh.mockClear();
});

describe('startNativeDownload', () => {
  it('creates the licences, hands each to the app (profile from the licence, else the session) and refreshes', async () => {
    await startNativeDownload(req, true);
    expect(h.create).toHaveBeenCalledWith(req);
    expect(h.download.mock.calls.map((c) => c[0])).toEqual([
      { licenseId: 'L-1', itemId: 'i-1', profileId: 'p-1' },
      { licenseId: 'L-2', itemId: 'i-2', profileId: 'p-1' },
    ]);
    expect(h.adopt).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalled();
  });
  it('a declined licence falls back to the browser downloader when it can download', async () => {
    h.download.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await startNativeDownload(req, true);
    expect(h.adopt).toHaveBeenCalledWith([h.licenses[1]], h.me);
    expect(h.discard).not.toHaveBeenCalled();
  });
  it('declined and no browser support: the licence goes back to the server and the call fails', async () => {
    h.download.mockResolvedValue(false);
    await expect(startNativeDownload(req, false)).rejects.toThrow('native_declined');
    expect(h.discard.mock.calls.map((c) => c[0])).toEqual(['L-1', 'L-2']);
    expect(h.adopt).not.toHaveBeenCalled();
  });
  it('without browser support some accepted + some declined still succeeds; only the declined go back', async () => {
    h.download.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(startNativeDownload(req, false)).resolves.toBeUndefined();
    expect(h.discard.mock.calls.map((c) => c[0])).toEqual(['L-2']);
  });
  it('a timeout is resolved by asking what the app lists: held licences are not adopted again', async () => {
    h.download.mockResolvedValue('timeout');
    h.list.mockResolvedValue([{ licenseId: 'L-1' }]);
    await startNativeDownload(req, true);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.adopt).toHaveBeenCalledWith([h.licenses[1]], h.me);
  });
  it('a failing licence request surfaces to the caller before anything is handed over', async () => {
    h.create.mockRejectedValue(Object.assign(new Error('x'), { status: 429 }));
    await expect(startNativeDownload(req, true)).rejects.toMatchObject({ status: 429 });
    expect(h.download).not.toHaveBeenCalled();
  });
});

describe('views', () => {
  it('maps an app download to the UI record', () => {
    const v = toView({ licenseId: 'L', itemId: 'i', state: 'downloading', progress: 0.25, bytes: 250, expiresAt: 99 });
    expect(v).toMatchObject({ id: 'L', itemId: 'i', state: 'downloading', bytesHave: 250, bytesTotal: 1000, expiresAt: 99 });
    expect(toView({ licenseId: 'L', itemId: 'i', state: 'preparing', progress: 0.4, bytes: 0, expiresAt: 0 }).prep).toBe(40);
    expect(toView({ licenseId: 'L', itemId: 'i', state: 'done', progress: 1, bytes: 777, expiresAt: 0 })).toMatchObject({ bytesTotal: 777, bytesHave: 777 });
  });
  it('finds the live download of an item', () => {
    const m = new Map([
      ['A', { licenseId: 'A', itemId: 'i', state: 'expired', progress: 1, bytes: 1, expiresAt: 0 } as const],
      ['B', { licenseId: 'B', itemId: 'i', state: 'done', progress: 1, bytes: 1, expiresAt: 0 } as const],
    ]);
    expect(viewForNative(m, 'i')?.id).toBe('B');
    expect(viewForNative(m, 'other')).toBeUndefined();
  });
});
