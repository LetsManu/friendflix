// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes } from './fixtures.js';

/** GET /api/handoff's answer for "Dunmoor S1:F4 · The Lantern Road", 23:10 in, last played on the LG TV 12 minutes ago (use with dunmoor()) */
export const offer = (o: Record<string, unknown> = {}) => ({
  id: 'hd-1', itemId: episodes[0]!.id, type: 'Episode', title: 'The Lantern Road', seriesName: 'Dunmoor', season: 1, episode: 4, imageId: episodes[0]!.id,
  positionTicks: 13_900_000_000, runtimeTicks: 27_000_000_000, ageSec: 720, device: { kind: 'webos' }, ...o,
});
