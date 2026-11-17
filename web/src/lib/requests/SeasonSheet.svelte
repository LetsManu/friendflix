<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Season picker of a series (opened with pickSeasons() from lib/requests/picker.ts, rendered by RequestSheetHost). Every season
   * with its state from the request service: available, partly available, in progress, requested or declined; only the open ones
   * (not asked for, or declined) can be chosen. "Alle Staffeln" switches the open regular seasons; the specials (season 0) start off.
   * The wish counts as one of the month's wishes however many seasons it holds; the server asks only for the seasons still open,
   * so a partly requested series gets just the missing ones. A failure keeps the sheet open (the reserved error line says so,
   * submit tries again); requested / already asked / quota used up close it with that result.
   * Glass dialog (ModalShell): rises 10 px and fades, text never scales; skeleton rows of the final height while loading; Tab stays
   * inside, Escape (and Back on TV) closes, the d-pad walks the rows.
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
  import { allState, closeSheet, defaultSeasons, seasonOpen, toggleAll, type Season, type SeasonState } from './picker';
  import { loadQuota, quota, submitWish } from './wish';

  export let tmdbId: number;
  export let title: string;

  const id = uid('sea');
  let shell: ModalShell, box: HTMLElement | undefined;
  let phase: 'loading' | 'error' | 'ready' = 'loading', seasons: Season[] = [], chosen = new Set<number>(), busy = false, error = '';

  // regular seasons in order, the specials last
  $: ordered = [...seasons.filter((s) => s.number > 0), ...seasons.filter((s) => s.number === 0)];
  $: openCount = seasons.filter(seasonOpen).length;
  $: all = allState(seasons, chosen);
  $: regularOpen = seasons.some((s) => s.number > 0 && seasonOpen(s));
  $: left = quotaLeft($quota);
  $: exhausted = quotaExhausted($quota);

  const TONE: Record<SeasonState, Tone> = { available: 'ok', partial: 'info', processing: 'info', requested: 'warn', declined: 'muted', none: 'muted' };
  const ICON: Record<SeasonState, string> = { available: 'check', partial: 'download', processing: 'download', requested: 'clock', declined: 'x', none: 'info' };
  const name = (s: Season) => (s.number === 0 ? $t('home.wish.seasons.specials') : $t('home.wish.seasons.season', { n: s.number }));
  const meta = (s: Season) => [s.episodes ? $t('home.wish.seasons.episodes', { n: s.episodes }) : '', s.airDate?.slice(0, 4) ?? ''].filter(Boolean).join(' · ');
  // the state of a season that cannot be chosen; a declined one can be asked for again but says why it is not chosen yet
  const pill = (s: Season) => (s.state === 'none' ? null : { tone: TONE[s.state], icon: ICON[s.state], label: $t(`home.wish.seasons.state.${s.state}` as TKey) });

  async function load() {
    phase = 'loading'; error = '';
    try {
      const r = await api<{ seasons: Season[] }>(`/api/seerr/tv/${tmdbId}/seasons`);
      seasons = Array.isArray(r.seasons) ? r.seasons : [];
      chosen = defaultSeasons(seasons);
      phase = 'ready';
      // the focus moves from Abbrechen (the only control while loading) to the first row
      await tick();
      if (!box || !box.contains(document.activeElement) || (document.activeElement as HTMLElement | null)?.matches('.cancel')) box?.querySelector<HTMLElement>('input:not(:disabled)')?.focus({ preventScroll: true });
    } catch { phase = 'error'; }
  }
  onMount(() => { void load(); if (!$quota) void loadQuota(); });

  function toggle(n: number) {
    const next = new Set(chosen);
    if (next.has(n)) next.delete(n); else next.add(n);
    chosen = next; error = '';
  }
  async function submit() {
    if (busy || phase !== 'ready' || !chosen.size || exhausted) return;
    busy = true; error = '';
    const r = await submitWish('tv', tmdbId, [...chosen].sort((a, b) => a - b));
    busy = false;
    if (r.kind === 'failed' && !r.disabled) { error = $t('home.wish.seasons.failed'); return; }
    closeSheet(r);
  }
  const cancel = () => { if (!busy) closeSheet(null); };
  const tvMode = () => document.documentElement.classList.contains('tv');
  /** Back on a TV remote closes the sheet; every other key inside it (Space on a row, arrows) stays in it: the page or the player
   *  under it never acts on them. Tab and Escape go on to the dialog frame (focus trap, close); the d-pad already moved in capture. */
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Tab' || e.key === 'Escape') return;
    if (tvMode() && isBackKey(e)) { e.preventDefault(); e.stopPropagation(); shell?.dismiss(); return; }
    e.stopPropagation();
  }
