<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Quellen* (spec §9.1): one card per provider list (SourceCard), then one per extra programme guide (GuideCard, in
   * their `position` order, moved up / down by swapping two positions), the *Eigene Streams* card (OwnFeedsCard) once that source
   * exists, *Quelle hinzufügen* (SourceSheet; its kind *Programmführer* opens GuideSheet, *Eigene Streams* opens StreamSheet, which
   * creates the own-feeds source on first use). *Jetzt aktualisieren* posts the refresh (202 `{ started }`; 409 `livetv_off` / `no_list` have their own
   * text) and asks `GET /sources` every REFRESH_POLL_MS until the
   * source's `lastRefreshAt` moved, then says the outcome in a toast; the button keeps its spinner meanwhile. Deleting names how
   * many channels go. Loading keeps the cards' place with skeletons of their height.
   */
  import { onDestroy, onMount } from 'svelte';
  import { refreshSummary } from '#lib/admin/summary';
  import { ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { toast } from '#lib/ui/toast';
  import { deleteSource, listSources, refreshSource, updateGuide, uploadGuideFile, updateSource, type PushResult, type Refresh, type SourceView } from './api';
  import GuideCard from './GuideCard.svelte';
  import GuideSheet from './GuideSheet.svelte';
  import OwnFeedsCard from './OwnFeedsCard.svelte';
  import SourceCard from './SourceCard.svelte';
  import SourceSheet from './SourceSheet.svelte';
  import StreamSheet from './StreamSheet.svelte';
  import { fileFailText, GUIDE_FILE_MAX, guideMoves, REFRESH_POLL_MS, REFRESH_POLLS, refreshDone, refreshedAt, refreshResult } from './sources';

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
  $: guides = (sources ?? []).filter((s) => s.kind === 'guide').sort((a, b) => a.position - b.position);
  $: feedsSource = (sources ?? []).find((s) => s.kind === 'feeds') ?? null;
  const replace = (v: SourceView) => { sources = sources ? (sources.some((s) => s.id === v.id) ? sources.map((s) => (s.id === v.id ? v : s)) : [...sources, v]) : [v]; };

  // ---- the sheets
  let sheet: { source: SourceView | null; trigger: HTMLElement | null; autoTest?: boolean } | null = null;
  let guideSheet: { source: SourceView | null; trigger: HTMLElement | null; enable?: boolean } | null = null;
  let stream: { result: { name: string; push: PushResult; synced?: boolean } | null; trigger: HTMLElement | null } | null = null;
  let feedsCard: OwnFeedsCard | undefined;
  const openAdd = (e: MouseEvent) => { sheet = { source: null, trigger: e.currentTarget instanceof HTMLElement ? e.currentTarget : null }; };
  function toOwn(from: { trigger: HTMLElement | null } | null) {
    const trigger = from?.trigger ?? null;
    sheet = null; guideSheet = null;
    stream = { result: null, trigger };
  }
  function toGuide() {
    const trigger = sheet?.trigger ?? null;
    sheet = null;
    guideSheet = { source: null, trigger };
  }
  function toList() {
    const trigger = guideSheet?.trigger ?? null;
    guideSheet = null;
    sheet = { source: null, trigger };
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
    const since = refreshedAt(s);
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
    void refreshSummary(); // the nav badge counts failed sources
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
      run: () => (s.kind === 'guide' ? updateGuide(s.id, { refresh }) : updateSource(s.id, { refresh })),
      success: tr('adminLive.src.saved'),
    }).then((r) => { if (r.ok && r.value) replace(r.value); });
  }
  function toggle(s: SourceView) {
    const enabled = !s.enabled;
    void runAction({
      key: `ltv-src:${s.id}`,
      apply: () => { const prev = s; replace({ ...s, enabled }); return () => replace(prev); },
      run: () => (s.kind === 'guide' ? updateGuide(s.id, { enabled }) : updateSource(s.id, { enabled })),
      success: enabled ? tr('adminLive.src.enabled') : tr('adminLive.src.disabled'),
    }).then((r) => { if (r.ok && r.value) replace(r.value); void refreshSummary(); });
  }
  async function remove(s: SourceView) {
    const body = s.kind === 'guide' ? tr('adminLive.src.guide.deleteBody', { n: s.servedChannels }) : tr('adminLive.src.deleteBody', { n: s.channelCount });
    const ok = await confirm({ title: tr('adminLive.src.deleteTitle', { name: s.name }), body, danger: true, confirmLabel: tr('adminLive.src.delete') });
    if (!ok) return;
    await runAction({
      key: `ltv-src:${s.id}`,
      apply: () => { const prev = sources; sources = (sources ?? []).filter((x) => x.id !== s.id); return () => { sources = prev; }; },
      run: () => deleteSource(s.id),
      success: tr('adminLive.src.deleted'),
    });
    void refreshSummary();
  }

  // ---- Neue Datei hochladen: PUT the file, the card shows its name and size at once; the import runs on the server
  async function upload(s: SourceView, file: File) {
    if (file.size > GUIDE_FILE_MAX) { toast.error(tr('adminLive.src.guide.tooLarge')); return; }
    const r = await runAction({
      key: `ltv-src-upload:${s.id}`,
      run: () => uploadGuideFile(s.id, file),
      error: false,
    });
    if (r.skipped) return;
    if (!r.ok) { toast.error(fileFailText(r.error)); return; }
    replace({ ...s, fileName: file.name, fileBytes: file.size });
    toast.success(tr('adminLive.src.guide.uploaded'));
    void load();
  }

  // ---- the order among the guides: one PATCH with the neighbour's position (the backend swaps the two); shown at once, then the
  // page asks GET /sources for the truth
  async function move(s: SourceView, dir: 1 | -1) {
    const mv = guideMoves(guides, s.id, dir);
    if (!mv) return;
    const r = await runAction({
      key: `ltv-src:${s.id}`,
      apply: () => {
        const prev = sources;
        sources = (sources ?? []).map((x) => { const m = mv.swap.find((y) => y.id === x.id); return m ? { ...x, position: m.position } : x; });
        return () => { sources = prev; };
      },
      run: () => updateGuide(mv.patch.id, { position: mv.patch.position }),
      success: tr('adminLive.src.guide.moved'),
    });
    if (!r.skipped) await load();
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
  {:else if !lists.length && !guides.length && !feedsSource}
    <AdminCard><p class="empty">{$t('adminLive.src.empty')}</p></AdminCard>
  {:else}
    {#each lists as s (s.id)}
      <SourceCard source={s} {now} refreshing={$busyKeys.has(`ltv-src-refresh:${s.id}`)} busy={$busyKeys.has(`ltv-src:${s.id}`)}
        on:refresh={() => refresh(s)} on:edit={(e) => (sheet = { source: s, trigger: e.detail })} on:pick={(e) => (sheet = { source: s, trigger: e.detail, autoTest: true })} on:toggle={() => toggle(s)} on:remove={() => remove(s)} on:interval={(e) => setInterval_(s, e.detail)} />
    {/each}
    {#each guides as s, i (s.id)}
      <GuideCard source={s} sources={sources} {now} first={i === 0} last={i === guides.length - 1} refreshing={$busyKeys.has(`ltv-src-refresh:${s.id}`)} busy={$busyKeys.has(`ltv-src:${s.id}`)}
        uploading={$busyKeys.has(`ltv-src-upload:${s.id}`)} on:upload={(e) => upload(s, e.detail)} on:refresh={() => refresh(s)} on:edit={(e) => (guideSheet = { source: s, trigger: e.detail })} on:enable={(e) => (guideSheet = { source: s, trigger: e.detail, enable: true })} on:toggle={() => toggle(s)} on:remove={() => remove(s)}
        on:interval={(e) => setInterval_(s, e.detail)} on:move={(e) => move(s, e.detail)} />
    {/each}
    {#if feedsSource}
      {#key feedsSource.id}
        <OwnFeedsCard bind:this={feedsCard} source={feedsSource} on:add={(e) => (stream = { result: null, trigger: e.detail })} on:result={(e) => (stream = { result: { name: e.detail.name, push: e.detail.push, synced: e.detail.synced }, trigger: e.detail.trigger })} />
      {/key}
    {/if}
  {/if}
</div>

{#if sheet}
  <SourceSheet source={sheet.source} trigger={sheet.trigger} autoTest={sheet.autoTest ?? false} on:close={() => (sheet = null)} on:saved={saved} on:own={() => toOwn(sheet)} on:guide={toGuide} />
{/if}
{#if guideSheet}
  <GuideSheet source={guideSheet.source} sources={sources ?? []} trigger={guideSheet.trigger} enable={guideSheet.enable ?? false} on:close={() => (guideSheet = null)} on:saved={saved} on:created={(e) => replace(e.detail)} on:list={toList} on:own={() => toOwn(guideSheet)} />
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
