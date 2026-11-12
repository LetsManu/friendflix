// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reordering a list by drag and by keyboard (live TV spec §9.2 *Reihenfolge*; ruling 56: the user side's *Favoriten ordnen*,
 * Task 38, reuses it on TVs). Pure functions over one state; the view measures and animates, this only decides the order.
 *
 *   let s = idle(ids);
 *   s = pick(s, id);          // Space on the handle / pointer down: the row is lifted, `origin` remembers its place
 *   s = move(s, 1);           // ↓ (↑ = -1); at an end the same state comes back (nothing to announce)
 *   s = moveTo(s, insertAt(mids, y)); // the pointer drag
 *   s = drop(s);              // Space / pointer up: the new order stays
 *   s = cancel(s);            // Escape / pointer cancel: the row goes back to `origin`
 *
 * Every function returns a new state and never changes the one it gets; "no change" returns the same object, so a caller can
 * compare by reference. Runs on old TV browsers (Chromium 85): plain arrays and maps only.
 */

export interface DragState { ids: string[]; picked: string | null; origin: number }

/** the state of an order with nothing lifted (a copy of `ids`) */
export function idle(ids: readonly string[]): DragState {
  return { ids: ids.slice(), picked: null, origin: -1 };
}

/** lift row `id`; a row that is not in the list, or a second one while one is lifted, changes nothing */
export function pick(s: DragState, id: string): DragState {
  if (s.picked !== null) return s;
  const i = s.ids.indexOf(id);
  if (i < 0) return s;
  return { ids: s.ids.slice(), picked: id, origin: i };
}

/** the lifted row to index `to` (rounded, clamped to the list); the others close up */
export function moveTo(s: DragState, to: number): DragState {
  if (s.picked === null) return s;
  const from = s.ids.indexOf(s.picked);
  const dest = Math.min(s.ids.length - 1, Math.max(0, Math.round(to)));
  if (from < 0 || dest === from) return s;
  const ids = s.ids.slice();
  ids.splice(from, 1);
  ids.splice(dest, 0, s.picked);
  return { ids, picked: s.picked, origin: s.origin };
}

/** the lifted row one place up (-1) or down (1); at an end the same state */
export function move(s: DragState, delta: -1 | 1): DragState {
  if (s.picked === null) return s;
  return moveTo(s, s.ids.indexOf(s.picked) + delta);
}

/** put the lifted row down where it is now */
export function drop(s: DragState): DragState {
  if (s.picked === null) return s;
  return { ids: s.ids.slice(), picked: null, origin: -1 };
}

/** put the lifted row back where it was picked up (earlier drops stay) */
export function cancel(s: DragState): DragState {
  if (s.picked === null) return s;
  return drop(moveTo(s, s.origin));
}

/**
 * Where the lifted row goes during a pointer drag: `mids` are the vertical middles of the other rows (the lifted one left out)
 * in their order, `y` is the lifted row's middle; the answer is how many of them lie above it.
 */
export function insertAt(mids: readonly number[], y: number): number {
  let n = 0;
  for (let i = 0; i < mids.length; i++) if (mids[i]! < y) n++;
  return n;
}

/**
 * FLIP: for every row in both maps, how far it must be shifted back (`before - after`, in px) to stand where it stood before
 * the reorder; the view sets that as a `transform` and lets it glide to 0. Rows that moved less than half a pixel are left out.
 */
export function flipOffsets(before: Map<string, number>, after: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  after.forEach((a, id) => {
    const b = before.get(id);
    if (b === undefined) return;
    const d = b - a;
    if (Math.abs(d) >= 0.5) out.set(id, d);
  });
  return out;
}

/**
 * The numbers *Speichern* gives the shown rows (spec §9.2): in their new order, ascending from the smallest number among them
 * (1 when none has one). Numbers of ids that are not shown do not count.
 */
export function renumber(ids: string[], numbers: Map<string, number | null>): Array<{ id: string; number: number }> {
  let start = Infinity;
  for (let i = 0; i < ids.length; i++) {
    const n = numbers.get(ids[i]!);
    if (typeof n === 'number' && n < start) start = n;
  }
  if (start === Infinity) start = 1;
  return ids.map((id, i) => ({ id, number: start + i }));
}
