// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { resumeAfterSwitch } from './switchresume';

describe('resumeAfterSwitch (audio track, quality, surround, downloaded subtitle)', () => {
  it('a playing video resumes on the new stream', () => {
    expect(resumeAfterSwitch({ wasPlaying: true, pending: false, result: undefined })).toBe(true);
  });
  it('a paused video stays paused', () => {
    expect(resumeAfterSwitch({ wasPlaying: false, pending: false, result: undefined })).toBe(false);
  });
  it('a start that was still pending (switched before the first frame) survives the switch', () => {
    expect(resumeAfterSwitch({ wasPlaying: false, pending: true, result: undefined })).toBe(true);
  });
  it('a refused switch (server busy, its error is shown) does not start anything', () => {
    expect(resumeAfterSwitch({ wasPlaying: true, pending: true, result: 'busy' })).toBe(false);
  });
});
