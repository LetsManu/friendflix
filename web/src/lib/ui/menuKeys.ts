// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The keyboard model of a `role="menu"` popup (WAI-ARIA menu button pattern): ArrowDown / ArrowUp move between the items
 * (wrapping), Home / End jump to the first / last, Tab closes the menu and the focus moves on from its button (the menu goes
 * `inert` at once, so its items, still on screen while the closing animation runs, are skipped). Escape stays with the
 * popup's owner (it closes and gives the focus back to the button).
 *
 *   <div role="menu" use:menuKeys={{ close: () => (open = false), trigger: btn }}>
 *     <a role="menuitem" tabindex="-1" href="/me">…</a>
 */

export type MenuMove = 'next' | 'prev' | 'first' | 'last';

/** the move a key asks for, or null */
export function menuMove(key: string): MenuMove | null {
  switch (key) {
    case 'ArrowDown': return 'next';
    case 'ArrowUp': return 'prev';
    case 'Home': return 'first';
    case 'End': return 'last';
    default: return null;
  }
}

/** the item index after `move` from `i` among `n` items (wraps; from nothing focused, next goes to the first and prev to the last) */
export function moveIndex(move: MenuMove, i: number, n: number): number {
  if (n <= 0) return -1;
  if (move === 'first') return 0;
  if (move === 'last') return n - 1;
  if (i < 0) return move === 'next' ? 0 : n - 1;
  return move === 'next' ? (i + 1) % n : (i - 1 + n) % n;
}

export interface MenuKeysOpts { close: () => void; trigger?: HTMLElement | null }

/** the enabled items of a menu, in order */
export function menuItems(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')]
    .filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true');
}

/** Svelte action: the menu keys on a `role="menu"` element */
export function menuKeys(node: HTMLElement, opts: MenuKeysOpts) {
  let o = opts;
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Tab') {
      node.inert = true; // leaving: the closing menu's items are no Tab stops any more
      o.close();
      o.trigger?.focus({ preventScroll: true }); // no preventDefault: the browser's Tab moves on from the button
      return;
    }
    const move = menuMove(e.key);
    if (!move) return;
    const items = menuItems(node);
    const j = moveIndex(move, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (j < 0) return;
    e.preventDefault();
    items[j]!.focus({ preventScroll: true });
  };
  node.addEventListener('keydown', onKey);
  return {
    update(next: MenuKeysOpts) { o = next; },
    destroy() { node.removeEventListener('keydown', onKey); },
  };
}
