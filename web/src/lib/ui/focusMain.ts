// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Moves the keyboard focus to the page's `<main>` (after the control that held it is gone, e.g. the cast bar after Stop). `main` is not
 * focusable by itself: it gets `tabindex="-1"` only for this focus and loses it again on blur (a pointer press anywhere blurs it), so a click on a blank area keeps the
 * focus on `<body>` (several handlers read "body" as "nothing focused").
 */
export function focusMain(): void {
  const m = document.getElementById('main');
  if (!m) return;
  m.setAttribute('tabindex', '-1');
  // a click anywhere lets go first: else a click on a blank area would keep the focus on main (its own focusable ancestor)
  const letGo = () => m.blur();
  const done = () => { m.removeAttribute('tabindex'); document.removeEventListener('pointerdown', letGo, true); };
  document.addEventListener('pointerdown', letGo, true);
  m.addEventListener('blur', done, { once: true });
  m.focus({ preventScroll: true });
}
