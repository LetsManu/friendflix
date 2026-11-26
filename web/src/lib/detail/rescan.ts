// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * *Neu einlesen* on the detail page (admins on the owner profile): a film, a whole series or one season is read in again by the media
 * server, in one of the three modes of Jellyfin's own refresh dialog (the managed Ferrofin has no dashboard of its own). The server works
 * on it in the background: FriendFlix sends the request, says so in a toast and never polls. Backend: POST /api/admin/items/:id/refresh.
 */
import { api } from '#lib/api';
import type { ServerCaps } from '#lib/capabilities';
import { tr } from '#lib/i18n';
import { errorText } from '#lib/ui/action';
import { confirm, type ConfirmOptions } from '#lib/ui/confirm';
import { toast } from '#lib/ui/toast';

/** scan: new and changed files · missing: fill gaps, keep what is there · replace: all metadata and images anew (asks first) */
export type RescanMode = 'scan' | 'missing' | 'replace';
export const RESCAN_MODES: readonly RescanMode[] = ['scan', 'missing', 'replace'];
const TYPES: ReadonlySet<string> = new Set(['Movie', 'Series', 'Season']);

/** the entry shows for an admin (facts.admin: admin role on the owner profile) on a server that can, for a film, series or season */
export const rescanShown = (type: string | undefined, admin: boolean | undefined, caps: Pick<ServerCaps, 'itemRefresh'>): boolean =>
  admin === true && caps.itemRefresh && TYPES.has(type ?? '');

export const rescanRequest = (id: string, mode: RescanMode) =>
  ({ path: `/api/admin/items/${encodeURIComponent(id)}/refresh`, method: 'POST' as const, body: { mode } });

/** only replacing everything asks first (it drops what was edited by hand on the server) */
export const rescanConfirms = (mode: RescanMode): boolean => mode === 'replace';

type Call = (path: string, opts: { method: string; body: unknown }) => Promise<unknown>;

/**
 * Asks (replace only), sends the request and toasts the start. 'cancelled': the person said no to the question, nothing was sent;
 * `{ error }`: the shared error text of the failed request (the dialog shows it in its status line, no toast).
 */
export async function startRescan(
  t: { id: string; mode: RescanMode; name: string },
  deps: { call?: Call; ask?: (o: ConfirmOptions) => Promise<boolean> } = {},
): Promise<'done' | 'cancelled' | { error: string }> {
  const { call = api, ask = confirm } = deps;
  if (rescanConfirms(t.mode)) {
    const ok = await ask({ title: tr('detail.rescan.confirmTitle'), body: tr('detail.rescan.confirmBody', { name: t.name }), danger: true, confirmLabel: tr('detail.rescan.confirmOk') });
    if (!ok) return 'cancelled';
  }
  const r = rescanRequest(t.id, t.mode);
  try {
    await call(r.path, { method: r.method, body: r.body });
  } catch (e) {
    return { error: errorText(e) };
  }
  toast.success(tr('detail.rescan.started', { name: t.name }));
  return 'done';
}
