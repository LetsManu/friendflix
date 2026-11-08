// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Logic shared by the two pointer previews of a card: the pop-out (HoverPreview, kids UI on desktop) and the wide desktop
 * preview (desk/DeskPreview). One place for the clip rules, the rating cache, the favourite save and the "⋯" actions.
 */
import { api, cachedDetail, primeDetail, setCachedThumb, type Item, type ItemDetail } from '#lib/api';
import type { TFn } from '#lib/i18n';
import type { MoreAction } from '#lib/MoreActions.svelte';
import { previewFailed } from '#lib/preview';
import { toThumb, type Thumb } from '#lib/rating';

export interface ClipEnv { motion: boolean; saveData: boolean; hidden: boolean }

/** The page state the clip rules ask about (Save-Data, hidden tab); `motion` = the caller's motion check. */
export function clipEnv(motion: boolean): ClipEnv {
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as { connection?: { saveData?: boolean } };
  return { motion, saveData: Boolean(nav.connection?.saveData), hidden: typeof document !== 'undefined' && document.hidden };
}

/** May the preview start the title's clip by itself? Never after a failure, with the pref off, without motion, on Save-Data or in a hidden tab. */
export function hoverClipAllowed(item: Pick<Item, 'id' | 'type' | 'trailers'>, p: { hoverTrailers: boolean; hoverClip: boolean }, env: ClipEnv): boolean {
  if (previewFailed(item.id) || !p.hoverTrailers || !env.motion || env.saveData || env.hidden) return false;
  return Boolean(item.trailers || (p.hoverClip && (item.type === 'Movie' || item.type === 'Series')));
}

/**
 * The viewer's rating for the preview: the cached detail at once, then revalidated (the rating may have changed on another device).
 * The same response feeds the detail popup. A rating set meanwhile (`changed`) is never overwritten.
 */
export function ratingLoader(listId: string, set: (t: Thumb) => void) {
  let touched = false, mine: Thumb = 0;
  return {
    async load(): Promise<void> {
      const hit = cachedDetail(listId);
      if (hit) set(toThumb(hit.thumb));
      try {
        const r = await api<ItemDetail>(`/api/items/${listId}`);
        if (!touched) set(toThumb(r?.thumb));
        primeDetail(touched ? { ...r, thumb: mine } : r);
      } catch { /* optional */ }
    },
    changed(value: Thumb): void { touched = true; mine = value; setCachedThumb(listId, value); },
  };
}

/** Saves the favourite flag; false when the server refused (the caller reverts its optimistic state). */
export async function saveFavorite(itemId: string, want: boolean): Promise<boolean> {
  try { await api(`/api/items/${itemId}/favorite`, { method: want ? 'POST' : 'DELETE' }); return true; } catch { return false; }
}

/** The "⋯" menu of a preview: favourite, remove from Continue Watching (when removable), the detail link (when given). */
export function previewActions(o: { fav: boolean; removable: boolean; t: TFn; toggleFav: () => void; remove: () => void; detail?: string }): MoreAction[] {
  return [
    { id: 'fav', label: o.fav ? o.t('home.card.favRemove') : o.t('home.card.favAdd'), icon: 'heart', pressed: o.fav, run: o.toggleFav },
    ...(o.removable ? [{ id: 'remove', label: o.t('home.card.removeResume'), icon: 'x', run: o.remove }] : []),
    ...(o.detail ? [{ id: 'details', label: o.t('home.card.openDetail'), icon: 'info', href: o.detail }] : []),
  ];
}

/** A click on the preview picture (not on one of its controls) opens the title; ctrl/cmd/shift or the middle button opens it in a new tab. */
export function artClick(e: MouseEvent, detail: string, open: (e: MouseEvent) => void): void {
  if ((e.target as Element | null)?.closest?.('button, a')) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) { window.open(detail, '_blank', 'noopener'); return; }
  if (e.button === 0) open(e);
}

/** After a mouse click the control drops its focus again (keyboard users keep it). */
export function releaseClick(e: MouseEvent): void {
  if (e.detail > 0) (e.currentTarget as HTMLElement | null)?.blur();
}

/** Svelte action: moves the node to <body> (the preview lives outside the row's clipping and stacking). */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return { destroy() { node.remove(); } };
}
