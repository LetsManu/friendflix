import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
vi.mock('#lib/api', () => ({ api: (...a: unknown[]) => api(...a) }));
const { listIds, toggleList } = await import('./stores');

beforeEach(() => { api.mockReset(); listIds.set(new Set()); });

describe('toggleList', () => {
  it('adds optimistically and resolves true', async () => {
    api.mockResolvedValue({});
    const p = toggleList('x', false);
    expect(get(listIds).has('x')).toBe(true);
    expect(await p).toBe(true);
    expect(api).toHaveBeenCalledWith('/api/items/x/watchlist', { method: 'POST' });
  });
  it('rolls back and resolves false on failure', async () => {
    api.mockRejectedValue(new Error('x'));
    expect(await toggleList('x', false)).toBe(false);
    expect(get(listIds).has('x')).toBe(false);
  });
  it('ignores a second toggle while the first is in flight', async () => {
    let done!: () => void;
    api.mockImplementation(() => new Promise<void>((r) => (done = r)));
    const a = toggleList('x', false), b = await toggleList('x', true);
    expect(b).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
    done(); await a;
    expect(get(listIds).has('x')).toBe(true);
  });
});
