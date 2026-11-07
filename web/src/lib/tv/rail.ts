// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** TV side-bar rail: the pure state machine (which key opens / closes it, what OK does). No DOM here. */
export type RailState = { open: boolean };
export type RailInput = {
  key: 'left' | 'right' | 'up' | 'down' | 'ok' | 'back' | 'pointerenter' | 'pointerleave';
  /** Left was pressed and no focus target exists further left in the content */
  atLeftEdge: boolean;
  /** the focus sits inside the rail */
  inRail: boolean;
  onHome: boolean;
};
export type RailAction = 'open' | 'close' | 'navigate' | 'exitPrompt' | 'none';

const OPEN: RailState = { open: true }, SHUT: RailState = { open: false };
const to = (state: RailState, action: RailAction) => ({ state, action });

export function railKey(s: RailState, i: RailInput): { state: RailState; action: RailAction } {
  const stay = to(s, 'none');
  if (!s.open) {
    if (i.key === 'pointerenter' || i.key === 'back' || (i.key === 'left' && i.atLeftEdge)) return to(OPEN, 'open');
    return stay;
  }
  switch (i.key) {
    case 'back': return i.onHome ? to(SHUT, 'exitPrompt') : to(SHUT, 'close');
    case 'right': return i.inRail ? to(SHUT, 'close') : stay;
    case 'ok': return i.inRail ? to(SHUT, 'navigate') : stay;
    case 'pointerleave': return to(SHUT, 'close');
    default: return stay; // up / down move inside the rail (spatial), left / pointerenter change nothing
  }
}
