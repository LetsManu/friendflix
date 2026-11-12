<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV. Not installed: only the optional entry (EnableCard: what it is, the button / the .env line / the Portainer line,
   * "Nicht mehr anzeigen"). While a job runs the page shows its steps and asks GET /api/admin/livetv/state every 3 s; when the
   * container is detected the area appears without a reload. Installed: the area's tabs in the URL (`?tab=`, spec §9; *Quellen* is
   * the default and has no parameter; on a phone the tabs are a scrolling chip row): *Quellen* (SourcesTab), *Kanäle*, *Gruppen &
   * Rechte*, *Programmführer* (Tasks 23–26 fill them) and *Live-Status* (MiniStatus until Task 26: version, GPU advice, the speed
   * measurement's outcome, "Live-TV ausschalten …"). The shell and the page's cards own the <h1> / <title>.
   */
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { saveSettings } from '#lib/admin/settings/api';
  import { refreshSummary } from '#lib/admin/summary';
  import EnableCard from '#lib/admin/livetv/EnableCard.svelte';
  import GroupsTab from '#lib/admin/livetv/GroupsTab.svelte';
  import MiniStatus from '#lib/admin/livetv/MiniStatus.svelte';
  import OffDialog from '#lib/admin/livetv/OffDialog.svelte';
  import SourcesTab from '#lib/admin/livetv/SourcesTab.svelte';
  import { TABS, tabOf, type Tab } from '#lib/admin/livetv/sources';
  import { pageStore } from '#lib/page';
  import { POLL_MS, SETTLE_MS, enableMode, errorKey, jobRunning, livetvJob, phase, type LivetvAdminState, type LivetvJob } from '#lib/admin/livetv/state';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { toast } from '#lib/ui/toast';

  let s: LivetvAdminState | null = null, failed = false;
  /** a refused enable: the message key; '' = none */
  let refused = '', hideError = false;
  let settleUntil = 0, settling = false;
  let timer: ReturnType<typeof setTimeout> | undefined, gone = false;
  let offOpen = false, offTrigger: HTMLElement | null = null;

  const page$ = pageStore();
  $: tab = tabOf($page$.url.searchParams.get('tab'));
  const select = (to: Tab) => goto(to === 'sources' ? $page$.url.pathname : `?tab=${to}`, { replaceState: true, reset: false });
  function tabKey(e: KeyboardEvent) {
    const i = TABS.indexOf(tab), last = TABS.length - 1;
    const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + last) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (n < 0) return;
    e.preventDefault(); void select(TABS[n]!);
    queueMicrotask(() => { const el = document.getElementById(`ltv-tab-${TABS[n]!}`); el?.focus(); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  }

  $: mode = s ? enableMode(s) : 'env';
  $: ph = s ? phase(s, settling) : 'offer';

  const schedule = () => {
    clearTimeout(timer);
    if (!gone && s && (jobRunning(s) || settling)) timer = setTimeout(load, POLL_MS);
  };
  async function load() {
    const wasRunning = s ? jobRunning(s) : false, wasInstalled = s?.installed;
    try { s = await api<LivetvAdminState>('/api/admin/livetv/state'); failed = false; } catch { failed = true; }
    if (s) {
      // a finished enable: detection may need a moment, so the page says "checking" instead of "not running"
      if (wasRunning && !jobRunning(s)) {
        const j = livetvJob(s);
        if (j?.action === 'livetv-enable' && j.state === 'succeeded' && !s.installed) settleUntil = Date.now() + SETTLE_MS;
        void refreshSummary();
      } else if (wasInstalled !== undefined && wasInstalled !== s.installed) void refreshSummary();
      if (s.installed) settleUntil = 0;
      settling = Date.now() < settleUntil && !s.installed && !jobRunning(s);
    }
    schedule();
  }
  onMount(load);
  onDestroy(() => { gone = true; clearTimeout(timer); });

  const body = (e: unknown) => (e instanceof ApiError ? (e.body as { error?: unknown; wanted?: unknown } | null) : null);
  /** the message key of a refused request */
  const refusal = (e: unknown): string => (e instanceof ApiError && e.status === 429 ? 'tooSoon' : errorKey(typeof body(e)?.error === 'string' ? (body(e)!.error as string) : null));
  /** the refusal leaves `wanted` as it was; the answer says what it is */
  const keepWanted = (e: unknown) => { const w = body(e)?.wanted; if (s && typeof w === 'boolean') s = { ...s, wanted: w }; };

  async function enable() {
    refused = ''; settleUntil = 0; settling = false;
    const r = await runAction({ key: 'livetv:enable', run: () => api<{ job: LivetvJob; wanted: boolean }>('/api/admin/livetv/enable', { method: 'POST' }), error: false });
    if (r.ok && r.value && s) {
      s = { ...s, wanted: r.value.wanted, updater: { ...s.updater, job: r.value.job } };
      schedule();
    } else if (!r.skipped) {
      refused = refusal(r.error);
      keepWanted(r.error);
    }
  }
  async function hide() {
    hideError = false;
    const r = await runAction({ key: 'livetv:hide', run: () => saveSettings({ LIVETV_OFFER_HIDDEN: true }), error: false });
    if (!r.ok) { hideError = !r.skipped; return; }
    await refreshSummary();
    await goto('/admin');
  }
  async function disable(e: CustomEvent<{ removeImage: boolean; removeCache: boolean }>) {
    const r = await runAction({ key: 'livetv:disable', run: () => api<{ job: LivetvJob; wanted: boolean }>('/api/admin/livetv/disable', { method: 'POST', body: e.detail }), error: false });
    if (r.ok && r.value && s) {
      offOpen = false;
      s = { ...s, wanted: r.value.wanted, updater: { ...s.updater, job: r.value.job } };
      schedule();
    } else if (!r.skipped) {
      offOpen = false;
      keepWanted(r.error);
      toast.error(tr(`adminLive.err.${refusal(r.error)}` as 'adminLive.err.generic'));
    }
  }
</script>

{#if !s}
  {#if failed}
    <AdminCard><div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminLive.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div></AdminCard>
  {:else}
    <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="14rem" h="1.6rem" /><Skeleton h="2.8rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
  {/if}
{:else if ph === 'area'}
  <div class="tabs" role="tablist" aria-label={$t('adminLive.tabs.label')}>
    {#each TABS as k (k)}
      <button type="button" role="tab" id="ltv-tab-{k}" class="tab" class:on={tab === k} aria-selected={tab === k} aria-controls="ltv-panel" tabindex={tab === k ? 0 : -1}
        on:click={() => select(k)} on:keydown={tabKey}>{$t(`adminLive.tabs.${k}`)}</button>
    {/each}
  </div>
  <div id="ltv-panel" role="tabpanel" aria-labelledby="ltv-tab-{tab}" tabindex="-1">
    {#if tab === 'sources'}<SourcesTab />
    {:else if tab === 'groups'}<GroupsTab />
    {:else if tab === 'status'}<MiniStatus {s} on:off={(e) => { offTrigger = e.detail; offOpen = true; }} />
    {:else}<AdminCard><p class="soon">{$t('adminLive.tabs.soon')}</p></AdminCard>{/if}
  </div>
{:else}
  <EnableCard {s} {mode} phase={ph} {refused} {hideError} pending={$busyKeys.has('livetv:enable')} hiding={$busyKeys.has('livetv:hide')} on:enable={enable} on:hide={hide} />
{/if}

<OffDialog open={offOpen} manual={mode !== 'updater'} foreign={mode === 'portainer'} trigger={offTrigger} pending={$busyKeys.has('livetv:disable')} on:close={() => (offOpen = false)} on:confirm={disable} />

<style>
  .state { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; min-height: 3rem; }
  .state p { margin: 0; flex: 1 1 14rem; }
  .sk { display: grid; gap: .8rem; min-height: 6rem; }
  .soon { margin: 0; }
  #ltv-panel { outline: none; min-width: 0; }

  /* the area's tabs: underlined labels next to the sidebar; on a phone a scrolling row of chips (spec §9) */
  .tabs { display: flex; gap: .4rem; overflow-x: auto; scrollbar-width: none; margin-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: none; min-height: 44px; padding: 0 .9rem; background: transparent; color: var(--mut); border: 0; border-bottom: 2px solid transparent; border-radius: 0; font-weight: 600; white-space: nowrap; }
  .tab:hover:not(:disabled) { color: var(--fg); background: rgba(255,255,255,.04); }
  .tab.on { color: var(--fg); border-bottom-color: var(--accent, #fff); }
  @media (max-width: 720px) {
    .tabs { border-bottom: 0; gap: .5rem; padding-bottom: 2px; }
    .tab { border: 1px solid var(--fr-line, rgba(255,255,255,.2)); border-radius: 999px; padding: 0 1rem; background: rgba(255,255,255,.06); color: rgba(255,255,255,.85); }
    .tab.on { background: #fff; color: #101418; border-color: #fff; }
  }
</style>
