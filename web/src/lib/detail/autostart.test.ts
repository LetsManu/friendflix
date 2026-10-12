import { describe, expect, it } from 'vitest';
import { autoStartAllowed, countdownLabel, previewDone, type AutoStartEnv } from './autostart';

const base: AutoStartEnv = { pref: true, touch: false, tv: false, hidden: false, reducedMotion: false, previewing: true, hasTarget: true, cancelled: false };

describe('autoStartAllowed', () => {
  it('runs only with a playing preview, a target, a visible tab and the pref on (missing = on)', () => {
    expect(autoStartAllowed(base)).toBe(true);
    expect(autoStartAllowed({ ...base, pref: undefined })).toBe(true);
    expect(autoStartAllowed({ ...base, pref: false })).toBe(false);
    expect(autoStartAllowed({ ...base, previewing: false })).toBe(false);
    expect(autoStartAllowed({ ...base, hasTarget: false })).toBe(false);
    expect(autoStartAllowed({ ...base, hidden: true })).toBe(false);
  });
  it('never on touch, TV, reduced motion or after cancelling', () => {
    expect(autoStartAllowed({ ...base, touch: true })).toBe(false);
    expect(autoStartAllowed({ ...base, tv: true })).toBe(false);
    expect(autoStartAllowed({ ...base, reducedMotion: true })).toBe(false);
    expect(autoStartAllowed({ ...base, cancelled: true })).toBe(false);
  });
});

describe('previewDone / countdownLabel', () => {
  it('ended or 25 s', () => {
    expect(previewDone(true, 3)).toBe(true);
    expect(previewDone(false, 24.9)).toBe(false);
    expect(previewDone(false, 25)).toBe(true);
    expect(previewDone(false, NaN)).toBe(false);
  });
  it('labels', () => {
    expect(countdownLabel('episode', 4.2)).toBe('Folge startet in 5 …');
    expect(countdownLabel('movie', 0)).toBe('Film startet in 0 …');
  });
});
