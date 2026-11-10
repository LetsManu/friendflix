<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Phone "Neue Folgen": one line per show with the newest new episode (16:9 thumbnail, show, season and episode, freshness); a tap plays it. */
  import { img } from '#lib/api';
  import { playOrCast } from '#lib/cast/playOrCast';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { freshText, type NewEpisode } from '#lib/newpage';

  export let items: NewEpisode[];
  export let now: number;
  export let title: string;
</script>

<section class="ne" aria-label={title}>
  <h2>{title}</h2>
  <ul>
    {#each items as e (e.seriesId)}
      {@const ep = e.episode}
      {@const code = $t('home.new.seasonEpisode', { s: ep.season, e: ep.episode })}
      <li>
        <a href="/watch/{ep.id}" aria-label={$t('home.card.playName', { name: `${e.seriesName}, ${code}` })} on:click={(ev) => playOrCast(ev, { id: ep.id })}>
          <span class="th">
            {#if ep.image}<img loading="lazy" decoding="async" src={img(ep.id, 320)} alt="" width="160" height="90" />{/if}
            <span class="pl" aria-hidden="true"><Icon name="play" size={18} /></span>
          </span>
          <span class="tx"><b>{e.seriesName}</b><span class="code">{code}</span><span class="fresh">{freshText(ep.addedAt, now, $t)}</span></span>
        </a>
      </li>
    {/each}
  </ul>
</section>

<style>
  .ne { margin: 1.4rem 0 0; position: relative; z-index: 1; }
  h2 { margin: 0 var(--pad-x) .6rem; font-size: 1.05rem; font-weight: 700; line-height: 1.25; }
  ul { list-style: none; margin: 0; padding: 0 var(--pad-x); display: grid; gap: .5rem; }
  a { display: flex; align-items: center; gap: .9rem; min-height: 64px; color: inherit; }
  .th { position: relative; flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: linear-gradient(135deg, #242b33, #151a20); }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pl { position: absolute; left: 50%; top: 50%; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, .85); background: rgba(0, 0, 0, .55); display: grid; place-items: center; padding-left: 2px; }
  .tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: .85rem; color: var(--mut); }
  .tx b { color: #fff; font-size: .95rem; overflow-wrap: anywhere; }
  .fresh { color: var(--acc-text); font-weight: 600; }
  a:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 8px; box-shadow: 0 0 0 4px var(--ring-dark); }
</style>
