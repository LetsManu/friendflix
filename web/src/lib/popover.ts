// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
export interface Box { left: number; right: number; top: number; bottom: number; width: number }
export interface Placed { left: number; width: number; top?: number; bottom?: number; maxHeight: number; up: boolean }

/**
 * Position for a `position: fixed` popover next to a trigger: stays inside the viewport,
 * right-aligns to the trigger when the left-aligned box would overflow, and opens upward
 * when asked to (or when there is clearly more room above than below).
 */
export function placePopover(r: Box, vp: { w: number; h: number }, o: { up?: boolean; wide?: boolean } = {}): Placed {
  const m = 8, gap = 6;
  const width = o.wide ? Math.min(Math.max(r.width, 230), vp.w - 2 * m) : Math.min(260, vp.w - 2 * m);
  let left = r.left;
  if (left + width > vp.w - m) left = r.right - width;
  left = Math.max(m, Math.min(left, vp.w - m - width));
  const below = vp.h - r.bottom - gap - m, above = r.top - gap - m;
  const up = o.up ? above >= 160 || above >= below : below < 300 && above > below;
  return up
    ? { left, width, bottom: vp.h - r.top + gap, maxHeight: Math.max(120, above), up }
    : { left, width, top: r.bottom + gap, maxHeight: Math.max(120, below), up };
}

export const placedStyle = (p: Placed): string =>
  `left:${Math.round(p.left)}px;width:${Math.round(p.width)}px;max-height:${Math.round(p.maxHeight)}px;` + (p.up ? `bottom:${Math.round(p.bottom!)}px;` : `top:${Math.round(p.top!)}px;`);

export const MENU_MARGIN = 8;
export const MENU_GAP = 6;
export interface MenuPlace { left: number; top: number; maxHeight: number; up: boolean }

/** Placement for a desktop menu next to its trigger: inside the window, flipping above when below is too tight. */
export function placeMenu(
  trigger: Box,
  size: { w: number; h: number },
  vp: { w: number; h: number },
  o: { up?: boolean; align?: 'start' | 'end' } = {},
): MenuPlace {
  const align = o.align ?? ((trigger.left + trigger.right) / 2 > vp.w / 2 ? 'end' : 'start');
  let left = align === 'end' ? trigger.right - size.w : trigger.left;
  const max = vp.w - MENU_MARGIN - size.w;
  left = size.w > vp.w - 2 * MENU_MARGIN ? MENU_MARGIN : Math.max(MENU_MARGIN, Math.min(left, max));
  const below = vp.h - trigger.bottom - MENU_GAP - MENU_MARGIN;
  const above = trigger.top - MENU_GAP - MENU_MARGIN;
  const up = o.up ? above >= size.h || above >= below : below < size.h && above > below;
  const top = up ? trigger.top - MENU_GAP - Math.min(size.h, above) : trigger.bottom + MENU_GAP;
  const maxHeight = up ? above : below;
  return { left: Math.round(left), top: Math.round(top), maxHeight: Math.round(maxHeight), up };
}

export const menuPlaceStyle = (p: MenuPlace): string => `left:${p.left}px;top:${p.top}px;max-height:${p.maxHeight}px;`;

/** True when the anchor moved more than `tol` px on either axis (scroll, layout shift). */
export function anchorMoved(before: { left: number; top: number }, after: { left: number; top: number }, tol = 2): boolean {
  return Math.abs(after.left - before.left) > tol || Math.abs(after.top - before.top) > tol;
}