</script>

<ModalShell bind:this={shell} bind:box labelledby="{id}-t" describedby="{id}-b" focus=".cancel" locked={busy} width={480} layer={120} on:close={cancel}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Back on a TV remote; the controls inside handle everything else) -->
  <form on:submit|preventDefault={submit} on:keydown={onKey} data-scope data-testid="season-sheet">
    <h2 id="{id}-t" class="dlg-title">{$t('home.wish.seasons.title')}</h2>
    <p id="{id}-b" class="sub">{title}</p>
    <div class="dlg-main">
      {#if phase === 'loading'}
        <span class="sr-only" role="status">{$t('home.wish.seasons.loading')}</span>
        {#each [0, 1, 2, 3] as i (i)}<div class="sk"><Skeleton w="22px" h="22px" radius="6px" /><Skeleton w={i % 2 ? '40%' : '55%'} h="14px" /></div>{/each}
      {:else if phase === 'error'}
        <p class="dlg-body" role="alert">{$t('home.wish.seasons.loadFailed')}</p>
        <div class="again"><Button variant="glass" on:click={load}>{$t('home.wish.seasons.reload')}</Button></div>
      {:else}
        {#if !openCount}<p class="dlg-body">{$t('home.wish.seasons.nothingOpen')}</p>{/if}
        {#if regularOpen}
          <PickRow head label={$t('home.wish.seasons.all')} checked={all === 'all'} mixed={all === 'some'} disabled={busy}
            on:change={() => { chosen = toggleAll(seasons, chosen, all !== 'all'); error = ''; }} />
        {/if}
        <ul class="list" aria-label={$t('home.wish.seasons.title')}>
          {#each ordered as s (s.number)}
            <li><PickRow label={name(s)} meta={meta(s)} pill={pill(s)} selectable={seasonOpen(s)} checked={chosen.has(s.number)} disabled={busy} on:change={() => toggle(s.number)} /></li>
          {/each}
        </ul>
      {/if}
    </div>
    <p class="note">{#if exhausted && $quota}{$t('home.wish.exhausted')}. {$t('home.wish.resetsAt', { date: fmtDate($quota.resetsAt, { day: 'numeric', month: 'long' }) })}{:else}{$t('home.wish.seasons.oneWish')}{#if left !== null}{' '}{$t('home.wish.seasons.left', { n: left })}{/if}{/if}</p>
    <!-- the reserved line: a refusal or "choose one" never moves the buttons -->
    <p class="dlg-err" role="alert">{error || (phase === 'ready' && openCount && !chosen.size ? $t('home.wish.seasons.pickOne') : '')}</p>
    <div class="dlg-acts">
      <Button variant="glass" class="cancel" disabled={busy} on:click={() => shell.dismiss()}>{openCount || phase !== 'ready' ? $t('common.cancel') : $t('common.close')}</Button>
      {#if phase !== 'ready' || openCount}
        <Button type="submit" pending={busy} disabled={phase !== 'ready' || !chosen.size || exhausted}>{$t('home.wish.seasons.submit', { n: chosen.size })}</Button>
      {/if}
    </div>
  </form>
</ModalShell>

<style>
  .sub { margin: -4px 0 12px; color: var(--mut); font-size: 15px; overflow-wrap: anywhere; }
  .list { list-style: none; margin: 0; padding: 0; }
  .sk { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 6px 10px; }
  .again { margin-top: 12px; }
  .note { margin: 12px 0 0; font-size: 13px; color: var(--mut); min-height: 1.4em; }
</style>
