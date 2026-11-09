// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_DURATION, ACTION_SHORTCUT, MAX_VISIBLE, RING_LEN, close, keyboardHold, latestActionId, pause, resetToasts, resume, runLatestAction, runToastAction, setKeyboardUse, timeLeft, toast, toasts } from './toast';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { resetToasts(); vi.useRealTimers(); });

describe('toast store', () => {
  it('a pause held when the last toast closes does not keep later toasts from timing out', () => {
    const id = toast.info('a', { action: { label: 'Undo', run: () => undefined } });
    pause(); // focus on the toast's button
    runToastAction(id); // the focused toast goes away: no focusout reaches the host
    toast.success('b');
    vi.advanceTimersByTime(5000);
    expect(get(toasts)).toHaveLength(0);
  });
  it('shows and auto-dismisses after the kind default', () => {
    const onClose = vi.fn();
    toast.success('Gespeichert.', { onClose });
    expect(get(toasts).map((x) => [x.kind, x.message])).toEqual([['success', 'Gespeichert.']]);
    vi.advanceTimersByTime(4999);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(get(toasts)).toHaveLength(0);
    expect(onClose).toHaveBeenCalledWith('timeout');
  });
  it('errors stay longer, duration 0 is sticky, actions get the action duration', () => {
    toast.error('x'); toast.info('sticky', { duration: 0 }); toast.info('a', { action: { label: 'Undo', run: () => undefined } });
    expect(get(toasts).find((x) => x.message === 'a')!.duration).toBe(ACTION_DURATION);
    vi.advanceTimersByTime(7000);
    expect(get(toasts).map((x) => x.message)).toEqual(['x', 'sticky']);
    vi.advanceTimersByTime(1000);
    expect(get(toasts).map((x) => x.message)).toEqual(['sticky']);
    vi.advanceTimersByTime(60_000);
    expect(get(toasts)).toHaveLength(1);
  });
  it(`stacks at most ${MAX_VISIBLE}; the oldest is replaced`, () => {
    const first = vi.fn();
    toast.info('1', { onClose: first }); toast.info('2'); toast.info('3'); toast.info('4');
    expect(get(toasts).map((x) => x.message)).toEqual(['2', '3', '4']);
    expect(first).toHaveBeenCalledWith('replaced');
  });
  it('a key replaces the toast with the same key', () => {
    toast.success('a', { key: 'k' }); toast.success('b', { key: 'k' });
    expect(get(toasts).map((x) => x.message)).toEqual(['b']);
  });
  it('runs the action once and closes with reason action', async () => {
    const run = vi.fn(), onClose = vi.fn();
    const id = toast.info('Abgelehnt', { action: { label: 'Rückgängig', run }, onClose });
    runToastAction(id); runToastAction(id);
    await Promise.resolve(); await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('action');
  });
  it('dismiss closes with reason dismiss; pause/resume hold the timer', () => {
    const onClose = vi.fn();
    const id = toast.info('p', { onClose });
    vi.advanceTimersByTime(4000);
    pause();
    vi.advanceTimersByTime(10_000);
    expect(get(toasts)).toHaveLength(1);
    resume();
    vi.advanceTimersByTime(1499);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledWith('timeout');
    const id2 = toast.info('q', { onClose });
    close(id2);
    expect(onClose).toHaveBeenLastCalledWith('dismiss');
    close(id); // already gone: no-op
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('actions default to 5 s', () => {
    expect(ACTION_DURATION).toBe(5000);
    expect(RING_LEN).toBe(69.1);
    const onClose = vi.fn();
    toast.success('Hinzugefügt', { action: { label: 'Rückgängig', run: () => undefined }, onClose });
    expect(get(toasts)[0]!.duration).toBe(5000);
    vi.advanceTimersByTime(4999);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledWith('timeout');
  });
  it('timeLeft while running, paused and after resume', () => {
    vi.setSystemTime(1_000_000);
    const id = toast.success('Hinzugefügt', { action: { label: 'Rückgängig', run: () => undefined } });
    expect(timeLeft(id)).toBe(5000);
    expect(get(toasts)[0]).toMatchObject({ started: 1_000_000, left: 5000 });
    vi.advanceTimersByTime(2000);
    expect(timeLeft(id)).toBe(3000);
    expect(timeLeft(id, Date.now() + 10_000)).toBe(0); // never below 0
    pause();
    expect(get(toasts)[0]).toMatchObject({ left: 3000 }); // republished on pause
    vi.advanceTimersByTime(1000);
    expect(timeLeft(id)).toBe(3000);
    pause(); // nothing running: no change
    resume();
    expect(get(toasts)[0]).toMatchObject({ started: Date.now(), left: 3000 }); // republished on resume
    expect(timeLeft(id)).toBeGreaterThanOrEqual(3000);
    vi.advanceTimersByTime(500);
    expect(timeLeft(id)).toBe(2500);
    resume(); // all running: no change
    expect(timeLeft(id)).toBe(2500);
  });
  it('an action that throws does not break the queue', async () => {
    const id = toast.info('x', { action: { label: 'Undo', run: () => { throw new Error('boom'); } } });
    runToastAction(id);
    await Promise.resolve(); await Promise.resolve();
    expect(get(toasts)).toHaveLength(0);
  });
  it('a toast that arrives while paused waits for resume', () => {
    const onClose = vi.fn();
    toast.info('first');
    pause();
    const id = toast.success('later', { action: { label: 'Rückgängig', run: () => undefined }, onClose });
    expect(timeLeft(id)).toBe(5000);
    vi.advanceTimersByTime(20_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(timeLeft(id)).toBe(5000);
    resume();
    vi.advanceTimersByTime(4999);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledWith('timeout');
  });
  it('sticky toasts report 0', () => {
    const id = toast.info('sticky', { duration: 0 });
    expect(timeLeft(id)).toBe(0);
    expect(timeLeft(9999)).toBe(0); // unknown
  });
});

describe('keyboard use (WCAG 2.2.1)', () => {
  const undo = () => ({ label: 'Undo', run: vi.fn() });
  it('an action toast stays while the last input was a key; a plain toast still times out', () => {
    setKeyboardUse(true);
    expect(get(keyboardHold)).toBe(true);
    toast.info('added', { action: undo() });
    toast.success('saved');
    vi.advanceTimersByTime(60_000);
    expect(get(toasts).map((x) => x.message)).toEqual(['added']);
  });
  it('keyboard use holds a running action toast with the time it had left; a pointer press starts it again (at least 1.5 s)', () => {
    const id = toast.info('added', { action: undo() });
    vi.advanceTimersByTime(4000);
    setKeyboardUse(true);
    expect(timeLeft(id)).toBe(1000);
    vi.advanceTimersByTime(30_000);
    expect(get(toasts)).toHaveLength(1);
    setKeyboardUse(false);
    expect(get(keyboardHold)).toBe(false);
    expect(timeLeft(id)).toBe(1500);
    vi.advanceTimersByTime(1499);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(get(toasts)).toHaveLength(0);
  });
  it('a pointer press while the region is paused (pointer or focus on it) keeps the toast paused', () => {
    setKeyboardUse(true);
    toast.info('added', { action: undo() });
    pause();
    setKeyboardUse(false);
    vi.advanceTimersByTime(30_000);
    expect(get(toasts)).toHaveLength(1);
    resume();
    vi.advanceTimersByTime(ACTION_DURATION);
    expect(get(toasts)).toHaveLength(0);
  });
  it(`${ACTION_SHORTCUT} runs the newest toast's action (and closes it); nothing to run gives false`, async () => {
    expect(ACTION_SHORTCUT).toBe('Alt+Z');
    expect(runLatestAction()).toBe(false);
    const older = undo(), newer = undo();
    toast.info('one', { action: older });
    const id = toast.info('two', { action: newer });
    toast.success('plain');
    expect(latestActionId(get(toasts))).toBe(id);
    expect(runLatestAction()).toBe(true);
    await Promise.resolve();
    expect(newer.run).toHaveBeenCalledTimes(1);
    expect(older.run).not.toHaveBeenCalled();
    expect(get(toasts).map((x) => x.message)).toEqual(['one', 'plain']);
    expect(latestActionId([])).toBeNull();
  });
});
