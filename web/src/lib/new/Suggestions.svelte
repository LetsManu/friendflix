<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Noch nicht bei uns": suggestions for titles that are not in the library, each with its reason (similar to a title you
   * know, or its release date) and the Wünschen button. Cards on the desktop, list cards on the phone. Only for grown-up profiles
   * with a request service (the page decides).
   */
  import { fmtDate, t } from '#lib/i18n';
  import type { Suggestion } from '#lib/newpage';
  import RequestButton from '#lib/requests/RequestButton.svelte';

  export let items: Suggestion[];
  export let title: string;
  export let sub = '';

  const kind = (s: Suggestion) => (s.mediaType === 'tv' ? $t('home.new.kind.series') : $t('home.new.kind.movie'));
  const meta = (s: Suggestion) => [kind(s), s.year].filter(Boolean).join(' · ');
</script>

<section class="ms" aria-labelledby="np-ms">
  <div class="hd"><h2 id="np-ms">{title}</h2>{#if sub}<span class="sub">{sub}</span>{/if}</div>
  <ul>
    {#each items as s (s.mediaType + s.tmdbId)}
      <li class="c">
        <div class="art" aria-hidden="true">{#if s.poster}<img src={s.poster} alt="" loading="lazy" decoding="async" />{/if}</div>
        <span class="tag">{$t('home.new.notInLibrary')}</span>
        <div class="tx">
          <div class="ln"><b class="nm">{s.title}</b><span class="mt">{meta(s)}</span></div>
          <span class="why">{$t('home.new.similarTo', { seed: s.reason.seed })}</span>
          {#if s.releaseDate}<span class="rel">{$t('home.new.releasesOn', { date: fmtDate(s.releaseDate, { day: 'numeric', month: 'long' }) })}</span>{/if}
          <div class="act"><RequestButton block mediaType={s.mediaType} tmdbId={s.tmdbId} title={s.title} state={s.request.state} /></div>
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .ms { min-width: 0; }
  .hd { display: flex; align-items: baseline; justify-content: space-between; gap: .8rem; margin: 0 0 .7rem; }
  h2 { margin: 0; font-size: 1.3rem; font-weight: 800; letter-spacing: -.01em; line-height: 1.25; }
  .sub { color: var(--acc-text); font-size: .85rem; font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
  .c { position: relative; display: flex; flex-direction: column; min-height: 250px; border-radius: 20px; overflow: hidden; isolation: isolate; border: 1px dashed rgba(255, 255, 255, .4); background: linear-gradient(135deg, #2c2540, #14111c); }
  .art { position: absolute; inset: 0; z-index: -2; }
  .art img { width: 100%; height: 100%; object-fit: cover; object-position: center 25%; display: block; }
  .c::before { content: ''; position: absolute; inset: 0; z-index: -1; background: linear-gradient(180deg, rgba(10, 9, 13, .1) 0%, rgba(10, 9, 13, .94) 62%); }
  .tag { position: absolute; top: 12px; left: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(12, 11, 16, .82); color: #fff; font-size: .75rem; font-weight: 700; }
  .tx { margin-top: auto; padding: 14px 16px 16px; display: flex; flex-direction: column; gap: .25rem; }
  .ln { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; }
  .nm { font-size: 1.05rem; font-weight: 800; line-height: 1.2; overflow-wrap: anywhere; min-width: 0; }
  .mt { flex: none; font-size: .8rem; color: rgba(255, 255, 255, .8); }
  .why, .rel { font-size: .85rem; font-weight: 600; color: var(--acc-text); line-height: 1.3; }
  .act { margin-top: .55rem; }
  @media (max-width: 1100px) { ul { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  /* phone: list cards, the poster at the left (the board's NewSleekPhone) */
  @media (max-width: 720px) {
    .hd { flex-direction: column; align-items: flex-start; gap: .15rem; }
    .sub { color: var(--mut); font-weight: 400; }
    ul { grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .c { display: grid; grid-template-columns: 96px minmax(0, 1fr); column-gap: 14px; min-height: 0; border: 0; background: none; overflow: visible; }
    .c::before { display: none; }
    .art { position: relative; inset: auto; z-index: 0; grid-row: 1 / span 2; align-self: start; aspect-ratio: 2 / 3; border-radius: 12px; overflow: hidden; border: 1px dashed rgba(255, 255, 255, .45); background: linear-gradient(135deg, #3a2d57, #15111f); }
    .tag { position: static; grid-column: 2; justify-self: start; border: 1px solid rgba(255, 255, 255, .3); }
    .tx { grid-column: 2; margin: 0; padding: 0; }
    .ln { flex-direction: column; gap: 0; }
    .nm { font-size: 1.1rem; }
    .mt { font-size: .85rem; color: var(--mut); }
  }
</style>
