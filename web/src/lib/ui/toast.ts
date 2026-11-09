// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * App-wide toasts (docs/ui-kit.md). One <ToastHost/> in the root layout renders them; call from anywhere:
 *
 *   toast.success(tr('ui.saved'));
 *   toast.error(errorText(e), { action: { label: tr('ui.retry'), run: save } });
 *   toast.info(msg, { duration: 0 });   // stays until closed
 *
 * At most MAX_VISIBLE toasts are shown; a new one pushes the oldest out (its onClose runs with reason 'replaced').
 * Timers pause while the pointer or focus is on a toast (host calls pause/resume). A toast with an action shows a countdown ring
 * (glass spec §8.5) drawn from timeLeft().
 *
 * Keyboard use (WCAG 2.2.1): while the last input was a key (the host calls setKeyboardUse), a toast with an action stays until
 * it is dismissed - a keyboard user may be dozens of Tab stops away from its button. ACTION_SHORTCUT runs the newest toast's
 * action from anywhere (runLatestAction). A pointer press brings the countdown back (at least 1.5 s left).
 */
import { writable, type Readable } from 'svelte/store';

export type ToastKind = 'success' | 'error' | 'info';
/** why a toast went away: timeout, the × button, its action button, pushed out by a newer one, or dismissAll() */
export type CloseReason = 'timeout' | 'dismiss' | 'action' | 'replaced';

export interface ToastAction {
  label: string;
  /** called once; the toast closes with reason 'action' */
  run: () => unknown;
}
export interface ToastOptions {
  /** ms until auto-dismiss; 0 = sticky. Default: 5 s (success/info), 8 s (error), 5 s with an action */
  duration?: number;
  action?: ToastAction;
  /** called exactly once when the toast leaves */
  onClose?: (reason: CloseReason) => void;
  /** replaces a visible toast with the same key instead of stacking (e.g. repeated "saved") */
  key?: string;
}
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  duration: number;
  key?: string;
  /** Date.now() when its timer last started (0: never ran) */
  started: number;
  /** ms left on its timer when it last (re)started or paused */
  left: number;
}

export const MAX_VISIBLE = 3;
export const DURATION: Record<ToastKind, number> = { success: 5000, info: 5000, error: 8000 };
export const ACTION_DURATION = 5000;
/** runs the newest toast's action (Alt+Z: no app or browser shortcut uses it; matched by e.code, so it works on every layout) */
export const ACTION_SHORTCUT = 'Alt+Z';
/** the countdown ring's circumference (r 11) */
export const RING_LEN = 69.1;

interface Entry extends Toast { onClose?: (r: CloseReason) => void; timer: ReturnType<typeof setTimeout> | null }

const list = writable<Toast[]>([]);
let entries: Entry[] = [];
let seq = 0;
/** pointer or focus on the toasts: timers hold, also for toasts that arrive meanwhile (resume() starts them) */
let paused = false;
/** the last input was a key: action toasts hold (no countdown) */
let kbd = false;
const kbdStore = writable(false);
/** true while action toasts hold for keyboard use (the host hides their countdown ring) */
export const keyboardHold: Readable<boolean> = { subscribe: kbdStore.subscribe };
const publish = () => list.set(entries.map(({ id, kind, message, action, duration, key, started, left }) => ({ id, kind, message, action, duration, key, started, left })));

const held = (e: Entry) => kbd && Boolean(e.action);
function arm(e: Entry) {
  if (!e.duration || e.left <= 0 || held(e)) return;
  e.started = Date.now();
  e.timer = setTimeout(() => close(e.id, 'timeout'), e.left);
}

