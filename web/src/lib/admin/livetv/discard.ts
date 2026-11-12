// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The leave guard of the Live-TV sheets: unsaved input asks "Änderungen verwerfen?" before the sheet closes (`confirmDiscard`) or the
 * page navigates away (`guardLeave`, the pattern of routes/admin/roles; a reload or tab close lets the browser ask itself).
 */
import { beforeNavigate, goto } from '$app/navigation';
import { tr } from '#lib/i18n';
import { confirm } from '#lib/ui/confirm';

export const confirmDiscard = (): Promise<boolean> =>
  confirm({ title: tr('adminLive.src.discardTitle'), body: tr('adminLive.src.discardBody'), danger: true, confirmLabel: tr('adminLive.src.discard') });

/** call during component init; `blocked()` = there is input to lose; `leave()` runs before an allowed navigation goes on */
export function guardLeave(blocked: () => boolean, leave: () => void): void {
  beforeNavigate((nav) => {
    if (!blocked()) return;
    nav.cancel();
    if (nav.willUnload || !nav.to) return;
    const to = nav.to.url;
    void confirmDiscard().then((ok) => { if (ok) { leave(); void goto(to); } });
  });
}
