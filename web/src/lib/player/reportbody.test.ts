// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { playerReportBody } from './reportbody';

const local = { playSessionId: 'ps-local1', mediaSourceId: 'ms-local' };
const token = { playSessionId: 'ps-air1', mediaSourceId: 'ms-air' };
const base = { itemId: 'dun4', local, position: 61.5, paused: false, audioIndex: 1, direct: false };

describe('playerReportBody', () => {
  it('local playback: the local play session, no via', () => {
    expect(playerReportBody({ ...base, air: null, airOn: false })).toEqual({
      itemId: 'dun4', playSessionId: 'ps-local1', mediaSourceId: 'ms-local', positionTicks: 615_000_000, isPaused: false, audioIndex: 1, playMethod: 'Transcode' });
    expect(playerReportBody({ ...base, direct: true, paused: true, air: null, airOn: false })).toMatchObject({ playMethod: 'DirectPlay', isPaused: true });
    expect('via' in playerReportBody({ ...base, air: null, airOn: false })).toBe(false);
  });

  it('AirPlay on the TV: the token play session, Transcode, via airplay', () => {
    expect(playerReportBody({ ...base, direct: true, air: token, airOn: true })).toEqual({
      itemId: 'dun4', playSessionId: 'ps-air1', mediaSourceId: 'ms-air', positionTicks: 615_000_000, isPaused: false, audioIndex: 1, playMethod: 'Transcode', via: 'airplay' });
  });

  it('the AirPlay token armed, but the phone itself plays it (picker open, route not taken): no via', () => {
    const b = playerReportBody({ ...base, air: token, airOn: false });
    expect(b).toMatchObject({ playSessionId: 'ps-air1', playMethod: 'Transcode' });
    expect('via' in b).toBe(false);
  });
});
