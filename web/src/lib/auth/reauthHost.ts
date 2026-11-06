// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The logic of ReauthHost.svelte (lib/account/reauth.ts renders through it): loading the dialog on the first request, and giving a
 * request up when the page it belongs to goes away.
 */
import { finishReauth } from '#lib/account/reauth';

/**
 * Loads the dialog once (`load` is the dynamic import) and keeps it. A load that fails answers the open request with false (the page
 * stays as it was) and is tried again on the next request.
 */
export function dialogLoader<T>(load: () => Promise<T>): () => Promise<T | null> {
  let pending: Promise<T> | null = null;
  return async () => {
    try {
      return await (pending ??= load());
    } catch {
      pending = null;
      finishReauth(false);
      return null;
    }
  };
}

/**
 * beforeNavigate: an in-app navigation while the dialog is open gives the request up, so a finished sign-in never repeats the action of
 * a page that is gone. A navigation that unloads the document (the dialog's own redirect to the classic sign-in, a reload) leaves it
 * alone: the page's state for that redirect (the settings page's stash) must survive.
 */
export function navigatedAway(nav: { willUnload: boolean }): void {
  if (!nav.willUnload) finishReauth(false);
}
