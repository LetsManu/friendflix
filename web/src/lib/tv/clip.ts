// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TV windows that clip with `overflow: clip` (never a scroll container). Chromium before 90 (webOS 22) does not know the value;
 * there the CSS falls back to `overflow: hidden` (`@supports not (overflow: clip)`), which is a scroll container again: a focus
 * moved into a clipped part would scroll it. This action keeps such a box at scroll position 0 (nothing on the newer engines).
 */
type ScrollBox = Pick<HTMLElement, 'scrollTop' | 'scrollLeft' | 'addEventListener' | 'removeEventListener'>;
type Css = { supports?: (prop: string, value: string) => boolean } | undefined;

export const clipSupported = (css: Css = typeof CSS === 'undefined' ? undefined : CSS): boolean => !css?.supports || css.supports('overflow', 'clip');

export function noScroll(node: ScrollBox, css?: Css): { destroy(): void } {
  if (clipSupported(css)) return { destroy() {} };
  const reset = () => { if (node.scrollTop || node.scrollLeft) { node.scrollTop = 0; node.scrollLeft = 0; } };
  node.addEventListener('scroll', reset);
  return { destroy: () => node.removeEventListener('scroll', reset) };
}
