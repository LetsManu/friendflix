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

// A PIN lock can now last hours (escalating lockout): "try again later" names the way out, the "Forgot PIN?" link next to it.
const LOCALES = { de, en, es, fr, it: it_, pl, tr };

describe('PIN lock text', () => {
  it.each(Object.entries(LOCALES))('%s: "try again later" points to the forgotten-PIN link by its own label', (_code, d) => {
    const label = d.account.profiles.forgotPin;
    expect(d.account.profiles.pinLockedLater).toContain(label);
  });
});
