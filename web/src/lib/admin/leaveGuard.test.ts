// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  before: null as null | ((nav: unknown) => void),
  after: null as null | (() => void),
  goto: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
}));
vi.mock('$app/navigation', () => ({
  beforeNavigate: (cb: (nav: unknown) => void) => { h.before = cb; },
  afterNavigate: (cb: () => void) => { h.after = cb; },
  goto: h.goto,
}));
vi.mock('#lib/ui/confirm', () => ({ confirm: h.confirm }));

const { leaveGuard, rerunOf } = await import('./leaveGuard');

const target = (href: string) => ({ url: new URL(href, 'https://ff.example.org'), params: {}, route: { id: null } });
const nav = (type: string, from: string, to: string | null, extra: Record<string, unknown> = {}) => ({
  type, from: target(from), to: to === null ? null : target(to), willUnload: false, cancel: vi.fn(), ...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('rerunOf', () => {
  it('Back/Forward goes the same delta through history', () => {
    expect(rerunOf(nav('popstate', '/admin/users/a?tab=rights', '/admin/users', { delta: -1 }) as never)).toEqual({ go: -1 });
    expect(rerunOf(nav('popstate', '/admin/roles', '/admin', { delta: -2 }) as never)).toEqual({ go: -2 });
  });
  it('a same-route change (tab switch) replaces its entry, another page pushes', () => {
    const tab = rerunOf(nav('goto', '/admin/users/a?tab=rights', '/admin/users/a?tab=audit') as never);
    expect(tab).toMatchObject({ replace: true });
    expect(rerunOf(nav('link', '/admin/users/a?tab=rights', '/admin/users') as never)).toMatchObject({ replace: false });
  });
  it('an unload or a navigation without a target runs nothing again', () => {
    expect(rerunOf(nav('leave', '/admin/roles', null, { willUnload: true }) as never)).toBeNull();
    expect(rerunOf(nav('link', '/admin/roles', 'https://other.example.org/', { willUnload: true }) as never)).toBeNull();
  });
});

describe('leaveGuard', () => {
  let dirty = true;
  const back = vi.fn();
  beforeEach(() => {
    dirty = true; h.goto.mockClear(); h.confirm.mockClear(); h.confirm.mockResolvedValue(true); back.mockClear();
    vi.stubGlobal('history', { go: back });
    leaveGuard(() => dirty, () => ({ title: 'Leave?' }));
  });

  it('nothing staged: no question, no cancel', () => {
    dirty = false;
    const n = nav('link', '/admin/roles', '/admin');
    h.before!(n);
    expect(n.cancel).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it('a confirmed Back goes back through history, never a push', async () => {
    const n = nav('popstate', '/admin/users/a?tab=rights', '/admin/users', { delta: -1 });
    h.before!(n);
    expect(n.cancel).toHaveBeenCalled();
    await flush();
    expect(back).toHaveBeenCalledWith(-1);
    expect(h.goto).not.toHaveBeenCalled();
  });
  it('a confirmed tab switch replaces the entry; the guard watches again once it landed', async () => {
    h.before!(nav('goto', '/admin/users/a?tab=rights', '/admin/users/a?tab=audit'));
    await flush();
    expect(h.goto).toHaveBeenCalledWith(new URL('https://ff.example.org/admin/users/a?tab=audit'), { replace: true, reset: false });
    // while it runs, the navigation itself passes
    const again = nav('goto', '/admin/users/a?tab=rights', '/admin/users/a?tab=audit');
    h.before!(again);
    expect(again.cancel).not.toHaveBeenCalled();
    h.after!();
    const later = nav('link', '/admin/users/a?tab=audit', '/admin');
    h.before!(later);
    expect(later.cancel).toHaveBeenCalled();
  });
  it('Abbrechen stays', async () => {
    h.confirm.mockResolvedValue(false);
    h.before!(nav('link', '/admin/roles', '/admin'));
    await flush();
    expect(h.goto).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });
  it('an unload is left to the browser', () => {
    const n = nav('leave', '/admin/roles', null, { willUnload: true });
    h.before!(n);
    expect(n.cancel).toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});
