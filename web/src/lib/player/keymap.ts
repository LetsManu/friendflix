// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TKey } from '#lib/i18n';
/** Pure keyboard map of the player: key event + context in, abstract action out (the component executes it). */
export type KeyAction =
  | { type: 'toggle' } | { type: 'play' } | { type: 'pause' }
  | { type: 'seek'; by: number } | { type: 'seekPct'; pct: number }
  | { type: 'volume'; delta: number } | { type: 'mute' } | { type: 'fullscreen' }
  | { type: 'subtitles' } | { type: 'skip' } | { type: 'next' } | { type: 'help' } | { type: 'escape' }
  | { type: 'tvControls' } | { type: 'pip' } | { type: 'speed'; delta: 1 | -1 }
  /** "Besetzung & Infos": quick peek while playing (I, TV: up, remote Info) / the full panel from an open peek (OK, I) */
  | { type: 'peek' } | { type: 'castInfo' }
  /** LG remote: red = subtitles on/off, green = audio/subtitle tracks menu, stop = leave the player like Back */
  | { type: 'subtitleToggle' } | { type: 'audioMenu' } | { type: 'stop' };

export interface KeyInput { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }
export interface KeyContext {
  /** 10-foot UI: D-pad + spatial navigation own the arrows, digits/letters stay free for the TV */
  tv: boolean;
  /** focus is on the page body / the stage itself (not on a control) */
  onBody: boolean;
  /** the skip intro/credits button is showing */
  hasSkip: boolean;
  /** an episode follows */
  hasNext: boolean;
  /** menu, dialog or shortcut overlay is open */
  overlayOpen: boolean;
  /** the cast quick peek is showing (OK / I then open the full "Besetzung & Infos" panel) */
  peekOpen?: boolean;
  /** the LG webOS app (isLgApp()): its remote's stop and colour keys act; elsewhere (Tizen, browsers) they stay unmapped */
  lg?: boolean;
}

/** keys typed into these belong to the field */
export const isTypingTarget = (el: { tagName?: string; isContentEditable?: boolean } | null): boolean =>
  Boolean(el && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName ?? '')) && !(el as { type?: string }).type?.match(/^(range|checkbox|radio|button)$/));

export function resolveKey(e: KeyInput, c: KeyContext): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase(); // 'Escape' -> 'escape'
  if (k === 'enter' && c.onBody && c.hasSkip && c.tv) return { type: 'skip' }; // TV: OK skips the intro while its button is showing
  if (c.peekOpen && !c.overlayOpen && ((k === 'enter' && c.onBody) || k === 'i' || k === 'info')) return { type: 'castInfo' };
  if (k === 'info') return c.overlayOpen ? null : { type: 'peek' }; // remote "Info" button
  if (k === ' ' || k === 'k' || k === 'mediaplaypause' || (k === 'enter' && c.onBody)) return { type: 'toggle' };
  if (k === 'mediaplay') return { type: 'play' };
  if (k === 'mediapause') return { type: 'pause' };
  if (k === 'mediafastforward') return { type: 'seek', by: 30 };
  if (k === 'mediarewind') return { type: 'seek', by: -30 };
  if (c.lg && k === 'mediastop') return { type: 'stop' };
  if (c.lg && k === 'colorf0red') return { type: 'subtitleToggle' };
  if (c.lg && k === 'colorf1green') return { type: 'audioMenu' };
  if (k === 'mediatracknext') return c.hasNext ? { type: 'next' } : null;
  // TV remotes without media keys (LG 2025 Magic Remote): channel up = next episode
  if (k === 'pageup' && c.tv) return c.hasNext ? { type: 'next' } : null;
  if (k === 'arrowleft' || k === 'j') return { type: 'seek', by: -10 };
  if (k === 'arrowright' || k === 'l') return { type: 'seek', by: 10 };
  // TV: up (bar hidden, nothing focused) peeks at the cast without pausing; down brings the control bar
  if (k === 'arrowup' && c.tv && c.onBody && !c.overlayOpen) return { type: 'peek' };
  if (k === 'arrowup' || k === 'arrowdown') return c.tv ? { type: 'tvControls' } : { type: 'volume', delta: k === 'arrowup' ? 0.1 : -0.1 };
  if (k === 'm') return { type: 'mute' };
  if (k === 'f') return { type: 'fullscreen' };
  if (k === 'escape') return c.overlayOpen ? { type: 'escape' } : null;
  if (c.tv) return null; // below: desktop-only extras
  if (k === 'c') return { type: 'subtitles' };
  if (k === 's') return c.hasSkip ? { type: 'skip' } : null;
  if (k === 'n') return c.hasNext ? { type: 'next' } : null;
  if (k === 'p') return { type: 'pip' };
  if (k === 'i') return c.overlayOpen ? null : { type: 'peek' };
  if (k === '?') return { type: 'help' };
  if (k === '<' || (k === ',' && e.shiftKey)) return { type: 'speed', delta: -1 };
  if (k === '>' || (k === '.' && e.shiftKey)) return { type: 'speed', delta: 1 };
  if (/^[0-9]$/.test(k)) return { type: 'seekPct', pct: Number(k) * 10 };
  return null;
}

/** C: off -> first track -> ... -> last track -> off. `current` -1 = off; unknown current starts at the first track. */
export function nextSubtitle(current: number, indices: number[]): number {
  if (!indices.length) return -1;
  if (current === -1) return indices[0];
  const i = indices.indexOf(current);
  return i < 0 || i === indices.length - 1 ? -1 : indices[i + 1];
}

/** LG red key: on -> off; off -> the last used track (`last`, -1 = none) while it still exists, else the first track. */
export function toggleSubtitle(current: number, last: number, indices: number[]): number {
  if (current !== -1 || !indices.length) return -1;
  return indices.includes(last) ? last : indices[0];
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** TV: holding left/right seeks faster - 10 s steps for the first second, then 30 s, after 3 s 60 s */
export function holdSeekStep(heldMs: number): number {
  return heldMs < 1000 ? 10 : heldMs < 3000 ? 30 : 60;
}

/** shortcut list for the "?" overlay: key caption (`k`, or the message `kKey` when the caption is a word) and the message key of the description */
export const SHORTCUTS: Array<{ k: string; kKey?: TKey; d: TKey }> = [
  { k: 'Space / K', kKey: 'player.shortcuts.space', d: 'player.shortcuts.playPause' },
  { k: '← / J', d: 'player.shortcuts.back10' },
  { k: '→ / L', d: 'player.shortcuts.forward10' },
  { k: '↑ / ↓', d: 'player.shortcuts.volume' },
  { k: 'M', d: 'player.shortcuts.mute' },
  { k: 'F', d: 'player.shortcuts.fullscreen' },
  { k: 'C', d: 'player.shortcuts.subtitles' },
  { k: 'S', d: 'player.shortcuts.skip' },
  { k: 'N', d: 'player.shortcuts.next' },
  { k: 'P', d: 'player.shortcuts.pip' },
  { k: '< / >', d: 'player.shortcuts.speed' },
  { k: 'I', d: 'scenes.shortcuts.peek' },
  { k: '0 – 9', d: 'player.shortcuts.jump' },
  { k: 'Esc', d: 'player.shortcuts.escape' },
  { k: '?', d: 'player.shortcuts.help' },
];
