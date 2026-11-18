// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { kitVersionName } from './kit-version';

const COMMIT = '1'.repeat(40);

describe('kitVersionName', () => {
  const clock = () => 1234;
  it('kitVersionName uses FF_IMAGE_COMMIT', () => {
    expect(kitVersionName({ FF_IMAGE_COMMIT: COMMIT, SOURCE_DATE_EPOCH: '1700000000' }, clock)).toBe(COMMIT);
  });
  it('ignores GIT_SHA: the run commit is no longer a build input', () => {
    expect(kitVersionName({ GIT_SHA: '2'.repeat(40), SOURCE_DATE_EPOCH: '1700000000' }, clock)).toBe('1700000000');
    expect(kitVersionName({ GIT_SHA: '2'.repeat(40), FF_IMAGE_COMMIT: COMMIT }, clock)).toBe(COMMIT);
  });
  it('falls back to SOURCE_DATE_EPOCH when there is no real image commit', () => {
    expect(kitVersionName({ FF_IMAGE_COMMIT: 'dev', SOURCE_DATE_EPOCH: '1700000000' }, clock)).toBe('1700000000');
    expect(kitVersionName({ FF_IMAGE_COMMIT: ' ', SOURCE_DATE_EPOCH: '1700000000' }, clock)).toBe('1700000000');
  });
  it('uses the clock only without any build input', () => {
    expect(kitVersionName({}, clock)).toBe('1234');
    expect(kitVersionName({ SOURCE_DATE_EPOCH: 'yesterday' }, clock)).toBe('1234');
  });
  it('is stable for the same inputs', () => {
    const env = { FF_IMAGE_COMMIT: COMMIT };
    expect(kitVersionName(env, () => 1)).toBe(kitVersionName(env, () => 2));
  });
});
