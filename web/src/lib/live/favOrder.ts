// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TKey } from '#lib/i18n';
import { cancel, drop, move, pick, type DragState } from '#lib/ui/dragOrder';

/**
 * The TV move mode of *Favoriten ordnen* (live TV spec §11.1; Task 38): D-pad, OK and Back alone. Pure like `livekeys.ts`; the view
 * measures, focuses and saves, this only decides what a key does to the order, the focused row and the announcement.
 *
 *   nothing picked   ▲ / ▼ move the focus     OK picks the focused row up     Back closes the sheet
 *   a row picked     ▲ / ▼ move that row      OK drops it (the view saves)    Back cancels the move, the sheet stays open
 *
 * A Back after a cancel has nothing picked any more, so it closes (the standard modal-move pattern). Runs on old TV browsers
 * (Chromium 85): plain arrays and objects only.
 */
export type TvOrderKey = 'ok' | 'up' | 'down' | 'back';

export interface TvOrderAnnounce { key: TKey; params: Record<string, string | number> }
export interface TvOrderResult { drag: DragState; focus: number; close: boolean; announce: TvOrderAnnounce | null }

/**
 * `nameOf` words the announcement ("Hafenkanal aufgenommen, …"); without it the id stands in. The state it gets is never changed.
 */
export function tvOrderKey(s: { drag: DragState; focus: number }, key: TvOrderKey, nameOf: (id: string) => string = (id) => id): TvOrderResult {
  const { drag } = s;
  const m = drag.ids.length;
  const at = (st: DragState): number => (st.picked === null ? -1 : st.ids.indexOf(st.picked));
  const clamp = (n: number): number => Math.min(Math.max(0, m - 1), Math.max(0, n));

  if (drag.picked === null) {
    const focus = clamp(s.focus);
    if (key === 'back') return { drag, focus, close: true, announce: null };
    if (key === 'up' || key === 'down') return { drag, focus: clamp(focus + (key === 'up' ? -1 : 1)), close: false, announce: null };
    const id = drag.ids[focus];
    if (id === undefined) return { drag, focus, close: false, announce: null };
    const next = pick(drag, id);
    return { drag: next, focus, close: false, announce: { key: 'live.fav.orderPicked', params: { name: nameOf(id), n: focus + 1, m } } };
  }

  const id = drag.picked;
  if (key === 'up' || key === 'down') {
    const next = move(drag, key === 'up' ? -1 : 1);
    if (next === drag) return { drag, focus: at(drag), close: false, announce: null }; // at an end: nothing to announce
    return { drag: next, focus: at(next), close: false, announce: { key: 'live.fav.orderMoved', params: { n: at(next) + 1, m } } };
  }
  if (key === 'ok') {
    const n = at(drag) + 1;
    const next = drop(drag);
    return { drag: next, focus: n - 1, close: false, announce: { key: 'live.fav.orderDropped', params: { name: nameOf(id), n } } };
  }
  const next = cancel(drag);
  return { drag: next, focus: next.ids.indexOf(id), close: false, announce: { key: 'live.fav.orderCancelled', params: {} } };
}

/** the order differs from the stored one (a lifted row that is back where it was does not count) */
export function orderChanged(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}
