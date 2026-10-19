// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Download hand-off to the app: the page creates the licence (as for a browser download), the app fetches the file.
import { adoptLicenses, createLicenses, discardLicense, type DlView, type DownloadRequest } from '#lib/offline/manager';
import { native, refreshNativeDownloads, type NativeDownload } from './bridge';

/** An app download in the shape the download UI already renders. Totals are derived from the app's byte count and fraction. */
export function toView(d: NativeDownload): DlView {
  const total = d.progress > 0 ? Math.round(d.bytes / Math.min(1, d.progress)) : 0;
  return {
    id: d.licenseId, itemId: d.itemId, profileId: '', profileName: '', title: '', quality: 'hd',
    bytesTotal: d.state === 'done' ? d.bytes : total, bytesHave: d.bytes, etag: '', state: d.state, subs: [],
    expiresAt: d.expiresAt, validUntil: d.expiresAt, positionSec: 0, updatedAt: 0,
    prep: d.state === 'preparing' ? Math.round(Math.min(1, d.progress) * 100) : undefined,
  } as DlView;
}

export const viewForNative = (m: Map<string, NativeDownload>, itemId: string): DlView | undefined => {
  for (const d of m.values()) if (d.itemId === itemId && d.state !== 'expired') return toView(d);
  return undefined;
};

/**
 * Create the licence(s) on the server and give each to the app. A licence the app declines goes to the page's own downloader when
 * the browser can download (`webFallback`), otherwise it is given back to the server and this throws `native_declined`.
 */
export async function startNativeDownload(req: DownloadRequest, webFallback: boolean): Promise<void> {
  const { licenses, me } = await createLicenses(req);
  const declined = [];
  for (const l of licenses) {
    const ok = await native.download({ licenseId: l.id, itemId: l.itemId, profileId: l.profileId || me?.profile?.id || '' });
    if (!ok) declined.push(l);
  }
  if (declined.length) {
    if (webFallback) await adoptLicenses(declined, me);
    else {
      await Promise.all(declined.map((l) => discardLicense(l.id)));
      throw new Error('native_declined');
    }
  }
  await refreshNativeDownloads();
}
