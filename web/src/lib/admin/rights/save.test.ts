// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { groupsChanged, keepKnownGroups, stagedJobs, storeJob } from './save';
import { ApiError } from '#lib/api';
import { stageSet, type MatrixRole, type RoleMatrix } from './model';

const role = (key: string, values: Record<string, unknown>, extra: Partial<MatrixRole> = {}): MatrixRole => ({
  key, label: key, builtinLabel: false, base: 'friend', origin: 'admin', invitable: true, position: 0, accounts: 2, profiles: 3, kidsProfiles: 0,
  values, sources: {}, defaults: values, envGone: false, stored: true, missingLibraries: [], livetvGroups: ['Nordlicht TV'], livetvGroupIds: ['g-nord'], ...extra,
});
const matrix = (): RoleMatrix => ({
  fields: [{ key: 'maxStreams', group: 'playback', kind: 'int', area: 'general' }, { key: 'party', group: 'together', kind: 'bool', area: 'together' }],
  features: { requests: true, cast: true, livetv: true }, libraries: [],
  roles: [role('friend', { maxStreams: 2, party: true }), role('guest', { maxStreams: 1, party: false })],
  livetv: { groups: [{ id: 'g-nord', name: 'Nordlicht TV', kidFriendly: false, channels: 12 }, { id: 'g-hafen', name: 'Hafenkanal', kidFriendly: true, channels: 4 }], pending: 0 },
});

describe('the shared save (role page and compare view)', () => {
  it('stagedJobs: one write per staged role, in matrix order, switches under perms', () => {
    const m = matrix();
    const s = stageSet(stageSet({}, m, 'guest', 'party', true), m, 'friend', 'maxStreams', 3);
    expect(stagedJobs(s, m)).toEqual([
      { role: 'friend', body: { maxStreams: 3 }, fields: { maxStreams: 3 } },
      { role: 'guest', body: { perms: { party: true } }, fields: { party: true } },
    ]);
  });
  it('storeJob: the written values become the loaded ones and unstage; the groups as ids and names in group order', () => {
    const m = matrix();
    const s = stageSet(stageSet({}, m, 'friend', 'livetvGroups', ['g-hafen', 'g-nord']), m, 'friend', 'maxStreams', 3);
    const [job] = stagedJobs(s, m);
    const out = storeJob(m, s, job!);
    expect(out.stage).toEqual({});
    const r = out.matrix.roles.find((x) => x.key === 'friend')!;
    expect(r.values.maxStreams).toBe(3);
    expect(r.sources.maxStreams).toBe('role');
    expect(r.livetvGroupIds).toEqual(['g-nord', 'g-hafen']);
    expect(r.livetvGroups).toEqual(['Nordlicht TV', 'Hafenkanal']);
    // the inputs stay as they were
    expect(m.roles[0]!.values.maxStreams).toBe(2);
    expect(m.roles[0]!.livetvGroupIds).toEqual(['g-nord']);
  });
  it('storeJob keeps a newer staged value that differs from the written one', () => {
    const m = matrix();
    const s1 = stageSet({}, m, 'friend', 'maxStreams', 3);
    const [job] = stagedJobs(s1, m);
    const s2 = stageSet(s1, m, 'friend', 'maxStreams', 5); // edited again while the write ran
    expect(storeJob(m, s2, job!).stage).toEqual({ friend: { maxStreams: 5 } });
  });
  it('groupsChanged: only a 400 invalid on livetvGroups', () => {
    expect(groupsChanged(new ApiError(400, { error: 'invalid', field: 'livetvGroups' }))).toBe(true);
    expect(groupsChanged(new ApiError(400, { error: 'invalid', field: 'libraries' }))).toBe(false);
    expect(groupsChanged(new ApiError(500, { error: 'invalid', field: 'livetvGroups' }))).toBe(false);
  });
  it('keepKnownGroups: staged group ids the re-read list no longer has go; what is left unstages when it equals the loaded set', () => {
    const m = matrix();
    const s = stageSet(stageSet({}, m, 'friend', 'livetvGroups', ['g-hafen']), m, 'guest', 'livetvGroups', ['g-nord', 'g-hafen']);
    const reread: RoleMatrix = { ...m, livetv: { groups: [m.livetv!.groups[0]!], pending: 1 } };
    // friend: [] (still a change from Nordlicht TV); guest: [g-nord] (guest's loaded groups are [g-nord]: unstaged)
    expect(keepKnownGroups(s, reread)).toEqual({ friend: { livetvGroups: [] } });
  });
});
