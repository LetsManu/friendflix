<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Noch nicht bei uns": suggestions for titles that are not in the library, each with one line of reason (the release date, else
   * "similar to a title you know") and the Wünschen button. Cards on the desktop, list cards on the phone. The block always has the
   * same box: `slots` skeleton cards while the suggestions load, and a filler ("Etwas fehlt?") for the slots that stay empty, so
   * neither the answer nor a short list moves what sits below. Only for grown-up profiles with a request service (the page decides).
   */
  import { createEventDispatcher } from 'svelte';
  import { fmtDate, t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import type { Suggestion } from '#lib/newpage';
  import RequestButton from '#lib/requests/RequestButton.svelte';

  /** null while the suggestions load */
  export let items: Suggestion[] | null;
  export let slots = 4;
  export let title: string;
  export let sub = '';
  const dispatch = createEventDispatcher<{ wish: void }>();

  const kind = (s: Suggestion) => (s.mediaType === 'tv' ? $t('home.new.kind.series') : $t('home.new.kind.movie'));
  const meta = (s: Suggestion) => [kind(s), s.year].filter(Boolean).join(' · ');
</script>

<section class="ms" aria-labelledby="np-ms">
  <div class="hd"><h2 id="np-ms">{title}</h2>{#if sub}<span class="sub">{sub}</span>{/if}</div>
  {#if items === null}
    <ul role="status" aria-busy="true">
      <li class="sr-only">{$t('common.loading')}</li>
      {#each Array(slots) as _}<li class="c skc skeleton" aria-hidden="true"></li>{/each}
    </ul>
  {:else}
    <ul>
      {#each items as s (s.mediaType + s.tmdbId)}
        <li class="c">
          <div class="art" aria-hidden="true">{#if s.poster}<img src={s.poster} alt="" loading="lazy" decoding="async" />{/if}</div>
          <span class="tag">{$t('home.new.notInLibrary')}</span>
          <div class="tx">
            <div class="ln"><b class="nm" title={s.title}>{s.title}</b><span class="mt">{meta(s)}</span></div>
            {#if s.releaseDate}<span class="sub1 rel">{$t('home.new.releasesOn', { date: fmtDate(s.releaseDate, { day: 'numeric', month: 'long' }) })}</span>
            {:else}<span class="sub1 why">{$t('home.new.similarTo', { seed: s.reason.seed })}</span>{/if}
            <div class="act"><RequestButton block mediaType={s.mediaType} tmdbId={s.tmdbId} title={s.title} state={s.request.state} /></div>
          </div>
        </li>
      {/each}
      {#if items.length < slots}
        <li class="c fill" class:one={slots - items.length === 1} style="--n:{slots - items.length}">
          <button type="button" class="fillbtn" on:click={() => dispatch('wish')}><Icon name="plus" size={20} /><b>{$t('home.new.barTitle')}</b><span>{$t('home.new.barSub')}</span></button>
        </li>
      {/if}
    </ul>
  {/if}
</section>

<style>
  .ms { min-width: 0; }
  .hd { display: flex; align-items: baseline; justify-content: space-between; gap: .8rem; margin: 0 0 .7rem; }
  h2 { margin: 0; font-size: 1.3rem; font-weight: 800; letter-spacing: -.01em; line-height: 1.25; }
  .sub { color: var(--acc-text); font-size: .85rem; font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
  .c { position: relative; display: flex; flex-direction: column; height: 250px; border-radius: 20px; overflow: hidden; isolation: isolate; border: 1px dashed rgba(255, 255, 255, .4); background: linear-gradient(135deg, #2c2540, #14111c); }
  .art { position: absolute; inset: 0; z-index: -2; }
  .art img { width: 100%; height: 100%; object-fit: cover; object-position: center 25%; display: block; }
  .c::before { content: ''; position: absolute; inset: 0; z-index: -1; background: linear-gradient(180deg, rgba(10, 9, 13, .1) 0%, rgba(10, 9, 13, .94) 62%); }
  .tag { position: absolute; top: 12px; left: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(12, 11, 16, .82); color: #fff; font-size: .75rem; font-weight: 700; }
  .tx { margin-top: auto; padding: 14px 16px 16px; display: flex; flex-direction: column; gap: .25rem; }
  .ln { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; }
  .nm { font-size: 1.05rem; font-weight: 800; line-height: 1.2; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mt { flex: none; font-size: .8rem; color: rgba(255, 255, 255, .8); }
  .sub1 { font-size: .85rem; font-weight: 600; color: var(--acc-text); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* the 44 px button plus the "Neues Kontingent ab ..." line (or the error line) are reserved on every card: the titles share one baseline */
  .act { margin-top: .55rem; height: 4.3rem; }
  .c:not(.skc) { animation: ms-in .18s ease-out backwards; }
  @keyframes ms-in { from { opacity: 0; } }
  .c.skc { border: 0; background: #1b2127; }
  .skc::before { display: none; }
  .fill { grid-column: span var(--n); background: rgba(255, 255, 255, .04); }
  .fill::before { display: none; }
  .fillbtn { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .3rem; padding: 1rem; color: #fff; text-align: center; font: inherit; border-radius: inherit; }
  .fillbtn b { font-size: 1.05rem; font-weight: 800; }
  .fillbtn span { font-size: .85rem; color: rgba(255, 255, 255, .8); }
  .fillbtn :global(svg) { color: var(--acc-text); }
  .fillbtn:focus-visible { outline: 2px solid #fff; outline-offset: -4px; box-shadow: inset 0 0 0 6px var(--ring-dark); }
  @media (prefers-reduced-motion: reduce) { .c { animation: none; } }
  @media (max-width: 1100px) { ul { grid-template-columns: repeat(2, minmax(0, 1fr)); } .fill { grid-column: span 2; } .fill.one { grid-column: auto; } }
  /* phone: list cards, the poster at the left (the board's NewSleekPhone) */
  @media (max-width: 720px) {
    .hd { flex-direction: column; align-items: flex-start; gap: .15rem; }
    .sub { color: var(--mut); font-weight: 400; }
    ul { --ch: 176px; grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .c { display: grid; grid-template-columns: 96px minmax(0, 1fr); column-gap: 14px; height: var(--ch); border: 0; background: none; overflow: visible; }
    .c::before { display: none; }
    .art { position: relative; inset: auto; z-index: 0; grid-row: 1 / span 2; align-self: start; aspect-ratio: 2 / 3; border-radius: 12px; overflow: hidden; border: 1px dashed rgba(255, 255, 255, .45); background: linear-gradient(135deg, #3a2d57, #15111f); }
    .tag { position: static; grid-column: 2; justify-self: start; border: 1px solid rgba(255, 255, 255, .3); }
    .tx { grid-column: 2; margin: 0; padding: 0; min-width: 0; }
    .act { height: auto; margin-top: .4rem; }
    .c.skc { display: block; overflow: hidden; border-radius: 12px; }
    .fill { display: flex; height: calc(var(--n) * var(--ch) + (var(--n) - 1) * 14px); grid-column: 1 / -1; border: 1px dashed rgba(255, 255, 255, .4); border-radius: 18px; }
    .fill.one { grid-column: 1 / -1; }
    .ln { flex-direction: column; gap: 0; }
    .nm { font-size: 1.1rem; }
    .mt { font-size: .85rem; color: var(--mut); }
  }
</style>
