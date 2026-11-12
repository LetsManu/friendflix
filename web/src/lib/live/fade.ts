// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readable } from 'svelte/store';

/**
 * Svelte action for logos and previews: the image starts invisible and fades in by opacity (the CSS keys on `img.in`, a global
 * class because the action sets it). A cached image that is complete already shows at once; a broken one stays out of sight.
 */
export function fadeIn(node: HTMLImageElement): { destroy(): void } {
  const show = () => node.classList.add('in');
  if (node.complete && node.naturalWidth > 0) show();
  node.addEventListener('load', show);
  return { destroy: () => node.removeEventListener('load', show) };
}

/** ms until the next full minute (at least a moment, so a tick never lands a hair before the minute) */
export function untilNextMinute(nowMs: number): number {
  return 60_000 - (nowMs % 60_000) + 25;
}

/**
 * The current time, renewed just after every full minute. Tiles and rows read the time left and the progress from it, so both
 * change in minute steps and only then.
 */
export const minute = readable(new Date(), (set) => {
  let id: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    set(new Date());
    id = setTimeout(tick, untilNextMinute(Date.now()));
  };
  set(new Date());
  id = setTimeout(tick, untilNextMinute(Date.now()));
  return () => { if (id !== undefined) clearTimeout(id); };
});
