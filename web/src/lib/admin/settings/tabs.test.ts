// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingGroup, SettingsGroupView, SettingView } from './api';
import { highlightSetting } from './highlight';
import { SETTINGS_TABS, TAB_GROUPS, dirtyTabs, tabHref, tabOf, tabOfGroup, tabOfKey } from './tabs';

/** every registry group (backend/src/settings/registry.ts SettingGroup) */
const GROUPS: SettingGroup[] = ['general', 'signin', 'media', 'requests', 'notifications', 'push', 'mail', 'sources', 'downloads', 'playback', 'livetv',
  'recommendations', 'updates', 'health', 'sessions'];
const row = (key: string): SettingView => ({ key, kind: 'string', source: 'default', value: null, set: false, apply: 'live', restartPending: false, invalid: false, envNames: [key], updatedAt: null });
const view = (spec: Record<string, string[]>): SettingsGroupView[] => Object.entries(spec).map(([id, keys]) => ({ id: id as SettingsGroupView['id'], items: keys.map(row) }));
const GROUP_VIEW = view({
  general: ['PUBLIC_URL'], signin: ['AUTHENTIK_API_TOKEN'], requests: ['REQUESTS_URL'],
  updates: ['PORTAINER_URL', 'PORTAINER_API_KEY'], livetv: ['LIVETV_ENCODER'], server: ['PORT'],
});

describe('settings tabs', () => {
  it('six tabs in the spec order', () => {
    expect(SETTINGS_TABS).toEqual(['general', 'signin', 'media', 'playback', 'updates', 'notifications']);
  });

  it('every registry group except livetv maps to exactly one tab', () => {
    for (const g of GROUPS) {
      const tabs = SETTINGS_TABS.filter((t) => TAB_GROUPS[t].includes(g));
      expect(tabs, g).toHaveLength(g === 'livetv' ? 0 : 1);
      expect(tabOfGroup(g)).toBe(g === 'livetv' ? 'livetv' : tabs[0]);
    }
    expect(TAB_GROUPS.media).toEqual(['media', 'requests', 'sources', 'recommendations']);
  });

  it('mail is on the notifications tab', () => {
    expect(tabOfGroup('mail')).toBe('notifications');
    expect(TAB_GROUPS.notifications).toEqual(['notifications', 'push', 'mail']);
  });

  it("tabOf('nope') → general; a known tab is kept", () => {
    expect(tabOf('nope')).toBe('general');
    expect(tabOf(null)).toBe('general');
    expect(tabOf('updates')).toBe('updates');
  });

  it("tabOfKey('PORTAINER_API_KEY') → updates; LIVETV_ENCODER → livetv; a server value → general; unknown → null", () => {
    expect(tabOfKey('PORTAINER_API_KEY', GROUP_VIEW)).toBe('updates');
    expect(tabOfKey('LIVETV_ENCODER', GROUP_VIEW)).toBe('livetv');
    expect(tabOfKey('REQUESTS_URL', GROUP_VIEW)).toBe('media');
    expect(tabOfKey('PORT', GROUP_VIEW)).toBe('general');
    expect(tabOfKey('UNKNOWN', GROUP_VIEW)).toBeNull();
  });

  it('dirtyTabs marks media when REQUESTS_URL changed', () => {
    const changes = { requests: { REQUESTS_URL: 'http://requests:5055' }, general: {}, push: { VAPID_SUBJECT: 'mailto:x@example.com' } } as unknown as Record<SettingGroup, Record<string, unknown>>;
    expect([...dirtyTabs(changes)].sort()).toEqual(['media', 'notifications']);
    expect(dirtyTabs({} as Record<SettingGroup, Record<string, unknown>>).size).toBe(0);
  });

  it('tabHref: the default tab has no parameter', () => {
    expect(tabHref('general')).toBe('/admin/settings');
    expect(tabHref('media')).toBe('/admin/settings?tab=media');
  });
});

/** a row of the page as far as highlightSetting uses it, with listeners on a fake window */
function fakeDom(ids: Record<string, string[]>) {
  const listeners = new Map<string, Set<() => void>>();
  const rows = new Map<string, { dataset: Record<string, string>; scrollIntoView: ReturnType<typeof vi.fn>; focused: string | null; querySelector(sel: string): { focus(o: unknown): void } | null }>();
  for (const [key, controls] of Object.entries(ids)) {
    const r = {
      dataset: {} as Record<string, string>, scrollIntoView: vi.fn(), focused: null as string | null, focusOpts: null as unknown,
      querySelector: (sel: string) => {
        expect(sel).toMatch(/input:not\(\[disabled\]\)/);
        const c = controls[0];
        return c ? { focus: (o: unknown) => { r.focused = c; r.focusOpts = o; } } : null;
      },
    };
    rows.set(`setting-${key}`, r);
  }
  vi.stubGlobal('document', { getElementById: (id: string) => rows.get(id) ?? null });
  vi.stubGlobal('window', {
    addEventListener: (t: string, f: () => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); },
    removeEventListener: (t: string, f: () => void) => listeners.get(t)?.delete(f),
    matchMedia: () => ({ matches: false }),
  });
  return { row: (key: string) => rows.get(`setting-${key}`)! as ReturnType<typeof rows.get> & { focusOpts: unknown }, fire: (t: string) => { for (const f of [...(listeners.get(t) ?? [])]) f(); } };
}

describe('highlightSetting', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('scrolls the row to the centre, focuses its first enabled control without scrolling, and flashes 2.4 s', async () => {
    vi.useFakeTimers();
    const dom = fakeDom({ PUBLIC_URL: ['move'] });
    expect(await highlightSetting('PUBLIC_URL', { reducedMotion: false })).toBe(true);
    const r = dom.row('PUBLIC_URL')!;
    expect(r.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(r.focused).toBe('move');
    expect(r.focusOpts).toEqual({ preventScroll: true });
    expect(r.dataset.flash).toBe('');
    vi.advanceTimersByTime(2_400);
    expect(r.dataset.flash).toBeUndefined();
  });

  it('reduced motion (asked, or by the system): no smooth scroll, a static outline until the next pointer or key press', async () => {
    const dom = fakeDom({ X: ['select'] });
    (window as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: true });
    expect(await highlightSetting('X')).toBe(true);
    const r = dom.row('X')!;
    expect(r.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(r.dataset.flash).toBe('static');
    dom.fire('keydown');
    expect(r.dataset.flash).toBeUndefined();
    // a row with nothing to focus is still highlighted
    fakeDom({ Y: [] });
    expect(await highlightSetting('Y', { reducedMotion: true })).toBe(true);
  });

  it('a key that is not on the page → false; a malformed key is never looked up', async () => {
    fakeDom({ A: [] });
    expect(await highlightSetting('B')).toBe(false);
    expect(await highlightSetting('a"]')).toBe(false);
  });
});
