<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Quellen* (spec §9.1): one card per provider list (SourceCard), the *Eigene Streams* card (OwnFeedsCard) once
   * that source exists, *Quelle hinzufügen* (SourceSheet; its kind *Eigene Streams* opens StreamSheet, which creates the own-feeds
   * source on first use). *Jetzt aktualisieren* posts the refresh (202 `{ started }`; 409 `livetv_off` / `no_list` have their own
   * text) and asks `GET /sources` every REFRESH_POLL_MS until the
   * source's `lastRefreshAt` moved, then says the outcome in a toast; the button keeps its spinner meanwhile. Deleting names how
   * many channels go. Loading keeps the cards' place with skeletons of their height.
   */
  import { onDestroy, onMount } from 'svelte';
  import { ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { toast } from '#lib/ui/toast';
  import { deleteSource, listSources, refreshSource, updateSource, type PushResult, type Refresh, type SourceView } from './api';
  import OwnFeedsCard from './OwnFeedsCard.svelte';
  import SourceCard from './SourceCard.svelte';
  import SourceSheet from './SourceSheet.svelte';
  import StreamSheet from './StreamSheet.svelte';
  import { REFRESH_POLL_MS, REFRESH_POLLS, refreshDone, refreshResult } from './sources';

  let sources: SourceView[] | null = null, failed = false, gone = false;
  let now = new Date();
  const clock = setInterval(() => { now = new Date(); }, 60_000);
  onDestroy(() => { gone = true; clearInterval(clock); });

  async function load() {
    try { sources = await listSources(); failed = false; } catch { if (!sources) failed = true; }
    now = new Date();
  }
  onMount(load);

  $: lists = (sources ?? []).filter((s) => s.kind === 'm3u').sort((a, b) => a.position - b.position);
  $: feedsSource = (sources ?? []).find((s) => s.kind === 'feeds') ?? null;
  const replace = (v: SourceView) => { sources = sources ? (sources.some((s) => s.id === v.id) ? sources.map((s) => (s.id === v.id ? v : s)) : [...sources, v]) : [v]; };

  // ---- the sheets
  let sheet: { source: SourceView | null; trigger: HTMLElement | null } | null = null;
  let stream: { result: { name: string; push: PushResult; synced?: boolean } | null; trigger: HTMLElement | null } | null = null;
  let feedsCard: OwnFeedsCard | undefined;
  const openAdd = (e: MouseEvent) => { sheet = { source: null, trigger: e.currentTarget instanceof HTMLElement ? e.currentTarget : null }; };
  function toOwn() {
    const trigger = sheet?.trigger ?? null;
    sheet = null;
    stream = { result: null, trigger };
  }
  function saved(e: CustomEvent<SourceView>) {
    const isNew = !sources?.some((s) => s.id === e.detail.id);
    replace(e.detail);
    toast.success(isNew ? tr('adminLive.src.created') : tr('adminLive.src.saved'));
  }
  async function streamCreated() {
    toast.success(tr('adminLive.push.created'));
    // the first own feed creates the own-feeds source; the card then shows the new row
    if (!feedsSource) await load(); else await feedsCard?.reload();
  }

  // ---- Jetzt aktualisieren
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  async function untilRefreshed(id: string, since: string | null): Promise<SourceView | null> {
    for (let i = 0; i < REFRESH_POLLS && !gone; i++) {
      await wait(REFRESH_POLL_MS);
      if (gone) return null;
      try {
        const all = await listSources();
        sources = all;
        const s = all.find((x) => x.id === id);
        if (!s) return null;
        if (refreshDone(s, since)) return s;
      } catch { /* the next round asks again */ }
    }
    return null;
  }
  async function refresh(s: SourceView) {
    const since = s.state.lastRefreshAt;
    const r = await runAction({
      key: `ltv-src-refresh:${s.id}`,
      run: async () => {
        // `started: false`: one already runs; its outcome arrives the same way, so the button keeps turning until then
        const { started } = await refreshSource(s.id);
        if (!started) toast.info(tr('adminLive.src.refreshRunning'));
        return untilRefreshed(s.id, since);
      },
      error: false,
    });
    if (r.skipped || gone) return;
    if (!r.ok) {
      const c = r.error instanceof ApiError && r.error.status === 409 ? r.error.body?.error : null;
      toast.error(c === 'livetv_off' ? tr('adminLive.src.refreshOff') : c === 'no_list' ? tr('adminLive.src.refreshNoList') : errorText(r.error));
      return;
    }
    if (!r.value) { toast.info(tr('adminLive.src.refreshSlow')); return; }
    now = new Date();
    const res = refreshResult(r.value);
    if (res.ok) toast.success(res.text); else toast.error(res.text);
  }

  // ---- interval, on/off, delete
  function setInterval_(s: SourceView, refresh: Refresh) {
    void runAction({
      key: `ltv-src:${s.id}`,
      apply: () => { const prev = s; replace({ ...s, refresh }); return () => replace(prev); },
      run: () => updateSource(s.id, { refresh }),
      success: tr('adminLive.src.saved'),
    }).then((r) => { if (r.ok && r.value) replace(r.value); });
  }
  function toggle(s: SourceView) {
    const enabled = !s.enabled;
    void runAction({
      key: `ltv-src:${s.id}`,
      apply: () => { const prev = s; replace({ ...s, enabled }); return () => replace(prev); },
      run: () => updateSource(s.id, { enabled }),
      success: enabled ? tr('adminLive.src.enabled') : tr('adminLive.src.disabled'),
    }).then((r) => { if (r.ok && r.value) replace(r.value); });
  }
  async function remove(s: SourceView) {
    const ok = await confirm({ title: tr('adminLive.src.deleteTitle', { name: s.name }), body: tr('adminLive.src.deleteBody', { n: s.channelCount }), danger: true, confirmLabel: tr('adminLive.src.delete') });
    if (!ok) return;
    await runAction({
      key: `ltv-src:${s.id}`,
      apply: () => { const prev = sources; sources = (sources ?? []).filter((x) => x.id !== s.id); return () => { sources = prev; }; },
      run: () => deleteSource(s.id),
      success: tr('adminLive.src.deleted'),
    });
  }
</script>

<div class="tab">
  <div class="bar">
    <Button icon="plus" on:click={openAdd}>{$t('adminLive.src.add')}</Button>
  </div>

  {#if failed}
    <AdminCard><div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminLive.src.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div></AdminCard>
  {:else if !sources}
    {#each [0, 1] as i (i)}
      <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="12rem" h="1.3rem" /><Skeleton w="16rem" /><Skeleton lines={2} /><Skeleton w="20rem" h="2.8rem" /></div></AdminCard>
    {/each}
    <p class="sr-only" role="status">{$t('ui.table.loading')}</p>
  {:else if !lists.length && !feedsSource}
    <AdminCard><p class="empty">{$t('adminLive.src.empty')}</p></AdminCard>
  {:else}
    {#each lists as s (s.id)}
      <SourceCard source={s} {now} refreshing={$busyKeys.has(`ltv-src-refresh:${s.id}`)} busy={$busyKeys.has(`ltv-src:${s.id}`)}
        on:refresh={() => refresh(s)} on:edit={(e) => (sheet = { source: s, trigger: e.detail })} on:toggle={() => toggle(s)} on:remove={() => remove(s)} on:interval={(e) => setInterval_(s, e.detail)} />
    {/each}
    {#if feedsSource}
      {#key feedsSource.id}
        <OwnFeedsCard bind:this={feedsCard} source={feedsSource} on:add={(e) => (stream = { result: null, trigger: e.detail })} on:result={(e) => (stream = { result: { name: e.detail.name, push: e.detail.push, synced: e.detail.synced }, trigger: e.detail.trigger })} />
      {/key}
    {/if}
  {/if}
</div>

{#if sheet}
  <SourceSheet source={sheet.source} trigger={sheet.trigger} on:close={() => (sheet = null)} on:saved={saved} on:own={toOwn} />
{/if}
{#if stream}
  <StreamSheet result={stream.result} trigger={stream.trigger} on:close={() => (stream = null)} on:created={streamCreated} />
{/if}

<style>
  .tab { min-width: 0; }
  .bar { display: flex; flex-wrap: wrap; gap: .6rem; margin-bottom: 1rem; }
  .state { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; min-height: 3rem; }
  .state p { margin: 0; flex: 1 1 14rem; }
  .state :global(svg) { color: var(--err); }
  .sk { display: grid; gap: .7rem; min-height: 11rem; }
  .empty { margin: 0; }
</style>
