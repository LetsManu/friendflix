// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The live BackLayers (phone player panels). A navigation that replaces the current history entry (the next episode) first takes
 * their shallow entries off and waits for any `history.back()` of theirs still on its way; otherwise the replace hits the panel's
 * entry, or the back undoes the navigation, and one Back no longer leaves the player.
 */
const live = new Set<() => Promise<void>>();

/** registers a layer's `drop`; returns the unregister function */
export function registerLayer(drop: () => Promise<void>): () => void {
  live.add(drop);
  return () => { live.delete(drop); };
}

/** drops every live layer's entry; resolves once the browser has popped them (immediately when there is none) */
export async function dropLayers(): Promise<void> {
  await Promise.all([...live].map((d) => d()));
}
