// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The page behind a dialog stays put: the first lock hides <html>'s overflow and pads its right edge by the scrollbar's width (a
 * desktop with a classic scrollbar would otherwise shift the page sideways when the bar goes); the last unlock puts back the inline
 * values that were there before, exactly. Ref-counted, so a dialog over a sheet or a second dialog does not unlock the page when
 * the inner one closes. The returned unlock is idempotent.
 *   onMount(() => lockScroll());
 */

type Held = { count: number; overflow: string; paddingRight: string };
const held = new WeakMap<Document, Held>();

export function lockScroll(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): () => void {
  if (!doc) return () => undefined;
  const html = doc.documentElement;
  let h = held.get(doc);
  if (!h) {
    const win = doc.defaultView ?? (typeof window === 'undefined' ? undefined : window);
    const bar = Math.max(0, (win?.innerWidth ?? html.clientWidth) - html.clientWidth);
    h = { count: 0, overflow: html.style.overflow, paddingRight: html.style.paddingRight };
    held.set(doc, h);
    if (bar > 0) html.style.paddingRight = `${bar}px`;
    html.style.overflow = 'hidden';
  }
  h.count++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cur = held.get(doc);
    if (!cur || --cur.count > 0) return;
    held.delete(doc);
    html.style.overflow = cur.overflow;
    html.style.paddingRight = cur.paddingRight;
  };
}
