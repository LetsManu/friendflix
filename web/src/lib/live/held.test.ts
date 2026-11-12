// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { pickHeld, type Held } from './held';

const h = (fatal: boolean, media = false): Held => ({ run: () => undefined, fatal, media });

describe('pickHeld', () => {
  it('holds the first thing met', () => {
    const a = h(false);
    expect(pickHeld(null, a)).toBe(a);
  });
  it('the latest refusal replaces a refusal', () => {
    const b = h(false);
    expect(pickHeld(h(false), b)).toBe(b);
  });
  it('a fatal error replaces a refusal', () => {
    const b = h(true);
    expect(pickHeld(h(false), b)).toBe(b);
  });
  it('a refusal never replaces a fatal error', () => {
    const a = h(true, true);
    expect(pickHeld(a, h(false))).toBe(a);
  });
  it('the first fatal error wins over a later one of the same kind', () => {
    const a = h(true, false);
    expect(pickHeld(a, h(true, false))).toBe(a);
    const m = h(true, true);
    expect(pickHeld(m, h(true, true))).toBe(m);
  });
  it('a fatal media error does not hide a fatal error that is not a media error', () => {
    const b = h(true, false);
    expect(pickHeld(h(true, true), b)).toBe(b);
  });
  it('a held fatal error that is not a media error stays against a later media error', () => {
    const a = h(true, false);
    expect(pickHeld(a, h(true, true))).toBe(a);
  });
});
