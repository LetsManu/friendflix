// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Opens one setting for a deep link (`?setting=<KEY>` from the Systemcheck's "Zur Einstellung", the search, a card's link): the row
 * (`#setting-<KEY>`, SettingRow) is scrolled to the centre, its first control gets the focus without a second scroll, and the row shows
 * a highlight. The highlight is an overlay that fades in and out (opacity only, 2.4 s, SettingRow's `[data-flash]` style); with reduced
 * motion it is a static outline (`data-flash="static"`) until the next pointer or key press.
 */
import { tick } from 'svelte';

const KEY = /^[A-Z][A-Z0-9_]*$/;
export const FLASH_MS = 2_400;
const CONTROLS = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])';

/** the row whose highlight runs now: a second deep link ends it first */
let current: { el: HTMLElement; end(): void } | null = null;

export async function highlightSetting(key: string, o: { reducedMotion?: boolean } = {}): Promise<boolean> {
  if (!KEY.test(key)) return false;
  await tick();
  const el = document.getElementById(`setting-${key}`);
  if (!el) return false;
  const reduced = o.reducedMotion ?? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  current?.end();
  el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  el.querySelector<HTMLElement>(CONTROLS)?.focus({ preventScroll: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    clearTimeout(timer);
    window.removeEventListener('pointerdown', end, true);
    window.removeEventListener('keydown', end, true);
    delete el.dataset.flash;
    if (current?.el === el) current = null;
  };
  current = { el, end };
  if (reduced) {
    el.dataset.flash = 'static';
    window.addEventListener('pointerdown', end, true);
    window.addEventListener('keydown', end, true);
  } else {
    el.dataset.flash = '';
    timer = setTimeout(end, FLASH_MS);
  }
  return true;
}
