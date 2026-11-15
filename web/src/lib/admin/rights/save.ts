// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The sequential save of staged role edits (spec §6.1), shared by Rollen & Rechte's compare view and the role page: one
 * PUT /api/admin/roles/:role after the other with the progress in the save bar; a 502 policy_partial stores the values and keeps
 * the body for *Erneut anwenden*; a hard error stops the run and keeps what it did not send. A written role's values become the
 * loaded ones (`storeJob`), so the staged entries equal to them unstage themselves.
 *
 *   const save = createSave({ matrix: () => matrix, stage: () => stage, stored: (m, s) => { matrix = m; stage = s; } });
 *   $save.saving / $save.progress / $save.error;  save.apply();  save.retry();  save.discard();
 */
import { writable, type Readable } from 'svelte/store';
import { api, ApiError } from '#lib/api';
import { tr } from '#lib/i18n';
import { errorText } from '#lib/ui/action';
import { toast } from '#lib/ui/toast';
import { partialText, stageBodies, stageSet, type RoleMatrix, type Stage } from './model';

type Body = Record<string, unknown>;
/** one role write: its body and, for staged values, what was staged when it was built (null: re-sending a stored body) */
export interface Job { role: string; body: Body; fields: Record<string, unknown> | null }
export interface SaveState {
  saving: boolean;
  /** "Aktualisiere 1 von 2 …" while saving */
  progress: string | null;
  /** what went wrong (a hard error, or the accounts a partial policy failure left) */
  error: string | null;
  /** roles whose values are stored but whose accounts did not all take the policy (502 policy_partial): the body to re-send */
  failures: Array<Job & { failed: number }>;
  /** staged writes a hard error left unsent (that run's bodies; *Erneut anwenden* sends them, never newer edits) */
  pending: Job[];
}

/** the staged roles as writes, in matrix order */
export function stagedJobs(s: Stage, m: RoleMatrix): Job[] {
  const bodies = stageBodies(s);
  return m.roles.filter((r) => bodies[r.key]).map((r) => ({ role: r.key, body: bodies[r.key]!, fields: { ...s[r.key] } }));
}

/**
 * A written role in the matrix: the values it carried become the loaded ones (set in the role itself now; the channel groups as
 * ids and names), and the staged entries equal to them go. Returns the new matrix and stage (the inputs stay as they were).
 */
export function storeJob(m: RoleMatrix, s: Stage, j: Job): { matrix: RoleMatrix; stage: Stage } {
  const at = m.roles.findIndex((x) => x.key === j.role);
  if (at < 0 || !j.fields) return { matrix: m, stage: s };
  const old = m.roles[at]!;
  const r = { ...old, values: { ...old.values }, sources: { ...old.sources } };
  for (const [k, v] of Object.entries(j.fields)) {
    if (k === 'label') { r.label = String(v); r.builtinLabel = false; } else if (k === 'invitable') r.invitable = Boolean(v);
    else if (k === 'livetvGroups') {
      const ids = new Set(Array.isArray(v) ? (v as string[]) : []);
      const groups = (m.livetv?.groups ?? []).filter((g) => ids.has(g.id));
      r.livetvGroupIds = groups.map((g) => g.id);
      r.livetvGroups = groups.map((g) => g.name);
    } else { r.values[k] = v; r.sources[k] = 'role'; }
  }
  const matrix = { ...m, roles: m.roles.map((x, i) => (i === at ? r : x)) };
  let stage = s;
  for (const [k, v] of Object.entries(s[j.role] ?? {})) stage = stageSet(stage, matrix, j.role, k, v);
  return { matrix, stage };
}

export interface SaveDeps {
  matrix: () => RoleMatrix | null;
  stage: () => Stage;
  /** a role was written: the page takes the new matrix and stage */
  stored: (matrix: RoleMatrix, stage: Stage) => void;
}

export interface Save extends Readable<SaveState> {
  /** *Speichern* in the review sheet: the failed roles again, then everything staged */
  apply(): Promise<void>;
  /** *Erneut anwenden*: only what failed (each role's last body) and what a hard error left unsent, never newer edits */
  retry(): Promise<void>;
  /** *Verwerfen*: the failures and the unsent writes go (the page drops its stage) */
  discard(): void;
  /** the roles that still exist (after a read-back): a failed write of a role that is gone can never be applied again */
  prune(keys: ReadonlySet<string>): void;
}

const IDLE: SaveState = { saving: false, progress: null, error: null, failures: [], pending: [] };
const failedAccounts = (failures: SaveState['failures']) => [...new Map(failures.map((f) => [f.role, f.failed])).values()].reduce((a, n) => a + n, 0);

export function createSave(deps: SaveDeps): Save {
  const store = writable<SaveState>({ ...IDLE });
  let st: SaveState = { ...IDLE };
  const set = (patch: Partial<SaveState>) => { st = { ...st, ...patch }; store.set(st); };

  /** one PUT after the other, the progress in the bar; 502 policy_partial stores the values and keeps the body for a retry */
  async function run(jobs: Job[]) {
    if (!deps.matrix() || st.saving || !jobs.length) return;
    set({ saving: true, error: null });
    const stored = (j: Job) => { const m = deps.matrix(); if (m) { const r = storeJob(m, deps.stage(), j); deps.stored(r.matrix, r.stage); } };
    const failed: SaveState['failures'] = [];
    let hard: string | null = null, i = 0;
    for (; i < jobs.length; i++) {
      const j = jobs[i]!;
      set({ progress: tr('adminPeople.roles.applying', { i: i + 1, n: jobs.length }) });
      try {
        await api(`/api/admin/roles/${encodeURIComponent(j.role)}`, { method: 'PUT', body: j.body });
        stored(j);
      } catch (e) {
        if (e instanceof ApiError && e.status === 502 && e.body?.error === 'policy_partial') {
          stored(j); // stored either way
          failed.push({ role: j.role, body: j.body, fields: null, failed: Number(e.body?.failed) || 0 });
        } else { hard = errorText(e); break; }
      }
    }
    // a hard error stops the run: what it did not send stays to be sent again (staged values also stay staged)
    const rest = jobs.slice(i);
    const failures = [...failed, ...rest.filter((j) => !j.fields).map((j) => st.failures.find((f) => f.role === j.role && f.body === j.body)!).filter(Boolean)];
    // a role written twice (failed before, staged again) counts with its latest answer
    const error = hard ?? (failures.length ? partialText(failedAccounts(failures)) : null);
    set({ saving: false, progress: null, failures, pending: rest.filter((j) => j.fields), error });
    // all written: "Änderungen gespeichert." only when nothing is left staged (a retry leaves newer edits staged)
    if (!error) {
      const roles = new Set(jobs.map((j) => j.role)).size;
      toast.success(Object.keys(deps.stage()).length ? tr('adminPeople.roles.retryDone', { n: roles }) : tr('adminPeople.roles.savedAll'));
    }
  }

  return {
    subscribe: store.subscribe,
    apply: () => { const m = deps.matrix(); return run([...st.failures, ...(m ? stagedJobs(deps.stage(), m) : [])]); },
    retry: () => run([...st.failures, ...st.pending]),
    discard: () => set({ failures: [], pending: [], error: null }),
    prune(keys) {
      if (!st.failures.some((j) => !keys.has(j.role)) && !st.pending.some((j) => !keys.has(j.role))) return;
      const failures = st.failures.filter((j) => keys.has(j.role)), pending = st.pending.filter((j) => keys.has(j.role));
      set({ failures, pending, error: st.saving ? st.error : failures.length ? partialText(failedAccounts(failures)) : pending.length ? st.error : null });
    },
  };
}
