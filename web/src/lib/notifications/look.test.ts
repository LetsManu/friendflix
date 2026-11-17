// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { actionKeyOf, iconOf, sectionLabel, toneOf } from './look';
import type { Category } from './types';

const CATS: Category[] = ['downloads', 'devices', 'series', 'achievements', 'livetv', 'system', 'requests', 'social', 'other'];

describe('notification look', () => {
  it('gives every category an icon that Icon.svelte draws', () => {
    const src = readFileSync(new URL('../Icon.svelte', import.meta.url), 'utf8');
    for (const c of CATS) expect(src, c).toContain(`name === '${iconOf(c)}'`);
  });
  it('maps tones', () => {
    expect(toneOf('downloads')).toBe('ok');
    expect(toneOf('devices')).toBe('info');
    expect(toneOf('system')).toBe('acc');
    expect(toneOf('achievements')).toBe('gold');
    expect(toneOf('downloads', 'download_expiring')).toBe('warn');
    expect(toneOf('requests', 'access_soon')).toBe('warn');
    expect(toneOf('social')).toBe('neutral');
  });
  it('maps the action key', () => {
    expect(actionKeyOf('downloads', 'download_ready')).toBe('notes.action.view');
    expect(actionKeyOf('series', 'new_episode')).toBe('notes.action.view');
    expect(actionKeyOf('devices', 'new_device')).toBe('notes.action.devices');
    expect(actionKeyOf('system', 'update_available')).toBe('notes.action.update');
    expect(actionKeyOf('social', 'party_invite')).toBe('notes.action.open');
  });
  it('labels months, adding the year when it is not this one', () => {
    const y = new Date().getFullYear();
    expect(sectionLabel(`${y}-10`, 'de')).toBe('Oktober');
    expect(sectionLabel('2025-10', 'de')).toBe(y === 2025 ? 'Oktober' : 'Oktober 2025');
  });
});
