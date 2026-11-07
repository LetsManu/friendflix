// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SEEK_COMMIT_MS, seekCancel, seekCommit, seekStep, type SeekPreview } from './tvSeek';

const idle: SeekPreview = { active: false, target: 0 };

describe('seekStep (TV seek preview)', () => {
  it('starts at the playing position and moves 10 s', () => {
    expect(seekStep(idle, 1, 100, 3600, 0)).toEqual({ active: true, target: 110 });
  });
  it('continues from the marker, held keys step faster (holdSeekStep)', () => {
    const p = seekStep(idle, 1, 100, 3600, 0);
    expect(seekStep(p, 1, 100, 3600, 1500)).toEqual({ active: true, target: 140 });
    expect(seekStep({ active: true, target: 140 }, 1, 100, 3600, 3000)).toEqual({ active: true, target: 200 });
  });
  it('ignores the playing position once the preview is active (the video keeps playing)', () => {
    expect(seekStep({ active: true, target: 50 }, -1, 400, 3600, 0)).toEqual({ active: true, target: 40 });
  });
  it('clamps to [0, duration]', () => {
    expect(seekStep(idle, -1, 5, 3600, 0)).toEqual({ active: true, target: 0 });
    expect(seekStep(idle, 1, 3595, 3600, 0)).toEqual({ active: true, target: 3600 });
    expect(seekStep({ active: true, target: 3600 }, 1, 10, 3600, 5000)).toEqual({ active: true, target: 3600 });
  });
  it('an unknown duration does not clamp the upper end below the start', () => {
    expect(seekStep(idle, 1, 100, 0, 0)).toEqual({ active: true, target: 110 });
  });
});

describe('seekCommit / seekCancel', () => {
  it('commits the target and ends the preview', () => {
    expect(seekCommit({ active: true, target: 140 })).toEqual({ seekTo: 140, next: { active: false, target: 0 } });
  });
  it('an inactive preview seeks nowhere', () => {
    expect(seekCommit(idle)).toEqual({ seekTo: null, next: idle });
    expect(seekCommit({ active: false, target: 77 }).seekTo).toBeNull();
  });
  it('cancel is the idle state', () => { expect(seekCancel()).toEqual({ active: false, target: 0 }); });
  it('commits after one second without a key', () => { expect(SEEK_COMMIT_MS).toBe(1000); });
});
