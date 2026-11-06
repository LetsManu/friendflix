// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Download hand-off to the app: the page creates the licence (as for a browser download), the app fetches the file.
import { adoptLicenses, createLicenses, discardLicense, type DlView, type DownloadRequest, type ServerLicense } from '#lib/offline/manager';
import { tr } from '#lib/i18n';
import { native, refreshNativeDownloads, type NativeDownload } from './bridge';

/** An app download in the shape the download UI already renders. Totals are derived from the app's byte count and fraction. */
export function toView(d: NativeDownload): DlView {
  const total = d.progress > 0 ? Math.round(d.bytes / Math.min(1, d.progress)) : 0;
  return {
    id: d.licenseId, itemId: d.itemId, profileId: d.profileId ?? '', profileName: '', title: d.title ?? '', quality: 'hd',
    bytesTotal: d.state === 'done' ? d.bytes : total, bytesHave: d.bytes, etag: '', state: d.state, subs: [],
    expiresAt: d.expiresAt, validUntil: d.expiresAt, positionSec: 0, updatedAt: 0,
    prep: d.state === 'preparing' ? Math.round(Math.min(1, d.progress) * 100) : undefined,
    msg: d.error ? tr(`account.downloads.msg.${d.error}`) : undefined,
  } as DlView;
}

/** What the server knows of a licence that the app does not (series, season, episode); from GET /api/downloads, best effort. */
export type LicenseMeta = Pick<ServerLicense, 'title' | 'seriesName' | 'season' | 'episode'>;

/**
 * The app's downloads for the downloads page: the active profile's (rows without a known profile too), expired ones included so they
 * can be removed, with the server's series details where it still lists the licence.
 */
export function nativeList(m: Map<string, NativeDownload>, profileId: string | undefined, meta: Map<string, LicenseMeta> = new Map()): DlView[] {
  const out: DlView[] = [];
  for (const d of m.values()) {
    if (profileId && d.profileId && d.profileId !== profileId) continue;
    const v = toView(d);
    const l = meta.get(d.licenseId);
    if (l) {
      if (!v.title) v.title = l.title;
      if (l.seriesName) { v.seriesName = l.seriesName; v.s = l.season ?? undefined; v.e = l.episode ?? undefined; v.title = l.title || v.title; }
    }
    out.push(v);
  }
  return out;
}

export const viewForNative = (m: Map<string, NativeDownload>, itemId: string): DlView | undefined => {
  for (const d of m.values()) if (d.itemId === itemId && d.state !== 'expired') return toView(d);
  return undefined;
};

/**
 * Create the licence(s) on the server and give each to the app.
 * A licence the app declines goes to the page's own downloader when the browser can download (`webFallback`), otherwise it is given
 * back to the server. Throws `native_declined` only when the app took none of them. If the app does not answer in time, it is asked
 * what it lists: licences it holds are its own, only the others are declined (so nothing is downloaded twice). If it does not answer
 * that either, the licence is left alone (neither adopted nor discarded: the app may hold it) and this throws `native_unknown`.
 */
export async function startNativeDownload(req: DownloadRequest, webFallback: boolean): Promise<void> {
  const { licenses, me } = await createLicenses(req);
  const declined: ServerLicense[] = [];
  let unknown = 0;
  let held: Set<string> | null | undefined;
  for (const l of licenses) {
    let r = await native.download({ licenseId: l.id, itemId: l.itemId, profileId: l.profileId || me?.profile?.id || '' });
    if (r === 'timeout') {
      if (held === undefined) { const list = await native.downloads(); held = list ? new Set(list.map((d) => d.licenseId)) : null; }
      if (held === null) { unknown++; continue; }
      r = held.has(l.id);
    }
    if (r !== true) declined.push(l);
  }
  if (declined.length) {
    if (webFallback) await adoptLicenses(declined, me);
    else await Promise.all(declined.map((l) => discardLicense(l.id)));
  }
  await refreshNativeDownloads();
  if (unknown) throw new Error('native_unknown');
  if (!webFallback && declined.length === licenses.length) throw new Error('native_declined');
}
