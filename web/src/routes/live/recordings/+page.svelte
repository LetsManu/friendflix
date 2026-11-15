<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { features, featuresKnown } from '#lib/capabilities';
  import { t, tr } from '#lib/i18n';
  import { kidsMode } from '#lib/kids';
  import { perms } from '#lib/perms';
  import { confirm } from '#lib/ui/confirm';
  import { errorText } from '#lib/ui/action';
  import { toast } from '#lib/ui/toast';
  import Toggle from '#lib/ui/Toggle.svelte';
  import Icon from '#lib/Icon.svelte';
  import { channels as fetchChannels, type LiveChannel } from '#lib/live/api';
  import RecordingItem from '#lib/live/RecordingItem.svelte';
  import RecordingsRow from '#lib/live/RecordingsRow.svelte';
  import TimeRecordSheet from '#lib/live/TimeRecordSheet.svelte';
  import {
    deleteRecording, deleteRule, finished, groupBySeries, listRecordings, patchRecording, patchRule, planned, stepKeep, stopRecording, toLibrary, type Recording, type Rule, type Visibility,
  } from '#lib/live/recordings';

  /**
   * *Meine Aufnahmen* (spec §15.7, plan Phase 3 Task 8): a segmented *Fertig* / *Geplant* / *Serien*. *Fertig* is grouped by series
   * with episode lists, singles by date; each item plays, keeps (*Behalten*), shares (*Teilen…*), ends a running one early and keeps it
   * (*Jetzt beenden*) and deletes (*Löschen*: gone at once,
   * the DELETE waits 5 s behind an undo toast; leaving the page sends it at once). *Geplant* cancels and shows the *Konflikt* chip,
   * *Serien* the rules with their settings. *Neue Aufnahme* plans by time. A TV gets the finished recordings as a tile grid: D-pad,
   * OK plays, Back; the tiles take the entry focus. Live TV off (or not for this person) sends the page home.
   */
  type View = 'done' | 'planned' | 'series';
  const VIEWS: Array<{ v: View; k: 'live.mine.done' | 'live.mine.planned' | 'live.mine.series' }> = [
    { v: 'done', k: 'live.mine.done' }, { v: 'planned', k: 'live.mine.planned' }, { v: 'series', k: 'live.mine.series' },
  ];
  const DELETE_DELAY_MS = 5_000;

  let view: View = 'done';
  let recs: Recording[] | null = null;
  let rules: Rule[] = [];
  let failed = false;
  let tvMode = false;
  let busy = new Set<string>();
  let timeOpen = false;
  let timeTrigger: HTMLElement | null = null;
  let chans: LiveChannel[] | null = null;
  /** *Behalten → in Bibliothek* is possible on this server (mode `both` with a library) */
  let libraryExport = false;
  /** recordings that ran while this page showed them: their *Jetzt beenden* slot stays after they finished (until the page is left) */
  let seenRunning = new Set<string>();
  $: if (recs?.some((r) => r.state === 'recording' && !seenRunning.has(r.id))) seenRunning = new Set([...seenRunning, ...recs.filter((r) => r.state === 'recording').map((r) => r.id)]);

  $: canRecord = $perms.liveRecord && !$kidsMode;
  $: if ($featuresKnown && !$features.livetv) void goto('/', { replaceState: true });

  async function load(): Promise<void> {
    try {
      const r = await listRecordings('all', { conflicts: true });
      libraryExport = r.libraryExport === true;
      recs = r.recordings.filter((x) => !pending.has(x.id));
      rules = r.rules;
      failed = false;
    } catch { if (!recs) failed = true; }
  }

  // ---- delete with undo: the item goes at once, the DELETE after 5 s; Rückgängig puts it back and sends nothing ----
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; rec: Recording; toast: number }>();
  function remove(r: Recording): void {
    if (!recs) return;
    recs = recs.filter((x) => x.id !== r.id);
    const id = toast.info($t('live.mine.deleted'), { duration: DELETE_DELAY_MS, action: { label: tr('ui.undo'), run: () => undo(r.id) } });
    pending.set(r.id, { rec: r, toast: id, timer: setTimeout(() => void commit(r.id), DELETE_DELAY_MS) });
  }
  function undo(id: string): void {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    if (recs) recs = [...recs, p.rec];
  }
  async function commit(id: string, keepalive = false): Promise<void> {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    try { await deleteRecording(id, keepalive); } catch (e) {
      if (!keepalive) { toast.error(errorText(e)); if (recs) recs = [...recs, p.rec]; }
    }
  }
  const flush = () => { for (const id of [...pending.keys()]) void commit(id, true); };
  beforeNavigate(flush);

  async function write(r: Recording, run: () => Promise<Recording | null>, optimistic: Partial<Recording>): Promise<void> {
    if (!recs || busy.has(r.id)) return;
    const prev = r;
    recs = recs.map((x) => (x.id === r.id ? { ...x, ...optimistic } : x));
    busy = new Set(busy).add(r.id);
    try {
      const next = await run();
      if (next && recs) recs = recs.map((x) => (x.id === r.id ? next : x));
    } catch (e) {
      if (recs) recs = recs.map((x) => (x.id === r.id ? prev : x));
      toast.error(errorText(e));
    } finally { const b = new Set(busy); b.delete(r.id); busy = b; }
  }
  const keep = (r: Recording) => write(r, () => patchRecording(r.id, { keep: !r.keep }), { keep: !r.keep });
  const share = (r: Recording, visibility: Visibility) => write(r, () => patchRecording(r.id, { visibility }), { visibility });
  /**
   * *Jetzt beenden*: a running recording ends now and stays. The chip says *Fertig* at once (optimistic), the answer and a fresh list
   * follow; one that had recorded nothing is gone (the answer is null) and the toast says so.
   */
  async function stop(r: Recording): Promise<void> {
    await write(r, async () => {
      const next = await stopRecording(r.id);
      if (!next) {
        if (recs) recs = recs.filter((x) => x.id !== r.id);
        toast.success($t('live.rec.nothingRecorded'));
        return null;
      }
      toast.success($t('live.rec.stopped'));
      return next;
    }, { state: 'done', growing: false });
    void load();
  }
  async function cancel(r: Recording): Promise<void> {
    if (!recs) return;
    busy = new Set(busy).add(r.id);
    try {
      await deleteRecording(r.id);
      recs = recs.filter((x) => x.id !== r.id);
      toast.success($t('live.rec.cancelled'));
    } catch (e) { toast.error(errorText(e)); } finally { const b = new Set(busy); b.delete(r.id); busy = b; }
  }
  /** *Behalten → in Bibliothek* (spec §15.3 mode `both`): a copy goes into the Jellyfin library and the recording is kept */
  async function keepInLibrary(r: Recording): Promise<void> {
    await write(r, async () => { const next = await toLibrary(r.id); toast.success($t('live.mine.toLibraryDone')); return next; }, { keep: true });
  }
  const play = (r: Recording) => void goto(`/live/recordings/${encodeURIComponent(r.id)}`);

  // ---- rules ----
  async function ruleWrite(rule: Rule, patch: Parameters<typeof patchRule>[1]): Promise<void> {
    const prev = rule;
    rules = rules.map((x) => (x.id === rule.id ? { ...x, ...patch } as Rule : x));
    try { const next = await patchRule(rule.id, patch); rules = rules.map((x) => (x.id === rule.id ? next : x)); } catch (e) {
      rules = rules.map((x) => (x.id === rule.id ? prev : x));
      toast.error(errorText(e));
    }
  }
  async function ruleDelete(rule: Rule, el: HTMLElement): Promise<void> {
    if (!(await confirm({ title: tr('live.mine.ruleDeleteAsk'), body: tr('live.mine.ruleDeleteBody'), danger: true, confirmLabel: tr('live.mine.ruleDelete') }))) { el.focus(); return; }
    try {
      await deleteRule(rule.id);
      rules = rules.filter((x) => x.id !== rule.id);
      toast.success(tr('live.mine.ruleDeleted'));
      void load();
    } catch (e) { toast.error(errorText(e)); }
  }
  const chName = (id: string | null) => (id ? chans?.find((c) => c.id === id)?.name ?? recs?.find((r) => r.channel.id === id)?.channel.name ?? '' : '');
  const weekday = (d: number) => new Intl.DateTimeFormat(document.documentElement.lang || 'de', { weekday: 'short' }).format(new Date(2026, 10, 8 + d)).replace(/\.$/, '');
  const ruleLine = (r: Rule): string => (r.kind === 'time'
    ? `${chName(r.channelId)} · ${$t('live.mine.ruleTime', { days: (r.weekdays ?? []).map(weekday).join(', '), time: r.startTime ?? '', n: r.durationMin ?? 0 })}`
    : r.channelId ? chName(r.channelId) || $t('live.rec.thisChannel') : $t('live.rec.allChannels'));

  async function openTime(el: HTMLElement): Promise<void> {
    timeTrigger = el;
    if (!chans) {
      try { const r = await fetchChannels(); if (!r.notModified) chans = r.list.channels; } catch (e) { toast.error(errorText(e)); return; }
    }
    timeOpen = true;
  }

  onMount(() => {
    const html = document.documentElement;
    const sync = () => { tvMode = html.classList.contains('tv'); };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['class'] });
    void load();
    const every = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    window.addEventListener('pagehide', flush);
    return () => { mo.disconnect(); clearInterval(every); window.removeEventListener('pagehide', flush); };
  });
  onDestroy(flush);

  $: done = recs ? finished(recs) : [];
  $: groups = groupBySeries(done);
  $: plan = recs ? planned(recs) : [];
  $: ownRules = rules;
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('live.myRecordings') })}</title></svelte:head>

