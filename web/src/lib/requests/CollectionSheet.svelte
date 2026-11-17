<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Ganze Reihe anfragen" (opened with requestCollection() from lib/requests/picker.ts, rendered by RequestSheetHost): the parts of
   * the movie's TMDB collection with poster, year and state (in the library, in progress, requested, declined, requestable, not
   * released yet). Every part nobody asked for starts checked (a declined one only on purpose); "Alle" switches all requestable ones.
   * Sending makes one movie wish per checked part (POST /api/requests/batch: same rules as a single wish, one after the other).
   * Each row then shows its own result, the summary line says what went through, what the quota stopped and what failed; failed
   * parts stay checked for another try. Nothing is hidden and nothing closes by itself after a send.
   * Glass dialog (ModalShell): text never scales, skeleton rows of the final height while loading, Tab stays inside, Escape (and
   * Back on TV) closes, the d-pad walks the rows.
   */
  import { onMount, tick } from 'svelte';
  import { api } from '#lib/api';
  import { fmtDate, t, type TKey } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { uid } from '#lib/ui/ids';
  import type { Tone } from '#lib/ui/StatusPill.svelte';
  import { isBackKey } from '#lib/spatial';
  import { quotaExhausted, quotaLeft } from '#lib/newpage';
  import PickRow from './PickRow.svelte';
  import { batchSummary, choosable, closeSheet, defaultParts, toggleParts, type Collection, type Part, type PartState } from './picker';
  import { loadQuota, quota, submitBatch, type PartResult } from './wish';

  export let tmdbId: number;
  /** parts the library has although the request service may not know it (the detail page's collection row) */
  export let owned: number[] = [];

  const id = uid('col');
  let shell: ModalShell, box: HTMLElement | undefined;
  let phase: 'loading' | 'error' | 'none' | 'ready' = 'loading', col: Collection | null = null, parts: Part[] = [];
  let chosen = new Set<number>(), busy = false, error = '', results = new Map<number, PartResult['result']>(), resetsAt = '';
  /** tmdb ids that are asked for now (answered to the caller on close) */
  const asked = new Set<number>();

  $: open = parts.filter((p) => choosable(p, results));
  $: allOn = open.length > 0 && open.every((p) => chosen.has(p.tmdbId));
  $: someOn = open.some((p) => chosen.has(p.tmdbId));
  $: left = quotaLeft($quota);
  $: exhausted = quotaExhausted($quota);
  $: sum = results.size ? batchSummary([...results].map(([k, result]) => ({ tmdbId: k, result }))) : null;

  const TONE: Record<PartState, Tone> = { available: 'ok', processing: 'info', requested: 'warn', declined: 'muted', none: 'muted', unreleased: 'muted' };
  const ICON: Record<PartState, string> = { available: 'check', processing: 'download', requested: 'clock', declined: 'x', none: 'plus', unreleased: 'clock' };
  const RTONE: Record<PartResult['result'], Tone> = { requested: 'ok', exists: 'info', limit: 'warn', failed: 'err', skipped: 'warn' };
  const RICON: Record<PartResult['result'], string> = { requested: 'check', exists: 'check', limit: 'clock', failed: 'alert', skipped: 'alert' };
  function pill(p: Part, res: Map<number, PartResult['result']>) {
    const r = res.get(p.tmdbId);
    if (r) return { tone: RTONE[r], icon: RICON[r], label: $t(`home.wish.collection.result.${r}` as TKey) };
    return { tone: TONE[p.state], icon: ICON[p.state], label: $t(`home.wish.collection.state.${p.state}` as TKey) };
  }

  async function load() {
    phase = 'loading';
    try {
      const r = await api<{ collection: Collection | null }>(`/api/seerr/movie/${tmdbId}/collection`);
      col = r.collection;
      if (!col) { phase = 'none'; return; }
      const mine = new Set(owned);
      parts = col.parts.map((p) => (mine.has(p.tmdbId) && p.state !== 'available' ? { ...p, state: 'available' } : p));
      chosen = defaultParts(parts);
      phase = 'ready';
      await tick();
      if (!box || !box.contains(document.activeElement) || (document.activeElement as HTMLElement | null)?.matches('.cancel')) box?.querySelector<HTMLElement>('input:not(:disabled)')?.focus({ preventScroll: true });
    } catch { phase = 'error'; }
  }
  onMount(() => { void load(); if (!$quota) void loadQuota(); });

  function toggle(n: number) {
    const next = new Set(chosen);
    if (next.has(n)) next.delete(n); else next.add(n);
    chosen = next;
  }
  function toggleAllParts() {
    chosen = toggleParts(open, !allOn);
  }
  async function submit() {
    if (busy || phase !== 'ready') return;
    if (!chosen.size) { if (results.size) closeSheet({ requested: [...asked] }); return; }
    if (exhausted) return; // the quota is used up: the note says until when
    // in the order of the list (release order): the quota stops it after the first ones
    const ids = parts.filter((p) => chosen.has(p.tmdbId)).map((p) => p.tmdbId);
    busy = true; error = '';
    const r = await submitBatch(ids, col?.id);
    busy = false;
    if (r.kind === 'failed') { error = r.disabled ? $t('home.wish.disabled') : $t('home.wish.collection.failed'); return; }
    const next = new Map(results);
    for (const x of r.results) {
      next.set(x.tmdbId, x.result);
      if (x.result === 'requested' || x.result === 'exists') asked.add(x.tmdbId);
    }
    results = next; resetsAt = r.resetsAt;
    // failed and not reached (skipped) parts stay checked: another try is one press away; everything else is done
    chosen = new Set(r.results.filter((x) => x.result === 'failed' || x.result === 'skipped').map((x) => x.tmdbId));
  }
  const cancel = () => { if (!busy) closeSheet(asked.size ? { requested: [...asked] } : null); };
  const tvMode = () => document.documentElement.classList.contains('tv');
  /** Back on a TV remote closes the sheet; every other key inside it (Space on a row, arrows) stays in it: the page or the player
   *  under it never acts on them. Tab and Escape go on to the dialog frame (focus trap, close); the d-pad already moved in capture. */
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Tab' || e.key === 'Escape') return;
    if (tvMode() && isBackKey(e)) { e.preventDefault(); e.stopPropagation(); shell?.dismiss(); return; }
    e.stopPropagation();
  }
  $: summary = !sum ? '' : [
    $t('home.wish.collection.summary', { ok: sum.requested + sum.exists, n: sum.total }),
    sum.limit ? $t('home.wish.collection.stopped', { n: sum.limit, date: resetsAt ? fmtDate(resetsAt, { day: 'numeric', month: 'long' }) : '' }) : '',
    sum.failed ? $t('home.wish.collection.failedSome', { n: sum.failed }) : '',
    sum.skipped ? $t('home.wish.collection.skippedSome', { n: sum.skipped }) : '',
  ].filter(Boolean).join(' ');
  $: over = left !== null && left > 0 && chosen.size > left && !results.size;
  $: primary = results.size && !chosen.size ? $t('home.wish.collection.done') : results.size ? $t('home.wish.retry') : $t('home.wish.collection.submit', { n: chosen.size });
