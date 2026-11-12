// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminConv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Conversions',
  intro: 'How many videos the server may convert at the same time: films & series, Live TV and recordings together.',
  used: '{u} of {l} in use',
  measured: 'Measured {s}× real time ({engine})',
  liveSpeed: 'Live TV {s}×',
  recommended: 'recommended {n}',
  checked: 'checked {when}',
  today: 'today {time}',
  remeasure: 'Measure again',
  auto: 'Automatic ({n})',
  custom: 'Custom',
  noRealtime: 'The server cannot convert in real time.',
  busyMeasure: 'Measuring works only while nobody is watching.',
  kind: {
    film: 'Film/series',
    live: 'Live TV',
    record: 'Recording',
    else: 'Other',
  },
  free: 'free',
  over: 'over the limit',
  stale: 'Measurement out of date – please measure again',
  never: 'Not measured yet · {n} until then',
  measuring: 'Measuring… (about 20 s)',
  cpu: 'processor',
  bar: 'Use of the conversion slots',
  running: {
    title: 'Running now',
    none: 'Nothing is being converted right now.',
  },
  since: 'for {d}',
  slots: {
    label: 'Simultaneous conversions',
    value: 'Custom value in slots',
    less: 'Fewer',
    more: 'More',
  },
  priority: {
    label: 'Priority',
    films: 'Films & series first',
    live: 'Live TV first',
    equal: 'Equal',
    hint: {
      films: 'Live TV leaves one slot free for films & series (with 2 or more slots).',
      live: 'Films & series leave one slot free for Live TV (with 2 or more slots).',
      equal: 'No slot is kept free – whoever comes first gets it.',
    },
  },
  last: {
    ok: 'Last measurement succeeded',
    failed: 'Last measurement failed – please try again',
    no_title: 'Last measurement not possible: no suitable title (SDR, 720p to 1080p) in the library',
    busy: 'Last measurement stopped: someone was watching',
    no_user: 'Last measurement not possible: no admin account to convert as',
    unsupported: 'Measuring works only with Jellyfin',
  },
  err: {
    running: 'A measurement is already running.',
    busyUnknown: 'The media server is not answering right now, so it is not clear whether anyone is watching.',
    noUser: 'There is no admin account the media server can convert as for the measurement.',
    unsupported: 'Measuring works only with Jellyfin',
    tooMany: 'Too many measurements in a short time. Please try again in a few minutes.',
    locked: 'Set in the environment – cannot be changed here.',
    loadFailed: 'The conversions could not be loaded.',
  },
  details: 'Go to Playback check',
};
export default dict;
