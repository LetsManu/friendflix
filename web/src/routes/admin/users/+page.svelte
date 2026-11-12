<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin: users – tabs Users | Waiting for approval (n) | Invites (`?tab=`). Users: server-side search/sort/paging,
   * filters (role, status, last active), role select (optimistic, rollback), lock/unlock (confirm + undo), sign out
   * everywhere (confirm); row checkboxes with a bulk bar (role, lock, unlock, access-until, sign out; confirm with the names).
   * "Deletion pending" lists scheduled deletions (with their date; "Restore account" instead of unlock) and cleanup rows:
   * deletions under way, shown with the step in work and its error; they are not selectable and have no actions, and link to
   * the detail page only while the users row exists (gone: steps 5-6).
   * Rights: a summary strip above the tabs; one scrolling chip row (with exceptions, with kids profile, without 2FA, the active
   * dropdown filters with ×, clear all) and a right filter (the filters live in the URL: userFilters.ts); a column of exceptions
   * (→ the person's rights tab), kids profiles in the profile count, the note as a tooltip; bulk: set one right (allow / deny /
   * as the role) and re-apply the policies (a partial failure shows done and failed).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '#lib/api';
  import { avatarBg, initial } from '#lib/avatars';
  import { fmtDate, fmtDateTime, fmtNumber, fmtRelative, locale, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { pageStore } from '#lib/page';
  import { PERM_KEYS, type PermKey } from '#lib/perms';
  import ApprovalsPanel from '#lib/admin/ApprovalsPanel.svelte';
  import InvitesPanel from '#lib/admin/InvitesPanel.svelte';
  import { accessPreset, accountGuardText, bulkSummary, deletionErrorText, futureDayEnd, restoredText, today } from '#lib/admin/people';
  import { activeChips, emptyFilters, fromQuery, toQuery, type UserFilters } from '#lib/admin/userFilters';
  import { deletionLabel } from '#lib/admin/user/detail';
  import { refreshSummary, summary } from '#lib/admin/summary';
  import { roleName, type RoleInfo } from '#lib/roles';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import { toast } from '#lib/ui/toast';
  import StatTile from '#lib/ui/StatTile.svelte';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column, Query, SortState } from '#lib/ui/table';
  import type { MoreAction } from '#lib/MoreActions.svelte';

  interface U {
    id: string; name: string; email: string | null; role: string | null; disabled: boolean; jellyfin_username: string | null; created_at: string
    last_seen: string | null; access_until: string | null; profiles: number; devices: number; pending: boolean
    deletion_at?: string | null; locked_reason?: string | null
    /** stored exceptions (limits and switches) of the person, kids profiles among the profiles, the admin's note */
    overrides?: number; kidsProfiles?: number; note?: string | null
    /** status=deleting only: a deletion under way (step = the step being worked on, 1-6; error = its last error code) */
    cleanup?: { step: number; error: string | null; gone: boolean } | null
  }
  const TABS = ['users', 'approvals', 'invites'] as const;
  type Tab = typeof TABS[number];
  const PAGE = 25;

  const page$ = pageStore();
  // `pending` is the tab name older approval notices link to
  $: tab = ((v) => (v === 'pending' ? 'approvals' : TABS.includes(v as Tab) ? (v as Tab) : 'users'))($page$.url.searchParams.get('tab'));
  /** the filters ride in the URL of the users tab (the search text is the table's own) */
  const FILTER_PARAMS = ['role', 'status', 'lastActive', 'overrides', 'kids', 'mfa', 'perm'];
  const usersUrl = (): string => { const qs = toQuery({ ...f, q: '' }).toString(); return $page$.url.pathname + (qs ? `?${qs}` : ''); };
  const select = (to: Tab) => goto(to === 'users' ? usersUrl() : `?tab=${to}`, { replaceState: true, reset: false });
  function tabKey(e: KeyboardEvent) {
    const i = TABS.indexOf(tab), last = TABS.length - 1;
    const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + last) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (n < 0) return;
    e.preventDefault(); void select(TABS[n]!);
    queueMicrotask(() => document.getElementById(`ut-${TABS[n]!}`)?.focus());
  }

  let rows: U[] | null = null, total = 0, error: string | null = null;
  let roles: Record<string, RoleInfo> = {}, invitable: string[] = ['friend', 'family', 'guest'], meId = '';
  let approvals: number | null = null;
  let q = '', sort: SortState | null = null, page = 0;
  /** the filters except the search text */
  let f: UserFilters = emptyFilters();
  let cur: Query = { q: '', sort: null, offset: 0, limit: PAGE };
  let seq = 0;
  /** selected accounts (id → name and role), kept across pages until an action ran or the selection is cleared */
  let selected = new Map<string, { name: string; role: string | null }>();
  let bulkRole = '', bulkAccess = '', bulkDay = '';

  async function load() {
    const my = ++seq;
    const p = toQuery({ ...f, q: cur.q });
    p.set('limit', String(cur.limit)); p.set('offset', String(cur.offset));
    if (cur.sort) { p.set('sort', cur.sort.key); p.set('dir', cur.sort.dir); }
    try {
      const r = await api<{ users: U[]; total: number }>(`/api/admin/users?${p}`);
      if (my !== seq) return;
      rows = r.users; total = r.total; error = null;
    } catch {
      if (my === seq) error = tr('adminPeople.loadFailed');
    }
  }
  function retry() { error = null; rows = null; void load(); }
  function onQuery(e: CustomEvent<Query>) { cur = e.detail; void load(); }
  /** changes filters: back to the first page, the URL follows, the list reloads */
  function setF(patch: Partial<UserFilters>) {
    f = { ...f, ...patch };
    page = 0; cur = { ...cur, offset: 0 };
    if (tab === 'users') void goto(usersUrl(), { replaceState: true, reset: false });
    void load();
  }
  const clearOne = (id: keyof UserFilters) => setF(id === 'overrides' || id === 'kids' || id === 'noMfa' ? { [id]: false } : { [id]: null });
  $: chips = activeChips(f, (k) => rname(k));
  $: anyFilter = chips.length > 0;
  $: permValue = f.perm ? `${f.perm.key}:${f.perm.on ? 'on' : 'off'}` : '';
  function setPerm(v: string) {
    const [key, state] = v.split(':');
    setF({ perm: v ? { key: key as PermKey, on: state === 'on' } : null });
  }
  /** the 2FA filter needs the sign-in provider's API (the backend ignores it otherwise) */
  $: mfaChip = $summary?.mfaFilter === true || f.noMfa;
  const rightName = (k: PermKey): string => tr(`adminPeople.roles.f.${k}`);

  onMount(() => {
    f = { ...fromQuery(new URLSearchParams($page$.url.search)), q: '' };
    void load();
    void refreshSummary();
    api<{ roles: Record<string, RoleInfo>; invitable?: string[] }>('/api/admin/roles').then((r) => {
      roles = r.roles;
      if (r.invitable?.length) invitable = r.invitable;
    }, () => undefined);
    api<{ id: string }>('/api/me').then((m) => (meId = m.id), () => undefined);
    api<{ requests: unknown[] }>('/api/admin/approvals').then((r) => (approvals ??= r.requests.length), () => undefined);
  });

  // back on the users tab: approvals may have added accounts meanwhile
  let shownTab: Tab | null = null;
  $: if (tab !== shownTab) { if (tab === 'users' && shownTab !== null) void load(); shownTab = tab; }

  $: rname = (k: string): string => roleName(k, roles[k]);
  $: roleOptions = Object.keys(roles).map((k) => ({ value: k, label: rname(k) }));
  $: permOptions = [{ value: '', label: $t('adminPeople.users.anyRight') }, ...PERM_KEYS.flatMap((k) => [
    { value: `${k}:on`, label: $t('adminPeople.users.filterRightOn', { right: rightName(k) }) },
    { value: `${k}:off`, label: $t('adminPeople.users.filterRightOff', { right: rightName(k) }) },
  ])];
  $: roleFilterOptions = [{ value: '', label: $t('adminPeople.users.allRoles') }, ...roleOptions];
  $: statusOptions = [
    { value: '', label: $t('adminPeople.users.allStatus') }, { value: 'active', label: $t('adminPeople.users.active') },
    { value: 'locked', label: $t('adminPeople.users.locked') }, { value: 'expiring', label: $t('adminPeople.users.expiring') },
    { value: 'pending', label: $t('adminPeople.users.pending') }, { value: 'deleting', label: $t('adminPeople.users.deleting') },
  ];
  $: lastActiveOptions = [
    { value: '', label: $t('adminPeople.users.anyTime') }, { value: '7', label: $t('adminPeople.users.lastActive.d7') },
    { value: '30', label: $t('adminPeople.users.lastActive.d30') }, { value: '90', label: $t('adminPeople.users.lastActive.d90') },
    { value: '90+', label: $t('adminPeople.users.lastActive.inactive90') },
  ];
  $: columns = [
    { key: 'select', sortable: false, label: $t('adminPeople.users.col.select'), hideLabel: true, width: '2.75rem' },
    { key: 'name', sortable: true, label: $t('adminPeople.users.col.name'), primary: true },
    { key: 'email', sortable: true, label: $t('adminPeople.users.col.email') },
    { key: 'role', sortable: true, label: $t('adminPeople.users.col.role') },
    { key: 'overrides', sortable: false, label: $t('adminPeople.users.overrides'), align: 'center' },
    { key: 'profiles', sortable: true, label: $t('adminPeople.users.col.profiles'), align: 'end' },
    { key: 'devices', sortable: true, label: $t('adminPeople.users.col.devices'), align: 'end' },
    { key: 'lastSeen', sortable: true, label: $t('adminPeople.users.col.lastSeen') },
    { key: 'mfa', sortable: false, label: $t('adminPeople.users.col.mfa'), align: 'center' },
    { key: 'accessUntil', sortable: true, label: $t('adminPeople.users.col.accessUntil') },
  ] satisfies Column<U>[];
  const optionsFor = (opts: Array<{ value: string; label: string }>, role: string) => (opts.some((o) => o.value === role) ? opts : [...opts, { value: role, label: rname(role) }]);
  // nothing is selectable until /api/me says which row is the admin's own
  $: selectable = (u: U): boolean => !u.pending && !u.cleanup && meId !== '' && u.id !== meId;
  const cleanupText = (c: NonNullable<U['cleanup']>): string => (c.error
    ? tr('adminPeople.users.cleanupError', { n: c.step, error: c.error })
    : tr('adminPeople.users.cleanupStep', { n: c.step }));

  function changeRole(u: U, role: string) {
    const prev = u.role;
    if (role === prev || prev === null) return;
    const patch = (r: string) => () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: r } });
    void runAction({
      key: `user:${u.id}`,
      apply: () => { u.role = role; rows = rows; return () => { u.role = prev; rows = rows; }; },
      run: patch(role),
      success: tr('adminPeople.users.roleChanged', { name: u.name, role: rname(role) }),
      undo: { run: patch(prev) },
    });
  }

  function setLocked(u: U, disabled: boolean) {
    const patch = (d: boolean) => () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: d } });
    void runAction({
      key: `user:${u.id}`,
      apply: () => { const prev = u.disabled; u.disabled = disabled; rows = rows; return () => { u.disabled = prev; rows = rows; }; },
      run: patch(disabled),
      error: (e) => accountGuardText(e) ?? errorText(e),
      success: tr(disabled ? 'adminPeople.users.lockedToast' : 'adminPeople.users.unlockedToast', { name: u.name }),
      undo: { run: patch(!disabled) },
    }).then(() => refreshSummary());
  }
  async function lock(u: U) {
    const ok = await confirm({
      title: tr('adminPeople.users.confirmLockTitle', { name: u.name }), body: tr('adminPeople.users.confirmLockBody', { name: u.name }),
      danger: true, confirmLabel: tr('adminPeople.users.lock'),
      ...(u.role === 'admin' ? { typed: u.name } : {}), // locking an admin: type the name
    });
    if (ok) setLocked(u, true);
  }
  async function signOut(u: U) {
    const ok = await confirm({
      title: tr('adminPeople.users.confirmSignOutTitle', { name: u.name }), body: tr('adminPeople.users.confirmSignOutBody', { name: u.name }),
      danger: true, confirmLabel: tr('adminPeople.users.signOut'),
    });
    if (!ok) return;
    void runAction({
      key: `user:${u.id}`,
      run: () => api<{ revoked: number }>(`/api/admin/users/${u.id}/revoke-sessions`, { method: 'POST' }),
      success: (r) => tr('adminPeople.users.signedOutToast', { name: u.name, n: r?.revoked ?? 0 }),
    });
  }

  // a scheduled deletion: restore (no undo: locking again would be a manual lock and lose the deletion)
  async function restoreDeletion(u: U) {
    const r = await runAction({
      key: `user:${u.id}`, run: () => api(`/api/admin/users/${u.id}/deletion/restore`, { method: 'POST' }), error: deletionErrorText,
      success: restoredText(u.name, u.access_until),
    });
    if (r.ok) { void load(); void refreshSummary(); }
  }

  $: actions = (u: U): MoreAction[] => u.cleanup ? [] : u.pending
    ? [{ id: 'approve', label: $t('adminPeople.users.toApprovals'), icon: 'check', run: () => void select('approvals') }]
    : u.id === meId
      ? [{ id: 'self', label: $t('adminPeople.users.selfNote'), icon: 'lock', disabled: true }]
      : [
        u.disabled && u.locked_reason === 'deletion' ? { id: 'restore', label: $t('adminPeople.detail.actions.restore'), icon: 'unlock', run: () => restoreDeletion(u) }
          : u.disabled ? { id: 'unlock', label: $t('adminPeople.users.unlock'), icon: 'unlock', run: () => setLocked(u, false) } : { id: 'lock', label: $t('adminPeople.users.lock'), icon: 'lock', danger: true, run: () => lock(u) },
        { id: 'signout', label: $t('adminPeople.users.signOut'), icon: 'log-out', danger: true, run: () => signOut(u) },
      ];

  // ---- selection + bulk actions ----
  function toggle(u: U, on: boolean) {
    const next = new Map(selected);
    if (on) next.set(u.id, { name: u.name, role: u.role }); else next.delete(u.id);
    selected = next;
  }
  $: pageSelectable = (rows ?? []).filter(selectable);
  $: allOnPage = pageSelectable.length > 0 && pageSelectable.every((u) => selected.has(u.id));
  function togglePage(on: boolean) {
    const next = new Map(selected);
    for (const u of pageSelectable) { if (on) next.set(u.id, { name: u.name, role: u.role }); else next.delete(u.id); }
    selected = next;
  }
  $: bulkRoleOptions = [{ value: '', label: $t('adminPeople.bulk.roleChoose') }, ...roleOptions];
  $: bulkAccessOptions = [
    { value: '', label: $t('adminPeople.access.choose') }, { value: 'p30', label: $t('adminPeople.access.p30') }, { value: 'p90', label: $t('adminPeople.access.p90') },
    { value: 'unlimited', label: $t('adminPeople.access.unlimited') }, { value: 'date', label: $t('adminPeople.access.date') },
  ];

  type Bulk = { action: 'lock' | 'unlock' | 'revoke' | 'repair' } | { action: 'role'; role: string } | { action: 'access'; accessUntil: string | null }
    | { action: 'perm'; perm: PermKey; value: boolean | null };
  function bulkTitle(b: Bulk, n: number): string {
    switch (b.action) {
      case 'role': return tr('adminPeople.bulk.confirmRole', { n, role: rname(b.role) });
      case 'lock': return tr('adminPeople.bulk.confirmLock', { n });
      case 'unlock': return tr('adminPeople.bulk.confirmUnlock', { n });
      case 'revoke': return tr('adminPeople.bulk.confirmSignOut', { n });
      case 'repair': return tr('adminPeople.bulk.confirmRepair', { n });
      case 'perm': return tr('adminPeople.bulk.confirmPerm', { n, right: rightName(b.perm), value: tr(b.value === null ? 'adminPeople.bulk.permValueRole' : b.value ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied') });
      case 'access': return b.accessUntil ? tr('adminPeople.bulk.confirmAccess', { n, date: fmtDate(b.accessUntil) }) : tr('adminPeople.bulk.confirmAccessUnlimited', { n });
    }
  }
  // validation and guards are all or nothing; anything else may have stopped halfway through the accounts
  const bulkError = (e: unknown): string => {
    const code = e instanceof ApiError ? (e.body as { error?: string } | null)?.error : undefined;
    if (code === 'admin_perms_locked') return tr('adminPeople.bulk.adminLocked');
    if (code === 'deletion_in_progress') return deletionErrorText(e);
    return accountGuardText(e) ?? `${errorText(e)} ${tr('adminPeople.bulk.partial')}`;
  };
  /** true when the call ran through (not cancelled, not failed) */
  async function bulk(b: Bulk): Promise<boolean> {
    const ids = [...selected.keys()], picked = [...selected.values()];
    if (!ids.length) return false;
    const names10 = tr('adminPeople.bulk.names', { names: bulkSummary(picked.map((p) => p.name)) });
    const note = b.action === 'lock' ? ` ${tr('adminPeople.bulk.lockNote')}` : b.action === 'revoke' ? ` ${tr('adminPeople.bulk.signOutNote')}` : b.action === 'repair' ? ` ${tr('adminPeople.bulk.repairNote')}` : '';
    // locking or demoting admins needs the same typed confirmation as the single lock: one admin = their name, several = their number
    const admins = picked.filter((p) => p.role === 'admin').map((p) => p.name);
    const guarded = admins.length > 0 && (b.action === 'lock' || (b.action === 'role' && b.role !== 'admin'));
    const adminNote = guarded ? ` ${tr('adminPeople.bulk.adminsNote', { names: bulkSummary(admins) })}` : '';
    const danger = b.action === 'lock' || b.action === 'revoke' || guarded;
    const label = b.action === 'lock' ? tr('adminPeople.users.lock') : b.action === 'unlock' ? tr('adminPeople.users.unlock') : b.action === 'revoke' ? tr('adminPeople.users.signOut') : tr('adminPeople.bulk.apply');
    const ok = await confirm({
      title: bulkTitle(b, ids.length), body: names10 + note + adminNote, danger, confirmLabel: label,
      ...(guarded ? { typed: admins.length === 1 ? admins[0]! : String(admins.length) } : {}),
    });
    if (!ok) return false;
    const r = await runAction({
      key: 'users:bulk',
      run: () => api<{ done: number; failed?: number }>('/api/admin/users/bulk', { method: 'POST', body: { ids, ...b } }),
      // a partly failed repair is no success: its toast (done and failed) is the error below
      success: (res) => (res?.failed ? '' : tr(b.action === 'repair' ? 'adminPeople.bulk.repairDone' : 'adminPeople.bulk.done', { n: res?.done ?? 0 })),
      error: bulkError,
    });
    const failed = r.value?.failed ?? 0;
    if (r.ok && failed) toast.error(tr('adminPeople.bulk.repairPartial', { done: r.value?.done ?? 0, n: failed }));
    // reload either way: a failure in the middle can leave some accounts changed (the selection stays for a retry)
    void load();
    if (b.action === 'lock' || b.action === 'unlock') void refreshSummary();
    // a partial failure keeps the selection: the failed accounts can be tried again
    if (r.ok && !failed) selected = new Map();
    return r.ok;
  }
  let bulkPerm = '';
  $: bulkPermOptions = [{ value: '', label: $t('adminPeople.bulk.perm') }, ...PERM_KEYS.map((k) => ({ value: k, label: rightName(k) }))];
  /** the right select only picks; one of the three buttons runs */
  async function applyPerm(value: boolean | null) {
    const perm = bulkPerm as PermKey;
    if (!perm) return;
    // the choice stays while the confirm is open or after a cancel / failure, so the next button needs no second pick
    if (await bulk({ action: 'perm', perm, value })) bulkPerm = '';
  }
  /** the bulk selects only pick; Apply runs (arrow keys on a closed select fire change in some browsers) */
  function applyRole() {
    const role = bulkRole;
    if (!role) return;
    bulkRole = '';
    void bulk({ action: 'role', role });
  }
  // a past end date would lock everyone selected at the next expiry tick
  $: bulkAccessReady = bulkAccess !== '' && (bulkAccess !== 'date' || futureDayEnd(bulkDay) !== '');
  function applyAccess() {
    if (!bulkAccessReady) return;
    const accessUntil = bulkAccess === 'date' ? futureDayEnd(bulkDay) : accessPreset(bulkAccess === 'p30' ? '+30' : bulkAccess === 'p90' ? '+90' : 'unlimited');
    bulkAccess = ''; bulkDay = '';
    void bulk({ action: 'access', accessUntil });
  }
  $: busyBulk = $busyKeys.has('users:bulk');
  $: tabLabel = (id: Tab): string => (id === 'approvals' ? (approvals === null ? $t('adminPeople.tabs.approvals') : $t('adminPeople.tabs.approvalsN', { n: approvals })) : $t(`adminPeople.tabs.${id}`));
</script>

<section class="stats" aria-label={$t('adminPeople.summary.label')}>
  <StatTile icon="users" label={$t('adminPeople.summary.people')} value={$summary ? fmtNumber($summary.users.total) : null} />
  <StatTile icon="clock" label={$t('adminPeople.summary.waiting')} value={$summary ? fmtNumber($summary.pending.approvals) : null} href="/admin/users?tab=approvals" tone={$summary && $summary.pending.approvals > 0 ? 'warn' : 'default'} />
  <StatTile icon="mail" label={$t('adminPeople.summary.openInvites')} value={$summary ? fmtNumber($summary.pending.invites) : null} href="/admin/users?tab=invites" />
  <StatTile icon="calendar" label={$t('adminPeople.summary.expiring')} value={$summary ? fmtNumber($summary.users.expiring) : null} />
</section>

<div class="tabs" role="tablist" aria-label={$t('adminPeople.tabs.label')}>
  {#each TABS as id (id)}
    <button type="button" role="tab" id="ut-{id}" class="tab" class:on={tab === id} aria-selected={tab === id} aria-controls="ut-panel" tabindex={tab === id ? 0 : -1} on:click={() => select(id)} on:keydown={tabKey}>{tabLabel(id)}</button>
  {/each}
</div>

<div id="ut-panel" role="tabpanel" aria-labelledby="ut-{tab}">
  {#if tab === 'approvals'}
    <ApprovalsPanel {roles} {invitable} on:count={(e) => (approvals = e.detail)} />
  {:else if tab === 'invites'}
    <InvitesPanel {roles} {invitable} />
  {:else}
    {#if selected.size}
      <section class="bulk" aria-label={$t('adminPeople.bulk.label')} aria-busy={busyBulk ? 'true' : undefined}>
        <p class="cnt" aria-live="polite">{$t('adminPeople.bulk.selected', { n: selected.size })}</p>
        <form class="pickapply" aria-label={$t('adminPeople.bulk.role')} on:submit|preventDefault={applyRole}>
          <Select label={$t('adminPeople.bulk.role')} options={bulkRoleOptions} bind:value={bulkRole} hideLabel disabled={busyBulk} />
          <Button type="submit" size="sm" variant="secondary" disabled={busyBulk || !bulkRole}>{$t('adminPeople.bulk.apply')}</Button>
        </form>
        <Button variant="secondary" size="sm" icon="lock" disabled={busyBulk} on:click={() => bulk({ action: 'lock' })}>{$t('adminPeople.users.lock')}</Button>
        <Button variant="secondary" size="sm" icon="unlock" disabled={busyBulk} on:click={() => bulk({ action: 'unlock' })}>{$t('adminPeople.users.unlock')}</Button>
        <form class="pickapply" aria-label={$t('adminPeople.access.label')} on:submit|preventDefault={applyAccess}>
          <Select label={$t('adminPeople.access.label')} options={bulkAccessOptions} bind:value={bulkAccess} hideLabel disabled={busyBulk} />
          {#if bulkAccess === 'date'}<Field type="date" label={$t('adminPeople.access.day')} bind:value={bulkDay} hideLabel min={today()} required />{/if}
          <Button type="submit" size="sm" variant="secondary" disabled={busyBulk || !bulkAccessReady}>{$t('adminPeople.bulk.apply')}</Button>
        </form>
        <Button variant="secondary" size="sm" icon="log-out" disabled={busyBulk} on:click={() => bulk({ action: 'revoke' })}>{$t('adminPeople.users.signOut')}</Button>
        <div class="pickapply" role="group" aria-label={$t('adminPeople.bulk.perm')}>
          <Select label={$t('adminPeople.bulk.perm')} options={bulkPermOptions} bind:value={bulkPerm} hideLabel disabled={busyBulk} />
          <Button variant="secondary" size="sm" disabled={busyBulk || !bulkPerm} on:click={() => applyPerm(true)}>{$t('adminPeople.bulk.permAllow')}</Button>
          <Button variant="secondary" size="sm" disabled={busyBulk || !bulkPerm} on:click={() => applyPerm(false)}>{$t('adminPeople.bulk.permDeny')}</Button>
          <Button variant="secondary" size="sm" disabled={busyBulk || !bulkPerm} on:click={() => applyPerm(null)}>{$t('adminPeople.bulk.permRole')}</Button>
        </div>
        <Button variant="secondary" size="sm" icon="refresh" disabled={busyBulk} on:click={() => bulk({ action: 'repair' })}>{$t('adminPeople.bulk.repair')}</Button>
        <Button variant="ghost" size="sm" icon="x" on:click={() => (selected = new Map())}>{$t('adminPeople.bulk.clear')}</Button>
      </section>
    {/if}

    <div class="chips" role="group" aria-label={$t('adminPeople.users.filters')}>
      <button type="button" class="chip frost-pill" class:on={f.overrides} aria-pressed={f.overrides} on:click={() => setF({ overrides: !f.overrides })}>{$t('adminPeople.users.filterOverrides')}{#if f.overrides}<Icon name="x" size={14} />{/if}</button>
      <button type="button" class="chip frost-pill" class:on={f.kids} aria-pressed={f.kids} on:click={() => setF({ kids: !f.kids })}>{$t('adminPeople.users.filterKids')}{#if f.kids}<Icon name="x" size={14} />{/if}</button>
      {#if mfaChip}<button type="button" class="chip frost-pill" class:on={f.noMfa} aria-pressed={f.noMfa} on:click={() => setF({ noMfa: !f.noMfa })}>{$t('adminPeople.users.filterNoMfa')}{#if f.noMfa}<Icon name="x" size={14} />{/if}</button>{/if}
      <!-- the dropdown filters show as chips while active (the toggles above are their own chips) -->
      {#each chips.filter((c) => c.id !== 'overrides' && c.id !== 'kids' && c.id !== 'noMfa') as c (c.id)}
        <button type="button" class="chip frost-pill on" aria-label={$t('adminPeople.users.removeFilter', { filter: c.label })} on:click={() => clearOne(c.id)}>{c.label}<Icon name="x" size={14} /></button>
      {/each}
      {#if anyFilter}<button type="button" class="chip frost-pill clear" on:click={() => setF({ ...emptyFilters(), q: '' })}>{$t('adminPeople.users.clearFilters')}</button>{/if}
    </div>

    <div class="ulist">
    <DataTable
      caption={$t('admin.tabs.users')} {rows} {columns} key={(u) => u.id} {total} {error} pageSize={PAGE}
      filterable filterPlaceholder={$t('adminPeople.users.searchPlaceholder')}
      bind:q bind:sort bind:page emptyText={anyFilter ? $t('adminPeople.users.emptyFiltered') : $t('adminPeople.users.empty')}
      {actions} rowLabel={(u) => u.name} busyKey={(u) => `user:${u.id}`}
      on:query={onQuery} on:retry={retry}
    >
      <svelte:fragment slot="toolbar">
        <Select label={$t('adminPeople.users.filterRole')} options={roleFilterOptions} value={f.role ?? ''} on:change={(e) => setF({ role: (e.target as HTMLSelectElement).value || null })} hideLabel />
        <Select label={$t('adminPeople.users.filterStatus')} options={statusOptions} value={f.status ?? ''} on:change={(e) => setF({ status: (e.target as HTMLSelectElement).value || null })} hideLabel />
        <Select label={$t('adminPeople.users.filterLastActive')} options={lastActiveOptions} value={f.lastActive ?? ''} on:change={(e) => setF({ lastActive: (e.target as HTMLSelectElement).value || null })} hideLabel />
        <Select label={$t('adminPeople.users.filterRight')} options={permOptions} value={permValue} on:change={(e) => setPerm((e.target as HTMLSelectElement).value)} hideLabel />
        {#if pageSelectable.length}
          <label class="all"><input type="checkbox" checked={allOnPage} on:change={(e) => togglePage(e.currentTarget.checked)} />{$t('adminPeople.users.selectPage')}</label>
        {/if}
      </svelte:fragment>
      <svelte:fragment slot="cell" let:row let:col>
        {#if col.key === 'select'}
          <label class="pickhit"><input type="checkbox" class="pick" aria-label={$t('adminPeople.users.select', { name: row.name })} checked={selected.has(row.id)} disabled={!selectable(row)}
            on:change={(e) => toggle(row, e.currentTarget.checked)} /></label>
        {:else if col.key === 'name'}
          <span class="who">
            <span class="av" style:background={avatarBg(undefined)} aria-hidden="true">{initial(row.name)}</span>
            <span class="nm">
              <span class="n">{#if row.pending || row.cleanup?.gone}{row.name}{:else}<a href="/admin/users/{row.id}">{row.name}</a>{/if}{#if row.id === meId} <StatusPill tone="info" label={$t('adminPeople.users.you')} icon="" />{/if}</span>
              <span class="st">
                {#if row.pending}<StatusPill tone="warn" label={$t('adminPeople.users.pending')} />
                {:else if row.cleanup}<StatusPill tone={row.cleanup.error ? 'err' : 'warn'} label={$locale && cleanupText(row.cleanup)} />
                {:else if row.disabled && row.locked_reason === 'deletion' && row.deletion_at}<StatusPill tone="err" label={$locale && deletionLabel(row.deletion_at)} icon="lock" />
                {:else if row.disabled}<StatusPill tone="err" label={$t('adminPeople.users.locked')} icon="lock" />
                {:else}<StatusPill tone="ok" label={$t('adminPeople.users.active')} />{/if}
                {#if row.jellyfin_username}<span class="sub">{row.jellyfin_username}</span>{/if}
                {#if row.note}<span class="note" title={row.note}><Icon name="message" size={14} /><span class="sr-only">{$t('adminPeople.users.noteLabel')}: {row.note}</span></span>{/if}
              </span>
            </span>
          </span>
        {:else if col.key === 'email'}<span class="sub em" title={row.email ?? undefined}>{row.email ?? ''}</span>
        {:else if col.key === 'role'}
          {#if row.role === null}<span class="sub">–</span>
          {:else}
            <span class="rolecell"><Select label={$t('adminPeople.users.roleOf', { name: row.name })} options={optionsFor(roleOptions, row.role)} value={row.role} hideLabel
              disabled={row.id === meId || $busyKeys.has(`user:${row.id}`)} on:change={(e) => changeRole(row, (e.target as HTMLSelectElement).value)} /></span>
          {/if}
        {:else if col.key === 'overrides'}
          {#if row.overrides && !row.pending && !row.cleanup}<a class="badge" href="/admin/users/{row.id}?tab=rights" aria-label={$t('adminPeople.users.overridesBadge', { n: row.overrides })}>{fmtNumber(row.overrides)}</a>
          {:else}<span class="sub">–</span>{/if}
        {:else if col.key === 'profiles'}
          <span class="num">{fmtNumber(row.profiles)}</span>{#if row.kidsProfiles}<span class="kids" title={$t('adminPeople.users.kidsCount', { n: row.kidsProfiles })}><Icon name="smile" size={14} />{fmtNumber(row.kidsProfiles)}<span class="sr-only">{$t('adminPeople.users.kidsCount', { n: row.kidsProfiles })}</span></span>{/if}
        {:else if col.key === 'devices'}<span class="num">{fmtNumber(row.devices)}</span>
        {:else if col.key === 'lastSeen'}
          {#if row.last_seen}<time datetime={row.last_seen} title={fmtDateTime(row.last_seen)}>{fmtRelative(row.last_seen)}</time>{:else}<span class="sub">{$t('adminPeople.never')}</span>{/if}
        {:else if col.key === 'mfa'}<span class="sub" title={$t('adminPeople.users.mfaInDetail')}>–</span>
        {:else if col.key === 'accessUntil'}
          {#if row.access_until}<time datetime={row.access_until} title={fmtRelative(row.access_until)}>{fmtDate(row.access_until, { dateStyle: 'medium' })}</time>
          {:else}<span class="sub">{row.pending || row.cleanup ? '–' : $t('adminPeople.users.unlimited')}</span>{/if}
        {/if}
      </svelte:fragment>
    </DataTable>
    </div>
  {/if}
</div>

<style>
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .8rem; margin-bottom: 1rem; }
  /* the filter chips scroll inside their row (a fade at the right edge says there is more), never the page */
  .chips { display: flex; flex-wrap: nowrap; gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; margin-bottom: .8rem; padding-block: 2px; }
  .chips::-webkit-scrollbar { display: none; }
  .chip { flex: none; display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; padding: 0 16px; background: rgba(var(--fr-scrim-rgb), .5); color: rgba(255, 255, 255, .9); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35); font-size: .9rem; font-weight: 600; white-space: nowrap; }
  .chip:hover:not(:disabled) { background: rgba(var(--fr-scrim-rgb), .5); color: #fff; }
  .chip.on, .chip.on:hover:not(:disabled) { background: var(--fr-sel); color: #fff; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .6); }
  .chip.clear { background: transparent; box-shadow: none; text-decoration: underline; }
  .chip:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .badge { display: inline-flex; align-items: center; justify-content: center; min-width: 1.6rem; height: 1.6rem; padding: 0 .4rem; border-radius: 999px; background: var(--tone-warn); color: var(--warn); font-weight: 700; font-size: .85rem; text-decoration: none; font-variant-numeric: tabular-nums; }
  .kids { display: inline-flex; align-items: center; gap: .2rem; margin-inline-start: .5rem; color: var(--mut); font-size: .85rem; vertical-align: middle; }
  .note { display: inline-flex; align-items: center; color: var(--mut); cursor: help; }
  @media (pointer: coarse) { .badge { min-width: 44px; min-height: 44px; } }
  .tabs { display: flex; gap: .4rem; overflow-x: auto; scrollbar-width: none; margin-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: none; min-height: 44px; padding: 0 .9rem; background: transparent; color: var(--mut); border: 0; border-bottom: 2px solid transparent; border-radius: 0; font-weight: 600; white-space: nowrap; }
  .tab:hover:not(:disabled) { color: var(--fg); background: rgba(255,255,255,.04); }
  .tab.on { color: var(--fg); border-bottom-color: var(--accent, #fff); }
  .bulk { position: sticky; top: var(--nav-total); z-index: 3; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .6rem .8rem; margin-bottom: .8rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .bulk .cnt { margin: 0 .4rem 0 0; font-weight: 700; }
  .bulk :global(.field) { min-width: 10rem; }
  .pickapply { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
  .all { display: inline-flex; align-items: center; gap: .4rem; color: var(--mut); font-size: .9rem; min-height: 44px; }
  .pick, .all input { width: 20px; height: 20px; margin: 0; accent-color: var(--accent, #fff); }
  .who { display: inline-flex; align-items: center; gap: .7rem; min-width: 0; }
  .av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: .95rem; color: #fff; }
  .nm { display: flex; flex-direction: column; min-width: 0; text-align: left; }
  .n { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; font-weight: 600; }
  .n a { color: inherit; }
  .sub { color: var(--mut); font-size: .85rem; font-weight: 400; }
  .st { display: flex; align-items: center; flex-wrap: wrap; gap: .1rem .5rem; margin-top: .15rem; font-weight: 400; }
  .num { font-variant-numeric: tabular-nums; }
  time { white-space: nowrap; }
  :global(.dt .bar .field) { min-width: 9.5rem; }
  /* ten columns next to the admin sidebar: tighter cells, headers may wrap */
  @media (min-width: 721px) {
    .ulist :global(th), .ulist :global(td) { padding-inline: .5rem; }
    .ulist :global(th) { white-space: normal; }
    .rolecell { display: block; min-width: 7.5rem; }
    .ulist :global(td.primary) { min-width: 11rem; }
    .em { display: block; max-width: 8.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; word-break: normal; }
  }
  /* next to the admin sidebar, below 1500 px the table does not fit with all eleven columns: the device count, the 2FA placeholder and
     the access end (all on the user's page) give way, so the name keeps its room and the page never scrolls sideways */
  @media (min-width: 721px) and (max-width: 1499px) {
    .ulist :global(th:nth-child(7)), .ulist :global(td:nth-child(7)), .ulist :global(th:nth-child(9)), .ulist :global(td:nth-child(9)), .ulist :global(th:nth-child(10)), .ulist :global(td:nth-child(10)) { display: none; }
  }
  /* phone card: the selection cell is the first line, keep its box clear of the actions button (top right) */
  /* touch: the row checkbox gets a 44 px hit box around its 20 px glyph (no label to click) */
  .pickhit { display: inline-flex; align-items: center; justify-content: center; }
  @media (pointer: coarse) {
    .pickhit { min-width: 44px; min-height: 44px; margin: -12px; cursor: pointer; }
  }
  @media (pointer: coarse) and (min-width: 721px) {
    .ulist :global(td:has(> .pickhit)) { z-index: 1; } /* table layout: the 44 px box overhangs the next cell, keep it on top (the phone card has its actions button there, which must stay on top) */
  }
  @media (max-width: 720px) {
    .pickhit { margin-right: 3.2rem; } .bulk { position: static; }
    :global(.dt .bar .field) { flex: 1 1 100%; } /* the four filters share one width */
    .chips { padding-inline-end: 1.5rem; -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 1.5rem), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 1.5rem), transparent); }
    /* the tab strip scrolls: a fade at the right edge says there is more (the end padding keeps the last label clear of it) */
    .tabs { padding-inline-end: 1.5rem; -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 1.5rem), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 1.5rem), transparent); }
  }
</style>
