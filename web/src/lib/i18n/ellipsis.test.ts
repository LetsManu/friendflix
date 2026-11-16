// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import de from './locales/de/index';
import en from './locales/en/index';
import es from './locales/es/index';
import fr from './locales/fr/index';
import it_ from './locales/it/index';
import pl from './locales/pl/index';
import tr from './locales/tr/index';

const LOCALES: Record<string, object> = { de, en, es, fr, it: it_, pl, tr };

/** every string value of a nested dictionary, with its dotted key (plural objects: each form) */
function strings(o: object, p = ''): Array<[string, string]> {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[p + k, v] as [string, string]] : v && typeof v === 'object' ? strings(v as object, `${p}${k}.`) : []));
}
const pick = (o: object, key: string): unknown => key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);

/** menu and action labels that open more input */
const MENU_LABELS = ['detail.lists.addMore', 'player.subs.searchMenu', 'fresh.admin.menu', 'adminContent.hygiene.search'];

describe('ellipsis', () => {
  it('no locale string uses three ASCII dots', () => {
    for (const [code, d] of Object.entries(LOCALES))
      for (const [k, v] of strings(d)) expect(v, `${code} ${k}`).not.toMatch(/\.\.\./);
  });
  it('menu labels glue their ellipsis (no space before "…")', () => {
    for (const [code, d] of Object.entries(LOCALES))
      for (const key of MENU_LABELS) {
        const v = pick(d, key);
        expect(typeof v, `${code} ${key}`).toBe('string');
        expect(v as string, `${code} ${key}`).toMatch(/\S…$/);
      }
  });
});
