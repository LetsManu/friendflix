// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createSave, goneGroups, groupsChanged, keepKnownGroups, stagedJobs, storeJob } from './save';
import { api, ApiError } from '#lib/api';
import { toast } from '#lib/ui/toast';
import { stageSet, type MatrixRole, type RoleMatrix } from './model';

vi.mock('#lib/api', async (orig) => ({ ...(await orig<typeof import('#lib/api')>()), api: vi.fn() }));
vi.mock('#lib/ui/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
beforeEach(() => { vi.mocked(api).mockReset(); vi.mocked(toast.error).mockReset(); vi.mocked(toast.success).mockReset(); });

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

describe('goneGroups (Stage 3 parked finding: the toast names them)', () => {
  it('the names of staged groups the re-read list no longer has, in group order, each once', () => {
    const m = matrix();
    const s = stageSet(stageSet({}, m, 'friend', 'livetvGroups', ['g-hafen', 'g-nord']), m, 'guest', 'livetvGroups', ['g-hafen']);
    expect(goneGroups(s, m, { ...m, livetv: { groups: [m.livetv!.groups[0]!], pending: 1 } })).toEqual(['Hafenkanal']);
    expect(goneGroups(s, m, { ...m, livetv: null })).toEqual(['Nordlicht TV', 'Hafenkanal']);
    expect(goneGroups(s, m, m)).toEqual([]);
    expect(goneGroups({ friend: { maxStreams: 3 } }, m, { ...m, livetv: null })).toEqual([]);
    // an id the old list did not name either is left out (no name to show)
    expect(goneGroups(stageSet({}, m, 'friend', 'livetvGroups', ['g-x']), m, m)).toEqual([]);
  });
});

describe('storeJob edge cases', () => {
  it('an unknown role or a re-sent body (no fields) changes nothing', () => {
    const m = matrix(), s = stageSet({}, m, 'friend', 'maxStreams', 3);
    expect(storeJob(m, s, { role: 'ghost', body: {}, fields: { maxStreams: 3 } })).toEqual({ matrix: m, stage: s });
    expect(storeJob(m, s, { role: 'friend', body: {}, fields: null })).toEqual({ matrix: m, stage: s });
  });
  it('label and invitable become the loaded values; a label drops builtinLabel', () => {
    const m = matrix();
    m.roles[0]!.builtinLabel = true;
    const out = storeJob(m, {}, { role: 'friend', body: {}, fields: { label: 'Kino', invitable: false } });
    expect(out.matrix.roles[0]).toMatchObject({ label: 'Kino', builtinLabel: false, invitable: false });
  });
  it('a non-array livetvGroups value empties the groups', () => {
    const out = storeJob(matrix(), {}, { role: 'friend', body: {}, fields: { livetvGroups: null } });
    expect(out.matrix.roles[0]).toMatchObject({ livetvGroupIds: [], livetvGroups: [] });
  });
});

describe('keepKnownGroups edge cases', () => {
  it('leaves stages without a livetvGroups entry alone', () => {
    const m = matrix(), s = stageSet({}, m, 'friend', 'maxStreams', 3);
    expect(keepKnownGroups(s, m)).toEqual(s);
  });
});

describe('createSave', () => {
  function setup(m: RoleMatrix | null = matrix(), initial = {}, groupsChanged?: () => Promise<string[] | void>) {
    const ctx = { matrix: m, stage: initial as ReturnType<typeof stageSet> };
    const stored = vi.fn((nm: RoleMatrix, ns: typeof ctx.stage) => { ctx.matrix = nm; ctx.stage = ns; });
    const save = createSave({ matrix: () => ctx.matrix, stage: () => ctx.stage, stored, groupsChanged });
    return { ctx, stored, save };
  }
  const stageTwo = () => stageSet(stageSet({}, matrix(), 'friend', 'maxStreams', 3), matrix(), 'guest', 'party', true);

  it('apply writes the staged roles one after the other and toasts success', async () => {
    vi.mocked(api).mockResolvedValue(undefined);
    const { ctx, save } = setup(matrix(), stageTwo());
    await save.apply();
    expect(vi.mocked(api).mock.calls.map((c) => [c[0], (c[1] as { method: string }).method])).toEqual([['/api/admin/roles/friend', 'PUT'], ['/api/admin/roles/guest', 'PUT']]);
    expect(ctx.stage).toEqual({});
    expect(ctx.matrix!.roles[0]!.values.maxStreams).toBe(3);
    expect(get(save)).toMatchObject({ saving: false, progress: null, error: null, failures: [], pending: [] });
    expect(toast.success).toHaveBeenCalledOnce();
  });
  it('does nothing without a matrix or without jobs', async () => {
    await setup(null, stageTwo()).save.apply();
    await setup().save.apply();
    expect(api).not.toHaveBeenCalled();
  });
  it('a 502 policy_partial stores the values and keeps the body for retry', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(502, { error: 'policy_partial', failed: 2 }));
    const { ctx, save } = setup(matrix(), stageSet({}, matrix(), 'friend', 'maxStreams', 3));
    await save.apply();
    const st = get(save);
    expect(ctx.matrix!.roles[0]!.values.maxStreams).toBe(3);
    expect(st.failures).toEqual([{ role: 'friend', body: { maxStreams: 3 }, fields: null, failed: 2 }]);
    expect(st.error).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    // retry re-sends the stored body only
    vi.mocked(api).mockResolvedValue(undefined);
    await save.retry();
    expect(api).toHaveBeenLastCalledWith('/api/admin/roles/friend', { method: 'PUT', body: { maxStreams: 3 } });
    expect(get(save)).toMatchObject({ failures: [], error: null });
    expect(toast.success).toHaveBeenCalledOnce();
  });
  it('a hard error stops the run and keeps the unsent staged writes as pending', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(500, { error: 'boom' }));
    const { save } = setup(matrix(), stageTwo());
    await save.apply();
    const st = get(save);
    expect(api).toHaveBeenCalledOnce();
    expect(st.error).toBeTruthy();
    expect(st.pending.map((j) => j.role)).toEqual(['friend', 'guest']);
    // retry sends them again
    vi.mocked(api).mockResolvedValue(undefined);
    await save.retry();
    expect(get(save).pending).toEqual([]);
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('a retry that leaves newer edits staged toasts the retry text', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(502, { error: 'policy_partial', failed: 1 }));
    const { ctx, save } = setup(matrix(), stageSet({}, matrix(), 'friend', 'maxStreams', 3));
    await save.apply();
    ctx.stage = stageSet({}, ctx.matrix!, 'guest', 'party', true);
    vi.mocked(api).mockResolvedValue(undefined);
    await save.retry();
    expect(toast.success).toHaveBeenCalledOnce();
  });
  it('changed channel groups stop the run, read them again and toast; nothing staged is dropped', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(400, { error: 'invalid', field: 'livetvGroups' }));
    const reread = vi.fn(async () => {});
    const s = stageSet({}, matrix(), 'friend', 'livetvGroups', ['g-hafen']);
    const { ctx, save } = setup(matrix(), s, reread);
    await save.apply();
    expect(reread).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith('Die Kanalgruppen haben sich geändert. Bitte prüfe die Auswahl und speichere noch einmal.');
    expect(ctx.stage).toEqual(s);
    expect(get(save)).toMatchObject({ saving: false, pending: [], failures: [] });
  });
  it('the toast names the groups that are gone ("Nicht mehr verfügbar: Hafenkanal")', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(400, { error: 'invalid', field: 'livetvGroups' }));
    const { save } = setup(matrix(), stageSet({}, matrix(), 'friend', 'livetvGroups', ['g-hafen']), async () => ['Hafenkanal']);
    await save.apply();
    expect(toast.error).toHaveBeenCalledWith('Die Kanalgruppen haben sich geändert. Bitte prüfe die Auswahl und speichere noch einmal. Nicht mehr verfügbar: Hafenkanal.');
  });
  it('a groups 400 without a groupsChanged handler is a hard error', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(400, { error: 'invalid', field: 'livetvGroups' }));
    const { save } = setup(matrix(), stageSet({}, matrix(), 'friend', 'livetvGroups', ['g-hafen']));
    await save.apply();
    expect(get(save).error).toBeTruthy();
    expect(get(save).pending).toHaveLength(1);
  });
  it('discard drops failures, pending writes and the error', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(500, { error: 'boom' }));
    const { save } = setup(matrix(), stageTwo());
    await save.apply();
    save.discard();
    expect(get(save)).toMatchObject({ failures: [], pending: [], error: null });
  });
  it('prune drops failed and pending writes of roles that are gone, and recomputes the error', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(502, { error: 'policy_partial', failed: 1 })).mockRejectedValueOnce(new ApiError(502, { error: 'policy_partial', failed: 4 }));
    const { save } = setup(matrix(), stageTwo());
    await save.apply();
    expect(get(save).failures).toHaveLength(2);
    save.prune(new Set(['friend', 'guest'])); // nothing gone: unchanged
    expect(get(save).failures).toHaveLength(2);
    save.prune(new Set(['friend']));
    expect(get(save).failures.map((f) => f.role)).toEqual(['friend']);
    expect(get(save).error).toBeTruthy();
    save.prune(new Set());
    expect(get(save)).toMatchObject({ failures: [], error: null });
  });
  it('prune keeps the hard error while writes are still pending', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(500, { error: 'boom' }));
    const { save } = setup(matrix(), stageTwo());
    await save.apply();
    const err = get(save).error;
    save.prune(new Set(['friend']));
    expect(get(save).pending.map((j) => j.role)).toEqual(['friend']);
    expect(get(save).error).toBe(err);
  });
});