<div class="recs" class:tv={tvMode}>
  <div class="head">
    <h1>{$t('live.myRecordings')}</h1>
    {#if canRecord && !tvMode}
      <button type="button" class="newrec" on:click={(e) => void openTime(e.currentTarget)}><Icon name="plus" size={20} />{$t('live.mine.newRecording')}</button>
    {/if}
  </div>

  {#if tvMode}
    {#if failed}
      <p class="note" role="alert">{$t('live.mine.loadFailed')}</p>
    {:else if recs && !done.length}
      <p class="note">{$t('live.mine.emptyDone')}</p>
    {:else}
      <RecordingsRow recordings={recs ? done.filter((r) => r.state !== 'failed') : null} tv wrap autofocus canRecord />
    {/if}
  {:else}
    <div class="seg" role="group" aria-label={$t('live.mine.views')}>
      {#each VIEWS as s (s.v)}
        <button type="button" aria-pressed={view === s.v} on:click={() => (view = s.v)}>{$t(s.k)}</button>
      {/each}
    </div>

    {#if failed}
      <div class="panel failed" role="alert">
        <p>{$t('live.mine.loadFailed')}</p>
        <button type="button" class="sec" on:click={() => { failed = false; void load(); }}>{$t('live.player.retry')}</button>
      </div>
    {:else if recs === null}
      <ul class="list" aria-hidden="true">{#each Array(3) as _, k (k)}<li class="sk"></li>{/each}</ul>
    {:else if view === 'done'}
      {#if !groups.length}
        <p class="note">{$t('live.mine.emptyDone')}</p>
      {:else}
        {#each groups as g (g.kind === 'series' ? g.key : g.item.id)}
          {#if g.kind === 'series'}
            <section class="group" aria-labelledby="lmr-{g.key}">
              <h2 id="lmr-{g.key}">{g.title} <span class="cnt">{$t('live.mine.episodes', { n: g.items.length })}</span></h2>
              <ul class="list">
                {#each g.items as r (r.id)}
                  <RecordingItem rec={r} {canRecord} {libraryExport} reserveStop={seenRunning.has(r.id)} busy={busy.has(r.id)} on:play={(e) => play(e.detail)} on:keep={(e) => void keep(e.detail)} on:share={(e) => void share(e.detail.rec, e.detail.visibility)} on:delete={(e) => remove(e.detail)} on:library={(e) => void keepInLibrary(e.detail)} on:stop={(e) => void stop(e.detail)} />
                {/each}
              </ul>
            </section>
          {:else}
            <ul class="list single">
              <RecordingItem rec={g.item} {canRecord} {libraryExport} reserveStop={seenRunning.has(g.item.id)} busy={busy.has(g.item.id)} on:play={(e) => play(e.detail)} on:keep={(e) => void keep(e.detail)} on:share={(e) => void share(e.detail.rec, e.detail.visibility)} on:delete={(e) => remove(e.detail)} on:library={(e) => void keepInLibrary(e.detail)} on:stop={(e) => void stop(e.detail)} />
            </ul>
          {/if}
        {/each}
      {/if}
    {:else if view === 'planned'}
      {#if !plan.length}
        <p class="note">{$t('live.mine.emptyPlanned')}</p>
      {:else}
        <ul class="list">
          {#each plan as r (r.id)}
            <RecordingItem rec={r} kind="planned" busy={busy.has(r.id)} on:cancel={(e) => void cancel(e.detail)} />
          {/each}
        </ul>
      {/if}
    {:else}
      {#if !ownRules.length}
        <p class="note">{$t('live.mine.emptySeries')}</p>
      {:else}
        {#each ownRules as r (r.id)}
          <section class="rule" aria-labelledby="lmrule-{r.id}">
            <div class="rhead">
              <h2 id="lmrule-{r.id}">{r.title}</h2>
              <span class="kind">{r.kind === 'series' ? $t('live.mine.ruleSeries') : $t('live.mine.ruleByTime')}</span>
            </div>
            <p class="rline">{ruleLine(r)}</p>
            {#if !canRecord}
              <!-- without liveRecord the rules are read-only (every rule write needs it) -->
              <p class="rline">{r.kind === 'series' ? `${r.onlyNew ? `${$t('live.rec.onlyNew')} · ` : ''}${r.keepMax === null ? $t('live.rec.keepAll') : $t('live.rec.keepMax', { n: r.keepMax })}` : ''}</p>
            {:else}
            <div class="ropts">
              {#if r.kind === 'series'}
                <Toggle label={$t('live.rec.onlyNew')} checked={r.onlyNew} on:change={(e) => void ruleWrite(r, { onlyNew: e.detail })} />
                <div class="step">
                  <button type="button" class="sb" aria-label={$t('live.rec.keepLess')} disabled={r.keepMax === 1} on:click={() => void ruleWrite(r, { keepMax: stepKeep(r.keepMax, -1) })}><span aria-hidden="true">−</span></button>
                  <span class="sv">{r.keepMax === null ? $t('live.rec.keepAll') : $t('live.rec.keepMax', { n: r.keepMax })}</span>
                  <button type="button" class="sb" aria-label={$t('live.rec.keepMore')} disabled={r.keepMax === null} on:click={() => void ruleWrite(r, { keepMax: stepKeep(r.keepMax, 1) })}><span aria-hidden="true">+</span></button>
                </div>
              {/if}
              <Toggle label={$t('live.mine.ruleEnabled')} checked={r.enabled} on:change={(e) => void ruleWrite(r, { enabled: e.detail })} />
              <button type="button" class="ab del" on:click={(e) => void ruleDelete(r, e.currentTarget)}>{$t('live.mine.ruleDelete')}</button>
            </div>
            {/if}
          </section>
        {/each}
      {/if}
    {/if}
  {/if}
</div>

{#if timeOpen && chans}
  <TimeRecordSheet channels={chans} trigger={timeTrigger} on:close={() => (timeOpen = false)} on:saved={() => void load()} />
{/if}

<style>
  .recs { max-width: 1100px; margin: 0 auto; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; min-height: 44px; margin-bottom: 1rem; }
  h1 { margin: 0; }
  .newrec { gap: 8px; border-radius: 999px; }
  .seg { display: inline-grid; grid-auto-flow: column; gap: 4px; padding: 4px; margin-bottom: 1.2rem; border-radius: 999px; background: rgba(255, 255, 255, .07); max-width: 100%; }
  .seg button, .seg button:hover:not(:disabled), .seg button:active:not(:disabled) { min-height: 44px; padding: 0 1.1rem; border-radius: 999px; background: transparent; color: #fff; transform: none; }
  .seg button[aria-pressed='true'] { background: var(--fr-sel); font-weight: 700; }
  .list { display: grid; gap: 10px; margin: 0 0 12px; padding: 0; list-style: none; }
  .sk { height: 98px; border-radius: var(--fr-r-card); background: rgba(255, 255, 255, .06); list-style: none; }
  .group { margin: 0 0 1.4rem; }
  .group h2, .rule h2 { margin: 0 0 .6rem; font-size: 1.15rem; }
  .cnt { margin-left: .4rem; font-size: .9rem; font-weight: 400; color: rgba(255, 255, 255, .72); }
  .note { min-height: 44px; color: rgba(255, 255, 255, .78); }
  .failed { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 72px; }
  .failed p { margin: 0; }
  .rule { padding: 14px 16px; margin: 0 0 12px; border-radius: var(--fr-r-card); background: rgba(255, 255, 255, .05); }
  .rhead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .rhead h2 { margin: 0; }
  .kind { font-size: .85rem; color: rgba(255, 255, 255, .72); }
  .rline { margin: 4px 0 10px; color: rgba(255, 255, 255, .78); }
  .ropts { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 22px; }
  .step { display: flex; align-items: center; gap: 8px; }
  .sb, .sb:hover:not(:disabled), .sb:active:not(:disabled) { width: 44px; height: 44px; padding: 0; border-radius: 50%; background: rgba(255, 255, 255, .1); color: #fff; font-size: 1.3rem; transform: none; }
  .sv { min-width: 10em; text-align: center; font-variant-numeric: tabular-nums; }
  .ab, .ab:hover:not(:disabled), .ab:active:not(:disabled) { min-height: 44px; padding: 0 14px; border-radius: 999px; background: rgba(255, 255, 255, .1); color: #fff; transform: none; }
  .del { color: #ffa8a8; }
  .tv { --u: calc(100vw / 1920); max-width: none; }
  .tv h1 { font-size: calc(var(--u) * 44); padding-left: calc(var(--u) * 28); }
  .tv .note { font-size: calc(var(--u) * 28); padding-left: calc(var(--u) * 28); }
  @media (max-width: 720px) {
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); width: 100%; box-sizing: border-box; }
    .seg button { padding: 0 .4rem; }
    .sv { min-width: 0; flex: 1 1 auto; }
  }
</style>
