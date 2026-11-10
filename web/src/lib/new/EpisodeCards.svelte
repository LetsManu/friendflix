<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Desktop "Neue Folgen": the newest new episode of up to four followed shows as large 16:9 cards (play glyph, show, season and
   * episode and the freshness on the card); a click plays it. The header links to the calendar.
   */
  import { img } from '#lib/api';
  import { playOrCast } from '#lib/cast/playOrCast';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { freshText, type NewEpisode } from '#lib/newpage';

  export let items: NewEpisode[];
  export let now: number;
  export let title: string;
  export let sub = '';
</script>

<section class="ec" aria-labelledby="np-ec">
  <div class="hd">
    <h2 id="np-ec">{title}</h2>{#if sub}<span class="sub">{sub}</span>{/if}
    <a class="all" href="/calendar">{$t('home.new.allEpisodes')}</a>
  </div>
  <ul>
    {#each items as e (e.seriesId)}
      {@const ep = e.episode}
      {@const code = $t('home.new.seasonEpisode', { s: ep.season, e: ep.episode })}
      <li>
        <a class="c" href="/watch/{ep.id}" aria-label={$t('home.card.playName', { name: `${e.seriesName}, ${code}` })} on:click={(ev) => playOrCast(ev, { id: ep.id })}>
          {#if ep.image}<img loading="lazy" decoding="async" src={img(ep.id, 640)} alt="" />{/if}
          <span class="pl" aria-hidden="true"><Icon name="play" size={22} /></span>
          <span class="tx"><span class="l"><b>{e.seriesName}</b><span class="code">{$t('detail.view.episodeCode', { s: String(ep.season), e: String(ep.episode) })}</span></span><span class="fresh">{freshText(ep.addedAt, now, $t)}</span></span>
        </a>
      </li>
    {/each}
  </ul>
</section>

<style>
  .ec { min-width: 0; }
  .hd { display: flex; align-items: baseline; gap: .8rem; margin: 0 0 .7rem; }
  h2 { margin: 0; font-size: 1.3rem; font-weight: 800; letter-spacing: -.01em; line-height: 1.25; }
  .sub { color: var(--mut); font-size: .85rem; }
  .all { margin-left: auto; color: var(--acc-text); font-size: .9rem; font-weight: 600; }
  .all:hover { text-decoration: underline; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  .c { position: relative; display: block; aspect-ratio: 16 / 9; border-radius: 16px; overflow: hidden; isolation: isolate; color: #fff; background: linear-gradient(135deg, #242b33, #151a20); box-shadow: inset 0 0 0 1px var(--fr-line); }
  .c img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: -2; }
  .c::before { content: ''; position: absolute; inset: 0; z-index: -1; background: linear-gradient(180deg, rgba(10, 9, 13, 0) 45%, rgba(10, 9, 13, .92) 100%); }
  .pl { position: absolute; left: 50%; top: 45%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, .85); background: rgba(0, 0, 0, .5); display: grid; place-items: center; padding-left: 2px; }
  .tx { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px 14px 12px; display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; font-size: .85rem; }
  .l { display: flex; align-items: baseline; gap: .4rem; min-width: 0; }
  .l b { font-size: .95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .code { flex: none; color: rgba(255, 255, 255, .86); }
  .fresh { flex: none; color: var(--acc-text); font-weight: 600; }
  .c:focus-visible { outline: 3px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 6px var(--ring-dark); }
  @media (max-width: 1100px) { ul { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
