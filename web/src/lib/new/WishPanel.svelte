<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The "Wünsche & demnächst" tab: a search field for titles to wish for (results carry the Wünschen button), the quota, the
   * account's own requests with their state and the announced titles with the reminder button. Grown-up profiles with a request
   * service only (the page decides).
   */
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDate, hasKey, t, trDynamic } from '#lib/i18n';
  import { matchesFilter, quotaExhausted, quotaLeft, wishStateOf, type NewFilter, type Up } from '#lib/newpage';
  import UpcomingList from '#lib/new/UpcomingList.svelte';
  import RequestButton from '#lib/requests/RequestButton.svelte';
  import { loadMine, mine, quota } from '#lib/requests/wish';
  import { mobile } from '#lib/viewport';

  export let upcoming: Up[];
  /** the page's Alles / Serien / Filme filter: it narrows the own wishes and the search results as well */
  export let filter: NewFilter = 'all';
  /** the header button led here: the search field takes the focus when the panel appears */
  export let autofocus = false;

  interface Hit { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year?: number | null; poster?: string | null; status: string }
  let q = '', hits: Hit[] | null = null, busy = false, searchErr = false, searched = '';
  let input: HTMLInputElement;
  let failed = false;

  /** the header button of the page leads here: the search field takes the focus */
  export function focusSearch() { input?.focus(); input?.scrollIntoView({ block: 'center' }); }

  async function search() {
    const term = q.trim();
    if (term.length < 2 || busy) return;
    busy = true; searchErr = false;
    try { hits = (await api(`/api/seerr/search?q=${encodeURIComponent(term)}`)).results; searched = term; } catch { searchErr = true; }
    busy = false;
  }
  async function reload() { failed = !(await loadMine()); }
  onMount(() => { if (!$mine) void reload(); if (autofocus) focusSearch(); });

  const label = (s: string): string => (hasKey(`social.requests.status.${s}`) ? trDynamic(`social.requests.status.${s}`) : s);
  const cls: Record<string, string> = { verfuegbar: 'ok', in_arbeit: '', angefragt: 'warn', teilweise: '', abgelehnt: 'err' };
  const kind = (m: string) => (m === 'tv' ? $t('home.new.kind.series') : $t('home.new.kind.movie'));
  const OPEN = new Set(['angefragt', 'in_arbeit', 'teilweise']);
  /** open requests first, then the rest, newest first in each group; the page shows the first few */
  $: list = [...($mine ?? [])].filter((m) => matchesFilter(filter, m.mediaType)).sort((a, b) => Number(OPEN.has(b.status)) - Number(OPEN.has(a.status)) || b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  $: left = quotaLeft($quota);
  $: shownHits = (hits ?? []).filter((h) => matchesFilter(filter, h.mediaType));
</script>

<div class="wp">
  <form class="find frost frost-pill frost-safe" role="search" aria-label={$t('home.new.searchLabel')} on:submit|preventDefault={search}>
    <Icon name="search" size={18} />
    <input type="search" bind:this={input} bind:value={q} placeholder={$t($mobile ? 'home.new.searchPlaceholderShort' : 'home.new.searchPlaceholder')} maxlength="100" aria-label={$t('home.new.searchLabel')} autocomplete="off" />
    <button type="submit" class="go" disabled={busy || q.trim().length < 2}>{$t('home.new.searchGo')}</button>
  </form>
  <p class="quota" class:full={quotaExhausted($quota)}>
    {#if $quota && $quota.limit !== null && left !== null}
      {#if left === 0}{$t('home.wish.exhausted')} · {$t('home.wish.resetsAt', { date: fmtDate($quota.resetsAt, { day: 'numeric', month: 'long' }) })}{:else}{$t('home.new.quotaLeft', { left, limit: $quota.limit })}{/if}
    {/if}
  </p>

  <div role="status">{#if searchErr}<p class="msg err">{$t('home.new.searchFailed')}</p>{:else if hits && !shownHits.length}<p class="msg">{$t('home.new.searchNone')}</p>{/if}</div>
  {#if shownHits.length}
    <section aria-label={$t('home.new.searchResults')}>
      <h2>{$t('home.new.searchResults')}<span class="term">„{searched}“</span></h2>
      <ul class="rows">
        {#each shownHits as h (h.mediaType + h.tmdbId)}
          <li>
            <div class="pst">{#if h.poster}<img src={h.poster} alt="" loading="lazy" decoding="async" />{/if}</div>
            <div class="tx"><b>{h.title}</b><span>{[kind(h.mediaType), h.year].filter(Boolean).join(' · ')}</span></div>
            <div class="rb"><RequestButton mediaType={h.mediaType} tmdbId={h.tmdbId} title={h.title} state={wishStateOf(h.status)} /></div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section aria-labelledby="np-mine">
    <div class="hd"><h2 id="np-mine">{$t('home.new.yourWishes')}</h2><a class="all" href="/requests">{$t('social.requests.title')}</a></div>
    {#if failed}
      <p class="msg err" role="alert">{$t('home.new.wishesFailed')} <button type="button" class="sec" on:click={reload}>{$t('social.tryAgain')}</button></p>
    {:else if $mine === null}
      <div class="skeleton sk" aria-hidden="true"></div>
    {:else if !list.length}
      <p class="msg">{$t('home.new.noWishes')}</p>
    {:else}
      <ul class="mine">
        {#each list as m (m.mediaType + m.title + m.createdAt)}
          <li><div class="tx"><b>{m.title}</b><span>{kind(m.mediaType)}</span></div><span class="pill-s {cls[m.status] ?? ''}">{label(m.status)}</span></li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if upcoming.length}<UpcomingList items={upcoming} />{/if}
</div>

<style>
  .wp { max-width: 56rem; display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.2rem; min-width: 0; }
  .find { display: flex; align-items: center; gap: .6rem; padding: 4px 4px 4px 18px; max-width: 100%; box-sizing: border-box; }
  .find:focus-within { outline: 2px solid #fff; outline-offset: 2px; }
  .find input { flex: 1 1 auto; min-width: 0; min-height: 44px; background: transparent; border: 0; outline: 0; color: #fff; font-size: 1rem; padding: 0; }
  .find input::placeholder { color: rgba(255, 255, 255, .78); }
  .go { min-height: 44px; border-radius: 999px; padding: 0 1.3rem; }
  .quota { margin: -.4rem 0 0; min-height: 1.3em; font-size: .9rem; color: var(--mut); }
  .quota.full { color: var(--warn, #f7b344); }
  h2 { margin: 0 0 .6rem; font-size: 1.05rem; font-weight: 800; }
  .term { margin-left: .5rem; font-weight: 500; color: var(--mut); }
  .hd { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .all { color: var(--acc-text); font-size: .9rem; font-weight: 600; min-height: 44px; display: inline-flex; align-items: center; }
  ul { list-style: none; margin: 0; padding: 0; }
  .rows { display: grid; gap: .6rem; }
  .rows li { display: grid; grid-template-columns: 3rem minmax(0, 1fr) auto; align-items: center; gap: .9rem; padding: .6rem .8rem; border-radius: 16px; background: rgba(var(--fr-scrim-rgb), .5); box-shadow: inset 0 0 0 1px var(--fr-line); }
  .pst { width: 3rem; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; background: #1c2228; }
  .pst img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tx { display: flex; flex-direction: column; min-width: 0; }
  .tx b { font-size: 1rem; overflow-wrap: anywhere; }
  .tx span { font-size: .85rem; color: var(--mut); }
  .mine { display: grid; }
  .mine li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 56px; border-bottom: 1px solid var(--fr-line); }
  .pill-s { flex: none; padding: 4px 12px; border-radius: 999px; font-size: .8rem; font-weight: 700; box-shadow: inset 0 0 0 1px currentColor; }
  .pill-s.warn { color: var(--warn, #f7b344); }
  .pill-s { color: rgba(255, 255, 255, .86); }
  .pill-s.ok { color: var(--ok, #4ade80); }
  .pill-s.err { color: var(--err, #ffa8a8); }
  .msg { margin: 0; font-size: .92rem; color: var(--mut); }
  .msg.err { color: var(--err, #ffa8a8); }
  .sk { height: 112px; border-radius: 16px; }
  @media (max-width: 720px) {
    .rows li { grid-template-columns: 2.6rem minmax(0, 1fr); }
    .rows .rb { grid-column: 1 / -1; }
    .pst { width: 2.6rem; }
    .rows .rb :global(.rb) { align-items: stretch; }
  }
</style>
