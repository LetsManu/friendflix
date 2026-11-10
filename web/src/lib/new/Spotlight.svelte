<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Für dich neu": one spotlight card (backdrop, kind and year, title, the engine's reason, Abspielen and Merkliste) and up to
   * two smaller cards next to it. On the phone only the spotlight shows; the page puts the rest in a row below it.
   */
  import { backdrop, img, type Item } from '#lib/api';
  import { playOrCast } from '#lib/cast/playOrCast';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { playPath, runtimeLabel } from '#lib/mobile';
  import { reasonText } from '#lib/reason';
  import { listIds, toggleList } from '#lib/stores';

  export let items: Item[];
  /** how many cards show (3 on the desktop, 1 on the phone) */
  export let count = 3;
  export let title: string;
  export let sub = '';

  let msg = '';
  $: shown = items.slice(0, count);
  const kind = (it: Item) => (it.type === 'Movie' ? $t('home.meta.movie') : $t('home.meta.series'));
  const meta = (it: Item, big: boolean) => [kind(it), it.year, big && it.type === 'Movie' ? runtimeLabel(it) : ''].filter(Boolean).join(' · ');
  const art = (it: Item, big: boolean) => (it.backdrop ? backdrop(it.id, big ? 1200 : 700) : it.image ? img(it.id, big ? 600 : 400) : '');
  async function save(it: Item) {
    const on = $listIds.has(it.id);
    msg = (await toggleList(it.id, on)) ? '' : $t('account.listSaveFailed');
  }
</script>

<section class="fy" aria-labelledby="np-fy">
  <div class="hd"><h2 id="np-fy">{title}</h2>{#if sub}<span class="sub">{sub}</span>{/if}</div>
  <ul class:one={shown.length === 1} class:two={shown.length === 2}>
    {#each shown as it, i (it.id)}
      {@const big = i === 0}
      {@const why = reasonText(it.reason, $t)}
      {@const on = $listIds.has(it.id)}
      <li class="c frost-clip" class:big>
        {#if art(it, big)}<img src={art(it, big)} alt="" loading={big ? 'eager' : 'lazy'} decoding="async" />{/if}
        <a class="cover" href="/item/{it.id}" aria-label={$t('home.new.details', { name: it.name })}></a>
        <div class="tx">
          <span class="mt">{meta(it, big)}</span>
          <b class="nm">{it.name}</b>
          {#if big}{#if why}<span class="why"><Icon name="star" size={14} />{why}</span>{/if}
          {:else}<span class="why" class:blank={!why} aria-hidden={why ? undefined : 'true'}>{#if why}<Icon name="star" size={14} />{why}{/if}</span>{/if}
          {#if big}
            <div class="bt">
              <a class="btn pill play" href={playPath(it)} on:click={(e) => it.type !== 'Series' && playOrCast(e, it)}><Icon name="play" size={18} />{$t('home.card.play')}</a>
              <button type="button" class="sv" class:on aria-pressed={on} on:click={() => save(it)}><Icon name="bookmark" size={18} /><span>{$t('home.card.myList')}</span></button>
            </div>
          {/if}
        </div>
        {#if !big}<button type="button" class="ic" class:on aria-pressed={on} aria-label={`${$t('home.card.myList')}: ${it.name}`} on:click={() => save(it)}><Icon name="bookmark" size={18} /></button>{/if}
      </li>
    {/each}
  </ul>
  <p class="sr-only" role="status">{msg}</p>
</section>

<style>
  .fy { min-width: 0; }
  .hd { display: flex; align-items: baseline; gap: .8rem; margin: 0 0 .7rem; }
  h2 { margin: 0; font-size: 1.3rem; font-weight: 800; letter-spacing: -.01em; line-height: 1.25; }
  .sub { color: var(--mut); font-size: .85rem; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
  ul.two { grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr); }
  ul.one { grid-template-columns: minmax(0, 1fr); }
  .c { position: relative; height: 280px; border-radius: 20px; overflow: hidden; background: linear-gradient(135deg, #3a2d57, #15111f); box-shadow: inset 0 0 0 1px var(--fr-line); isolation: isolate; }
  .c img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: -2; }
  .c::before { content: ''; position: absolute; inset: 0; z-index: -1; background: linear-gradient(180deg, rgba(10, 9, 13, 0) 25%, rgba(10, 9, 13, .92) 100%); }
  .cover { position: absolute; inset: 0; z-index: 0; border-radius: inherit; }
  .cover:focus-visible { outline: 3px solid #fff; outline-offset: -3px; box-shadow: inset 0 0 0 6px var(--ring-dark); }
  .tx { position: absolute; left: 0; right: 0; bottom: 0; padding: 22px 24px; display: flex; flex-direction: column; gap: .3rem; pointer-events: none; z-index: 1; }
  .tx .bt { pointer-events: auto; }
  .mt { font-size: .85rem; color: rgba(255, 255, 255, .86); }
  .nm { font-size: 1.35rem; font-weight: 800; line-height: 1.15; overflow-wrap: anywhere; }
  .big .nm { font-size: 2.4rem; letter-spacing: -.02em; }
  .why { display: inline-flex; align-items: flex-start; gap: .35rem; color: var(--acc-text); font-size: .9rem; font-weight: 600; line-height: 1.3; }
  .why { min-height: 1.3em; }
  .big .why { min-height: 0; }
  .why :global(svg) { flex: none; margin-top: 2px; }
  .bt { display: flex; gap: .6rem; margin-top: .7rem; flex-wrap: wrap; }
  .play { min-height: 44px; }
  .sv { min-height: 44px; border-radius: 999px; background: rgba(20, 18, 26, .7); color: #fff; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35); padding-inline: 1.2rem; }
  .sv.on, .ic.on { background: #fff; color: #111; }
  .ic { position: absolute; top: 14px; right: 14px; z-index: 2; width: 44px; height: 44px; padding: 0; border-radius: 50%; background: rgba(20, 18, 26, .7); color: #fff; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35); }
  .play:focus-visible, .sv:focus-visible, .ic:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); }
  @media (max-width: 720px) {
    ul { grid-template-columns: minmax(0, 1fr); }
    .c { height: auto; min-height: 340px; }
    .big .nm { font-size: 2rem; }
    .tx { padding: 18px; }
    .play { flex: 1 1 auto; }
  }
</style>
