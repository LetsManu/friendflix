// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseClientCaps } from '../src/media/clientCaps.js';

const caps = (over: Record<string, unknown> = {}) => ({
  client: 'windows', appVersion: '0.1.0', containers: ['mkv', 'avi', 'm2ts', 'mp4'], video: [{ codec: 'h264' }, { codec: 'vc1' }, { codec: 'av1' }],
  audio: ['aac', 'pcm', 'dts'], subtitles: ['srt', 'pgs', 'dvdsub'], ...over,
});

describe('parseClientCaps (windows)', () => {
  it('accepts a windows block and drops values outside the allowlists', () => {
    expect(parseClientCaps(caps())).toEqual({
      client: 'windows', appVersion: '0.1.0', containers: ['mkv', 'mp4'], video: [{ codec: 'h264' }, { codec: 'av1' }], audio: ['aac', 'dts'], subtitles: ['srt'],
    });
  });
  it('still ignores an unknown client', () => {
    expect(parseClientCaps(caps({ client: 'ios' }))).toBeNull();
  });
});