</script>

<ModalShell bind:this={shell} bind:box labelledby="{id}-t" describedby="{id}-b" focus=".cancel" locked={busy} width={560} layer={120} on:close={cancel}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Back on a TV remote; the controls inside handle everything else) -->
  <form on:submit|preventDefault={submit} on:keydown={onKey} data-scope data-testid="collection-sheet">
    <h2 id="{id}-t" class="dlg-title">{$t('home.wish.collection.title')}</h2>
    <p id="{id}-b" class="sub">{col?.name ?? ''}</p>
    <div class="dlg-main">
      {#if phase === 'loading'}
        <span class="sr-only" role="status">{$t('home.wish.collection.loading')}</span>
        {#each [0, 1, 2, 3] as i (i)}<div class="sk"><Skeleton w="22px" h="22px" radius="6px" /><Skeleton w="40px" h="60px" radius="6px" /><Skeleton w={i % 2 ? '45%' : '60%'} h="14px" /></div>{/each}
      {:else if phase === 'error'}
        <p class="dlg-body" role="alert">{$t('home.wish.collection.loadFailed')}</p>
        <div class="again"><Button variant="glass" on:click={load}>{$t('home.wish.seasons.reload')}</Button></div>
      {:else if phase === 'none'}
        <p class="dlg-body">{$t('home.wish.collection.none')}</p>
      {:else}
        {#if !open.length && !results.size}<p class="dlg-body">{$t('home.wish.collection.nothingOpen')}</p>{/if}
        {#if open.length}
          <PickRow head label={$t('home.wish.collection.all')} checked={allOn} mixed={someOn && !allOn} disabled={busy} on:change={toggleAllParts} />
        {/if}
        <ul class="list" aria-label={col?.name ?? $t('home.wish.collection.title')}>
          {#each parts as p (p.tmdbId)}
            <li><PickRow posterCol poster={p.poster} label={p.title} meta={p.year ?? ''} pill={pill(p, results)} selectable={choosable(p, results)} checked={chosen.has(p.tmdbId)} disabled={busy} on:change={() => toggle(p.tmdbId)} /></li>
          {/each}
        </ul>
      {/if}
    </div>
    <p class="note">{#if exhausted && $quota && phase === 'ready' && open.length}{$t('home.wish.exhausted')}. {$t('home.wish.resetsAt', { date: fmtDate($quota.resetsAt, { day: 'numeric', month: 'long' }) })}{:else if over}{$t('home.wish.collection.tooMany', { n: left ?? 0 })}{:else if phase === 'ready' && !results.size && open.length}{$t('home.wish.collection.eachWish')}{#if left !== null}{' '}{$t('home.wish.seasons.left', { n: left })}{/if}{/if}</p>
    <!-- the reserved line: the per-send summary (polite) or a refusal; the buttons never move -->
    <p class="dlg-err" class:ok={!error && sum && !sum.failed && !sum.limit && !sum.skipped} role="status" aria-live="polite">{error || summary}</p>
    <div class="dlg-acts">
      <Button variant="glass" class="cancel" disabled={busy} on:click={() => shell.dismiss()}>{results.size || phase === 'none' || (phase === 'ready' && !open.length) ? $t('common.close') : $t('common.cancel')}</Button>
      {#if phase === 'loading' || phase === 'error' || (phase === 'ready' && (open.length || results.size))}
        <Button type="submit" pending={busy} disabled={phase !== 'ready' || (!chosen.size && !results.size) || (chosen.size > 0 && exhausted)}>{primary}</Button>
      {/if}
    </div>
  </form>
</ModalShell>

<style>
  .sub { margin: -4px 0 12px; color: var(--mut); font-size: 15px; overflow-wrap: anywhere; min-height: 1.5em; }
  .list { list-style: none; margin: 0; padding: 0; }
  .sk { display: flex; align-items: center; gap: 12px; min-height: 72px; padding: 6px 10px; }
  .again { margin-top: 12px; }
  .note { margin: 12px 0 0; font-size: 13px; color: var(--mut); min-height: 1.4em; }
  .dlg-err.ok { color: var(--ok); }
</style>
