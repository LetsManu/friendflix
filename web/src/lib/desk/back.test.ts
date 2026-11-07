// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { canGoBack, resetBack, trackNav } from './back';

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
});