/** Shows a toast; returns its id (for dismiss). */
export function show(kind: ToastKind, message: string, opts: ToastOptions = {}): number {
  if (opts.key) { const old = entries.find((x) => x.key === opts.key); if (old) close(old.id, 'replaced'); }
  const duration = opts.duration ?? (opts.action ? ACTION_DURATION : DURATION[kind]);
  const e: Entry = { id: ++seq, kind, message, action: opts.action, duration, key: opts.key, onClose: opts.onClose, timer: null, left: duration, started: 0 };
  entries = [...entries, e];
  while (entries.length > MAX_VISIBLE) close(entries[0]!.id, 'replaced');
  if (!paused) arm(e);
  publish();
  return e.id;
}

/** Removes a toast (no-op when it is already gone). */
export function close(id: number, reason: CloseReason = 'dismiss'): void {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  entries = entries.filter((x) => x !== e);
  // nothing left to hover or focus: a pause can no longer be lifted by the host, so drop it (the next toast is armed)
  if (!entries.length) paused = false;
  publish();
  try { e.onClose?.(reason); } catch { /* a callback must not break the queue */ }
}

/** Runs the toast's action, then closes it with reason 'action'. */
export function runToastAction(id: number): void {
  const e = entries.find((x) => x.id === id);
  if (!e?.action) return;
  const run = e.action.run;
  close(id, 'action');
  void Promise.resolve().then(run).catch(() => undefined);
}

/** Runs the newest toast's action (ACTION_SHORTCUT); false when no toast has one. */
export function runLatestAction(): boolean {
  const e = [...entries].reverse().find((x) => x.action);
  if (!e) return false;
  runToastAction(e.id);
  return true;
}

/** the id of the newest toast with an action (the one ACTION_SHORTCUT runs), or null */
export function latestActionId(list: readonly Toast[]): number | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.action) return list[i]!.id;
  return null;
}

/**
 * The input mode (the host listens to keydown / pointerdown): keyboard use holds every toast with an action (its timer stops,
 * the time left is kept); pointer use starts them again (at least 1.5 s left, unless the region is paused anyway).
 */
export function setKeyboardUse(on: boolean): void {
  if (kbd === on) return;
  kbd = on;
  kbdStore.set(on);
  let changed = false;
  for (const e of entries) {
    if (!e.action || !e.duration) continue;
    if (on && e.timer) { clearTimeout(e.timer); e.timer = null; e.left = Math.max(0, e.left - (Date.now() - e.started)); changed = true; }
    else if (!on && !e.timer && !paused) { e.left = Math.max(e.left, 1500); arm(e); changed = true; }
  }
  if (changed) publish();
}

/** Pauses all timers (pointer/focus inside the toast region). */
export function pause(): void {
  paused = true;
  let changed = false;
  for (const e of entries) if (e.timer) { clearTimeout(e.timer); e.timer = null; e.left = Math.max(0, e.left - (Date.now() - e.started)); changed = true; }
  if (changed) publish();
}
/** Resumes paused timers (a toast never closes in less than 1.5 s after resuming). */
export function resume(): void {
  paused = false;
  let changed = false;
  for (const e of entries) if (!e.timer && e.duration) { e.left = Math.max(e.left, 1500); arm(e); changed = true; }
  if (changed) publish();
}
/** ms left before the toast closes by itself: frozen while paused, counting down while running; 0 when unknown or sticky */
export function timeLeft(id: number, now = Date.now()): number {
  const e = entries.find((x) => x.id === id);
  if (!e?.duration) return 0;
  return e.timer ? Math.max(0, e.left - (now - e.started)) : e.left;
}
export function dismissAll(): void { for (const e of [...entries]) close(e.id, 'replaced'); }
/** test hook: back to the initial state (not paused) */
export function resetToasts(): void { dismissAll(); paused = false; kbd = false; kbdStore.set(false); }

/** visible toasts, oldest first */
export const toasts: Readable<Toast[]> = { subscribe: list.subscribe };

export const toast = {
  success: (message: string, opts?: ToastOptions) => show('success', message, opts),
  error: (message: string, opts?: ToastOptions) => show('error', message, opts),
  info: (message: string, opts?: ToastOptions) => show('info', message, opts),
  show,
  close,
};
