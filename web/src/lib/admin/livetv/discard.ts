// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The leave guard of the Live-TV sheets: unsaved input asks "Änderungen verwerfen?" before the sheet closes (`confirmDiscard`) or the
 * page navigates away (`guardLeave`, the pattern of routes/admin/roles; a reload or tab close lets the browser ask itself).
 */
import { beforeNavigate, goto } from '$app/navigation';
import { tr } from '#lib/i18n';
import { confirm } from '#lib/ui/confirm';
import { rerunOf } from '../leaveGuard';

export const confirmDiscard = (): Promise<boolean> =>
  confirm({ title: tr('adminLive.src.discardTitle'), body: tr('adminLive.src.discardBody'), danger: true, confirmLabel: tr('adminLive.src.discard') });

/** the same question for an unsaved channel / group order (the in-tab controls and the leave guard ask it alike) */
export const confirmOrderDiscard = (): Promise<boolean> =>
  confirm({ title: tr('adminLive.ch.orderDiscardTitle'), body: tr('adminLive.ch.orderDiscardBody'), confirmLabel: tr('adminLive.ch.orderDiscardConfirm'), cancelLabel: tr('adminLive.ch.orderKeep') });

/**
 * call during component init; `blocked()` = there is input to lose; `leave()` runs before an allowed navigation goes on (it must make
 * `blocked()` false); `ask` is the question (default: the sheets'). The confirmed navigation runs again as it was (`rerunOf`: a tab
 * switch replaces its entry, Back goes through history, a link pushes).
 */
export function guardLeave(blocked: () => boolean, leave: () => void, ask: () => Promise<boolean> = confirmDiscard): void {
  beforeNavigate((nav) => {
    if (!blocked()) return;
    nav.cancel();
    const again = rerunOf(nav);
    if (!again) return;
    void ask().then((ok) => {
      if (!ok) return;
      leave();
      if ('go' in again) history.go(again.go);
      else void goto(again.url, again.replace ? { replace: true, reset: false } : {});
    });
  });
}
