// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { canGoBack, historyIndex, resetBack, trackNav } from './back';

describe('in-app history depth ("‹ Back")', () => {
  beforeEach(() => resetBack());

  it('a deep link / reload has no in-app history; links and goto add one, popstate moves by its delta', () => {
    trackNav({ type: 'enter' });
    expect(canGoBack()).toBe(false);
    trackNav({ type: 'link' });
    expect(canGoBack()).toBe(true);
    trackNav({ type: 'goto' });
    trackNav({ type: 'popstate', delta: -1 });
    expect(canGoBack()).toBe(true);
    trackNav({ type: 'popstate', delta: -1 });
    expect(canGoBack()).toBe(false);
    trackNav({ type: 'popstate', delta: -1 }); // left the app's first entry: never below 0
    expect(canGoBack()).toBe(false);
    trackNav({ type: 'popstate', delta: 2 }); // forward again
    expect(canGoBack()).toBe(true);
    trackNav({ type: 'popstate' }); // no delta: one step back
    expect(canGoBack()).toBe(true);
    trackNav({ type: 'enter' });
    expect(canGoBack()).toBe(false);
  });

  it('form submissions and other types count as a new entry', () => {
    trackNav({ type: 'form' });
    expect(canGoBack()).toBe(true);
  });

  it('with the router\'s history index: a replaced entry adds no depth; Back to the first page ends it', () => {
    trackNav({ type: 'enter', index: 100 });
    trackNav({ type: 'goto', index: 100 }); // goto(..., { replaceState: true }): same entry
    expect(canGoBack()).toBe(false);
    trackNav({ type: 'link', index: 101 });
    expect(canGoBack()).toBe(true);
    trackNav({ type: 'popstate', delta: -1, index: 100 });
    expect(canGoBack()).toBe(false);
    trackNav({ type: 'popstate', delta: -1, index: 99 }); // before the session's first page: never below 0
    expect(canGoBack()).toBe(false);
  });

  it('reads the index from history.state (SvelteKit 3 metadata, SvelteKit 2 key), null otherwise', () => {
    expect(historyIndex({ 'sveltekit:metadata': { historyIndex: 7 } })).toBe(7);
    expect(historyIndex({ 'sveltekit:history': 3 })).toBe(3);
    expect(historyIndex({ 'sveltekit:metadata': { historyIndex: 'x' } })).toBeNull();
    expect(historyIndex({ 'sveltekit:metadata': null, 'sveltekit:history': 2 })).toBe(2);
    expect(historyIndex(null)).toBeNull();
    expect(historyIndex('x')).toBeNull();
  });
});
