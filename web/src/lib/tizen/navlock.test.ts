// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { installNavLock, isBlockedLink } from './navlock';

const BASE = 'https://friend.example.com/';
describe('isBlockedLink', () => {
  it('lets own origin, relative and allowed links through', () => {
    expect(isBlockedLink('/item/1', BASE, ['https://friend.example.com'])).toBe(false);
    expect(isBlockedLink('https://auth.example.com/login', BASE, ['https://friend.example.com', 'https://auth.example.com'])).toBe(false);
  });
  it('blocks other http(s) origins', () => {
    expect(isBlockedLink('https://other.example.net/x', BASE, ['https://friend.example.com'])).toBe(true);
    expect(isBlockedLink('http://friend.example.com/x', BASE, ['https://friend.example.com'])).toBe(true);
  });
  it('ignores non-http(s) and empty links', () => {
    expect(isBlockedLink('mailto:a@example.com', BASE, [])).toBe(false);
    expect(isBlockedLink('javascript:void(0)', BASE, [])).toBe(false);
    expect(isBlockedLink(null, BASE, [])).toBe(false);
  });
});

describe('installNavLock', () => {
  const setup = async (authOrigin: unknown, stored: string | null = null) => {
    const l: Array<(e: any) => void> = [];
    const doc = { addEventListener: (_t: string, f: any, cap?: boolean) => { expect(cap).toBe(true); l.push(f); }, removeEventListener: (_t: string, f: any) => void l.splice(l.indexOf(f), 1) };
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ authOrigin }) })) as unknown as typeof fetch;
    const off = installNavLock({ doc, base: BASE, fetchImpl, storage: { getItem: () => stored } });
    await new Promise((r) => setTimeout(r, 0));
    const click = (href: string | null) => {
      const e = { target: { closest: () => (href === null ? null : { getAttribute: () => href }) }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      l.forEach((f) => f(e));
      return e;
    };
    return { click, off, l, fetchImpl };
  };
  it('blocks foreign links and keeps own and sign-in origin links', async () => {
    const { click } = await setup('https://auth.example.com');
    expect(click('https://other.example.net/').preventDefault).toHaveBeenCalled();
    expect(click('/watch/1').preventDefault).not.toHaveBeenCalled();
    expect(click('https://auth.example.com/flow').preventDefault).not.toHaveBeenCalled();
    expect(click(null).preventDefault).not.toHaveBeenCalled();
  });
  it('accepts the stored auth origin and survives a missing one', async () => {
    const { click } = await setup(null, 'https://auth.example.com');
    expect(click('https://auth.example.com/x').preventDefault).not.toHaveBeenCalled();
    expect(click('https://other.example.net/').preventDefault).toHaveBeenCalled();
  });
  it('fetches /api/version and uninstalls', async () => {
    const { off, l, fetchImpl } = await setup('https://auth.example.com');
    expect((fetchImpl as any).mock.calls[0][0]).toBe('/api/version');
    off();
    expect(l).toHaveLength(0);
  });
});
