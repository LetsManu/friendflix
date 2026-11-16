// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { resumeAfterSwitch } from './switchresume';

describe('resumeAfterSwitch (audio track, quality, surround, downloaded subtitle)', () => {
  const base = { wasPlaying: false, pending: false, result: undefined, pausedSince: false, failed: false } as const;
  it('a playing video resumes on the new stream', () => {
    expect(resumeAfterSwitch({ ...base, wasPlaying: true })).toBe(true);
  });
  it('a paused video stays paused', () => {
    expect(resumeAfterSwitch(base)).toBe(false);
  });
  it('a start that was still pending (switched before the first frame) survives the switch', () => {
    expect(resumeAfterSwitch({ ...base, pending: true })).toBe(true);
  });
  it('a refused switch (server busy, its error is shown) does not start anything', () => {
    expect(resumeAfterSwitch({ ...base, wasPlaying: true, pending: true, result: 'busy' })).toBe(false);
  });
  it('the viewer paused while the switch was on its way: stays paused', () => {
    expect(resumeAfterSwitch({ ...base, wasPlaying: true, pausedSince: true })).toBe(false);
    expect(resumeAfterSwitch({ ...base, pending: true, pausedSince: true })).toBe(false);
  });
  it('a switch that ended in an error without a new stream starts nothing later (no autoplay on a later canplay)', () => {
    expect(resumeAfterSwitch({ ...base, wasPlaying: true, failed: true })).toBe(false);
    expect(resumeAfterSwitch({ ...base, pending: true, failed: true })).toBe(false);
  });
});
