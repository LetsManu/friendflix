import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api';
import { busyKeys, errorText, isBusy, runAction } from './action';
import { dismissAll, runToastAction, toasts } from './toast';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { dismissAll(); vi.useRealTimers(); });

describe('runAction', () => {
  it('applies optimistically, toasts success and clears the busy flag', async () => {
    let v = 'old';
    const p = runAction({ key: 'k1', apply: () => { const prev = v; v = 'new'; return () => (v = prev); }, run: async () => 42, success: (r) => `ok ${r}` });
    expect(v).toBe('new');
    expect(isBusy('k1')).toBe(true);
    expect(get(busyKeys).has('k1')).toBe(true);
    expect(await p).toEqual({ ok: true, value: 42 });
    expect(isBusy('k1')).toBe(false);
    expect(get(toasts).map((x) => [x.kind, x.message])).toEqual([['success', 'ok 42']]);
  });
  it('rolls back and shows a status-aware error', async () => {
    let v = 'old';
    const r = await runAction({ apply: () => { v = 'new'; return () => (v = 'old'); }, run: () => Promise.reject(new ApiError(403, {})) });
    expect(r.ok).toBe(false);
    expect(v).toBe('old');
    expect(get(toasts)[0]).toMatchObject({ kind: 'error', message: errorText(new ApiError(403, {})) });
  });
  it('skips a second call with a busy key', async () => {
    let done!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (done = r)));
    const a = runAction({ key: 'k2', run });
    expect(await runAction({ key: 'k2', run })).toEqual({ ok: false, skipped: true });
    done(); await a;
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('undo calls the inverse and restores the local state', async () => {
    let v = 'a';
    const inverse = vi.fn(async () => undefined);
    await runAction({ key: 'k3', apply: () => { v = 'b'; return () => (v = 'a'); }, run: async () => undefined, success: 'Gesperrt', undo: { run: inverse } });
    const t = get(toasts)[0]!;
    expect(t.action).toBeTruthy();
    runToastAction(t.id);
    await vi.runAllTimersAsync();
    expect(inverse).toHaveBeenCalledTimes(1);
    expect(v).toBe('a');
  });
  it('defer: commits only after the toast is gone; undo just rolls back', async () => {
    let v = 'a';
    const run = vi.fn(async () => 'done');
    const apply = () => { v = 'b'; return () => (v = 'a'); };
    const p1 = runAction({ key: 'd', apply, run, defer: 1000, success: 'Abgelehnt' });
    expect(v).toBe('b');
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(await p1).toEqual({ ok: true, value: 'done' });
    expect(run).toHaveBeenCalledTimes(1);

    const p2 = runAction({ key: 'd', apply, run, defer: true, success: 'Abgelehnt' });
    runToastAction(get(toasts).at(-1)!.id);
    expect(await p2).toEqual({ ok: false, undone: true });
    expect(v).toBe('a');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('maps errors to texts', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe(errorText(new TypeError('x')));
    expect(errorText(new ApiError(500, null))).not.toBe(errorText(new ApiError(404, null)));
  });
});
