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
import { forgotPinShown, pinLockedKey } from '../pinLock';

// A PIN lock can last hours (escalating lockout). "Try again later" names the way out, "Forgot PIN?", only where that button is shown
// (the owner's own PIN, no kids lock); everywhere else (another profile, the owner PIN that leaves a kids profile, a kid-locked
// device, the edit dialog) it stays neutral (review round 2, d).
const LOCALES = { de, en, es, fr, it: it_, pl, tr };

describe('PIN lock text', () => {
  it.each(Object.entries(LOCALES))('%s: only the "forgot" variant points to the forgotten-PIN link, by its own label', (_code, d) => {
    const profiles = d.account?.profiles;
    expect(profiles?.forgotPin).toBeTruthy();
    expect(profiles?.pinLockedLaterForgot).toContain(profiles?.forgotPin);
    expect(profiles?.pinLockedLater).not.toContain(profiles?.forgotPin);
  });
  it('picks the text by the wait and by whether the button is shown', () => {
    expect(forgotPinShown({ isOwner: true, pinOwner: false, kidsLock: null })).toBe(true);
    expect(forgotPinShown({ isOwner: false, pinOwner: false, kidsLock: null })).toBe(false); // another profile's PIN
    expect(forgotPinShown({ isOwner: true, pinOwner: true, kidsLock: null })).toBe(false); // the owner PIN asked to leave a kids profile
    expect(forgotPinShown({ isOwner: true, pinOwner: false, kidsLock: 'p-kid' })).toBe(false); // a device locked to a kids profile
    expect(pinLockedKey(1800, true)).toBe('account.profiles.pinLockedLaterForgot');
    expect(pinLockedKey(1800, false)).toBe('account.profiles.pinLockedLater');
    expect(pinLockedKey(900, true)).toBe('account.profiles.pinLocked');
    expect(pinLockedKey(undefined, false)).toBe('account.profiles.pinLocked');
  });
});
