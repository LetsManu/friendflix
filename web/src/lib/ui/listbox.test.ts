// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { nextEnabled, pageMove, typeahead, wantsGlassList, type ListOpt } from './listbox';
import type { SelectOption } from './Select.svelte';

const o = (label: string, disabled = false): ListOpt => ({ value: label.toLowerCase(), label, disabled });

describe('glass listbox (Select on desktop)', () => {
  it('nextEnabled skips disabled options and stops at the ends', () => {
    const opts = [o('A'), o('B', true), o('C'), o('D', true)];
    expect(nextEnabled(opts, 0, 'next')).toBe(2);
    expect(nextEnabled(opts, 2, 'prev')).toBe(0);
    expect(nextEnabled(opts, 2, 'next')).toBe(2); // no wrap: the last enabled one stays
    expect(nextEnabled(opts, 0, 'prev')).toBe(0);
    expect(nextEnabled(opts, -1, 'next')).toBe(0);
    expect(nextEnabled(opts, -1, 'prev')).toBe(2);
    // from a disabled current (a "choose…" placeholder) the moves land on enabled options
    const ph = [o('Wählen', true), o('X'), o('Y')];
    expect(nextEnabled(ph, 0, 'next')).toBe(1);
    expect(nextEnabled(ph, 0, 'prev')).toBe(1);
  });

  it('first and last pick the outermost enabled options', () => {
    const opts = [o('A', true), o('B'), o('C'), o('D', true)];
    expect(nextEnabled(opts, 2, 'first')).toBe(1);
    expect(nextEnabled(opts, 1, 'last')).toBe(2);
    expect(nextEnabled(opts, -1, 'last')).toBe(2);
  });

  it('no enabled option gives -1', () => {
    const opts = [o('A', true), o('B', true)];
    for (const m of ['next', 'prev', 'first', 'last'] as const) expect(nextEnabled(opts, 0, m), m).toBe(-1);
    expect(nextEnabled([], -1, 'next')).toBe(-1);
  });

  it('pageMove steps a page of enabled options and stops at the ends', () => {
    const opts = [o('A'), o('B'), o('C', true), o('D'), o('E'), o('F'), o('G')];
    expect(pageMove(opts, 0, 'next', 3)).toBe(4); // B, D, E: the disabled C does not count
    expect(pageMove(opts, 4, 'next', 3)).toBe(6); // clamped at the last
    expect(pageMove(opts, 6, 'prev', 3)).toBe(3);
    expect(pageMove(opts, 1, 'prev', 3)).toBe(0); // clamped at the first
    expect(pageMove(opts, 0, 'next', 0)).toBe(1); // at least one row
    expect(pageMove([o('A', true)], 0, 'next', 3)).toBe(-1);
  });

  it('typeahead is case- and accent-insensitive, starts after the current and wraps', () => {
    const opts = [o('Albanien'), o('Deutschland'), o('Österreich'), o('Schweiz'), o('Andorra'), o('Ägypten', true)];
    expect(typeahead(opts, 'ö', -1)).toBe(2);
    expect(typeahead(opts, 'O', 0)).toBe(2);
    expect(typeahead(opts, 'oster', 0)).toBe(2);
    expect(typeahead(opts, 'a', 0)).toBe(4); // after the current
    expect(typeahead(opts, 'a', 4)).toBe(0); // from the last "A…" it wraps (the disabled Ägypten is skipped)
    expect(typeahead(opts, 'sch', 3)).toBe(3); // only the current matches: it stays
    expect(typeahead(opts, 'z', 0)).toBe(-1);
  });

  it('wantsGlassList only on a desktop pointer, never on TV', () => {
    expect(wantsGlassList({ tv: false, coarse: false, hover: true })).toBe(true);
    expect(wantsGlassList({ tv: true, coarse: false, hover: true })).toBe(false);
    expect(wantsGlassList({ tv: false, coarse: true, hover: true })).toBe(false);
    expect(wantsGlassList({ tv: false, coarse: false, hover: false })).toBe(false);
    const s: SelectOption = { value: 'x', label: 'X' };
    const l: ListOpt = s; // SelectOption is assignable
    expect(l.value).toBe('x');
  });
});
