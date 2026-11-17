// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/api', () => ({ getCsrf: () => '' }));
import { safeRedirect } from './safeRedirect';
import { safeNext as gateNext } from './gate';
import { safeNext as flowNext } from './auth/flow';

// every value below is what the page sees AFTER URLSearchParams decoded `?next=` (so `%09` arrives as a real tab)
const BYPASSES = [
  '/\t/evil.example.com', // ?next=/%09/evil.example.com: the URL parser drops the tab and goes to //evil.example.com
  '/\n/evil.example.com',
  '/\r/evil.example.com',
  '/\t\t/evil.example.com',
  '\t//evil.example.com',
  '//evil.example.com',
  '///evil.example.com',
  '/\\evil.example.com',
  '\\/evil.example.com',
  '/x\\..\\..\\/evil.example.com',
  '/.//evil.example.com', // dot segments: the parsed path is //evil.example.com
  '/..//evil.example.com',
  '/x/..//evil.example.com',
  'https://evil.example.com/',
  'HTTPS://evil.example.com/',
  'javascript:alert(1)',
  'data:text/html,hi',
  ' /x',
  '/x\u0000',
  '/x\u007f',
  'evil.example.com',
  '',
];

describe('safeRedirect', () => {
  it('keeps same-origin relative paths with their query and fragment', () => {
    expect(safeRedirect('/')).toBe('/');
    expect(safeRedirect('/kids')).toBe('/kids');
    expect(safeRedirect('/item/abc?x=1#cast')).toBe('/item/abc?x=1#cast');
    expect(safeRedirect('/search?q=a%20b')).toBe('/search?q=a%20b');
    expect(safeRedirect('/a/./b/../c')).toBe('/a/c');
  });
  it.each(BYPASSES)('refuses %j', (bad) => {
    expect(safeRedirect(bad)).toBe('/');
    expect(safeRedirect(bad, '/kids')).toBe('/kids');
  });
  it('refuses non-strings', () => {
    for (const bad of [null, undefined, 42, {}, ['/x']]) expect(safeRedirect(bad)).toBe('/');
  });
  it('gate.safeNext and flow.safeNext use the same rule', () => {
    for (const bad of BYPASSES) {
      expect(gateNext(bad)).toBe('/');
      expect(flowNext(bad)).toBe('/');
    }
    expect(gateNext(null, '/kids')).toBe('/kids');
    expect(gateNext('/live')).toBe('/live');
    expect(flowNext('/pending')).toBe('/pending');
  });
});
