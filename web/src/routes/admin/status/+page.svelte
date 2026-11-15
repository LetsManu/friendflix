<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Status (Block 22: the health page): the Systemcheck (one line per check with cause, fix and where to fix it; "Jetzt prüfen"
   * waits for a fresh run), disks, active / failed playbacks and the top errors of 24 h, the sign-in card (#login), then the numbers.
   * Snapshot and Systemcheck every 30 s, streams every 10 s while visible.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtNumber, fmtRelative, t, type TFn } from '#lib/i18n';
  import { poll } from '#lib/adminContent/poll';
  import { refreshSummary, summary, summaryFailed, type AdminSummary } from '#lib/admin/summary';
  import { loadErrors, loadHealth, loadStreams, type ErrorList, type HealthSnapshot, type StreamsView } from '#lib/admin/health';
  import SystemCheck from '#lib/admin/SystemCheck.svelte';
  import DiskCard from '#lib/admin/DiskCard.svelte';
  import StreamsCard from '#lib/admin/StreamsCard.svelte';
  import ErrorsCard from '#lib/admin/ErrorsCard.svelte';
  import LoginCard from '#lib/admin/LoginCard.svelte';
  import SuggestionsCard from '#lib/admin/SuggestionsCard.svelte';
  import { errorText } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import StatTile from '#lib/ui/StatTile.svelte';

  $: s = $summary;
  let snap: HealthSnapshot | null = null, snapErr: string | null = null;
  let streams: StreamsView | null = null, streamsErr: string | null = null;
  let errors: ErrorList | null = null, errorsErr: string | null = null;
  let refreshing = false;

  async function loadSnap() {
    try { snap = await loadHealth(); snapErr = null; } catch (e) { snapErr = errorText(e); }
  }
  async function loadStr() {
    try { streams = await loadStreams(); streamsErr = null; } catch (e) { streamsErr = errorText(e); }
  }
  async function loadErr() {
    try { errors = await loadErrors(24); errorsErr = null; } catch (e) { errorsErr = errorText(e); }
  }
  type Tr = TFn;
  /** "Updated 3 hours ago" / "Building…" / "Not built yet" / "Not supported by the media server" */
  function recoHint(tt: Tr, r: AdminSummary['recoIndex']): string {
    if (!r) return '';
    if (!r.supported) return tt('adminContent.status.recoIndexOff');
    if (r.updatedAt) return tt('adminContent.status.recoIndexUpdated', { when: fmtRelative(r.updatedAt) });
    return tt(r.running ? 'adminContent.status.recoIndexBuilding' : 'adminContent.status.recoIndexNever');
  }
  const reloadSummary = async () => { refreshing = true; await refreshSummary(); refreshing = false; };
  const slow = () => { void loadSnap(); void loadErr(); void refreshSummary(); };

  let stops: Array<() => void> = [];
  onMount(() => {
    void loadSnap(); void loadStr(); void loadErr(); void reloadSummary();
    stops = [poll(slow, 30_000), poll(loadStr, 10_000)];
  });
  onDestroy(() => stops.forEach((f) => f()));

  /**
   * Nothing below the Systemcheck renders before its list has its final height (a remembered answer: at once; a cold load: when the
   * answer or the failure is in), so the cards below never move when the lines fill in. Their data still loads from the start.
   */
  let listReady = false;
  let scrolled = false;
  // a deep link to a card below (e.g. /admin/status#login) finds its target only once it is rendered
  $: if (listReady && !scrolled) { scrolled = true; void tick().then(scrollToHash); }
  function scrollToHash() {
    const id = location.hash.slice(1);
    if (id && id !== 'systemcheck' && /^[a-z-]+$/.test(id)) document.getElementById(id)?.scrollIntoView();
  }
</script>

<p class="intro muted">{$t('adminContent.health.intro')}</p>

<!-- "Jetzt prüfen" there also refreshed the health snapshot on the server: the disks and errors below read it again -->
<SystemCheck bind:ready={listReady} on:checked={loadSnap} />

{#if listReady}
{#if snapErr && !snap}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.health.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={loadSnap}>{$t('ui.retry')}</Button></div>
{/if}

<DiskCard disks={snapErr && !snap ? [] : snap?.disks ?? null} />

<div class="cols">
  <StreamsCard view={streams} error={streamsErr} on:retry={loadStr} />
  <ErrorsCard list={errors} recent={snap?.errors ?? null} error={errorsErr} on:retry={loadErr} />
</div>

<div id="login" class="anchor"><LoginCard /></div>

<section aria-labelledby="st-num">
  <h2 id="st-num">{$t('adminContent.status.numbers')}</h2>
  {#if $summaryFailed && !s}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.status.loadFailed')}</p><Button variant="secondary" icon="refresh" pending={refreshing} on:click={reloadSummary}>{$t('ui.retry')}</Button></div>
  {:else}
    <div class="stats">
      <StatTile icon="users" label={$t('admin.status.users')} value={s ? fmtNumber(s.users.active) : null} href="/admin/users" hint={s ? `${$t('admin.dash.locked')}: ${fmtNumber(s.users.locked)}` : ''} />
      <StatTile icon="play" label={$t('admin.status.activeStreams')} value={s ? fmtNumber(s.live.streams) : null} href="/admin/playback" />
      <StatTile icon="tv" label={$t('admin.status.partyRooms')} value={s ? fmtNumber(s.live.partyRooms) : null} />
      <StatTile icon="mail" label={$t('admin.status.openInvites')} value={s ? fmtNumber(s.pending.invites) : null} href="/admin/users?tab=invites" />
      <StatTile icon="monitor" label={$t('admin.status.pendingDevices')} value={s ? fmtNumber(s.pending.devices) : null} href="/admin/devices" tone={s?.pending.devices ? 'warn' : 'default'} />
      <StatTile icon="vote" label={$t('admin.status.pendingPolls')} value={s ? fmtNumber(s.pending.polls) : null} href="/admin/polls" tone={s?.pending.polls ? 'warn' : 'default'} />
      <StatTile icon="inbox" label={$t('adminContent.status.pendingRequests')} value={!s ? null : s.pending.requests === null ? '–' : fmtNumber(s.pending.requests)} href="/admin/requests" tone={s?.pending.requests ? 'warn' : 'default'} />
      <StatTile icon="search" label={$t('adminContent.status.recoIndex')} value={s?.recoIndex ? (s.recoIndex.supported ? fmtNumber(s.recoIndex.items) : '–') : s ? '–' : null} hint={recoHint($t, s?.recoIndex)} />
      <StatTile icon="image" label={$t('admin.dash.svc.previews')} value={s ? fmtNumber(s.pending.previewsFailed) : null} href="/admin/previews" hint={s ? $t('admin.dash.state.failed', { n: s.pending.previewsFailed }) : ''} tone={s?.pending.previewsFailed ? 'err' : 'default'} />
    </div>
  {/if}
</section>

<p class="foot"><Button variant="ghost" icon="refresh" pending={refreshing} on:click={() => { void reloadSummary(); slow(); void loadStr(); }}>{$t('admin.playback.refresh')}</Button></p>

<SuggestionsCard />
{/if}

<style>
  .intro { margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; font-weight: 700; margin: 0; }
  section { margin-bottom: 1.4rem; }
  section > h2 { margin-bottom: .6rem; }
  .anchor { scroll-margin-top: 5rem; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 1rem; }
  @media (min-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: .8rem; }
  .foot { margin: 0; }
  .state { margin-bottom: 1.4rem; display: flex; flex-direction: column; align-items: center; gap: .7rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
