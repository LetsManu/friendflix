<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { nowLines, type LiveChannel } from './api';
  import { fadeIn } from './fade';
  import { createLongOk, LONG_OK_MS } from './longok';
  import { rowName } from './progress';

  /**
   * Live TV for a kids profile (spec §11.4): the favourites above, then a grid of big channel tiles (logo, name, the *Jetzt*
   * title). The server sends only the channels of kid-friendly groups; there are no chips, no guide, no star buttons. A favourite
   * is a long press (touch or mouse) or a long OK (remote), the same 600 ms as everywhere. Solid panels (a kids profile is
   * calm and still): nothing here blurs or animates.
   */
  export let channels: LiveChannel[];
  export let favs: LiveChannel[];
  export let now: Date;
  export let loading = false;
  /** the person has no channel at all */
  export let none = false;

  const dispatch = createEventDispatcher<{ open: LiveChannel; star: LiveChannel }>();

  // ---- long press with a pointer: the tile that fired swallows the click that follows the release ----
  let pt: ReturnType<typeof setTimeout> | undefined;
  let firedId: string | null = null;
  let from: { x: number; y: number } | null = null;
  function down(e: PointerEvent, c: LiveChannel) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    firedId = null;
    from = { x: e.clientX, y: e.clientY };
    clearTimeout(pt);
    pt = setTimeout(() => { firedId = c.id; from = null; dispatch('star', c); }, LONG_OK_MS);
  }
  function move(e: PointerEvent) {
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 12) cancel(); // a drag (scrolling) is no press
  }
  function cancel() { clearTimeout(pt); pt = undefined; from = null; }
  function click(c: LiveChannel) {
    if (firedId === c.id) { firedId = null; return; }
    dispatch('open', c);
  }

  // ---- long OK with a remote (Enter held): short = watch, long = favourite ----
  let held: LiveChannel | null = null;
  const longOk = createLongOk({
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    onShort: () => { const c = held; held = null; if (c) dispatch('open', c); },
    onLong: () => { const c = held; held = null; if (c) dispatch('star', c); },
  });
  function key(e: KeyboardEvent, c: LiveChannel) {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // no click of its own: the keyup decides
    held = c;
    longOk.down(e);
  }
  /** a held OK that loses the window or the tile fires nothing, on that tile or any other */
  function dropOk() { held = null; longOk.cancel(); }
  onMount(() => {
    window.addEventListener('blur', dropOk);
    return () => window.removeEventListener('blur', dropOk);
  });
  onDestroy(() => { cancel(); dropOk(); });

  const title = (c: LiveChannel): string => (c.receiving !== false && c.epg === 'ok' && c.now ? c.now.title : nowLines(c).now);
  $: sections = [
    { key: 'fav', head: $t('live.favourites'), list: favs.slice(0, 12), grid: false },
    { key: 'all', head: $t('live.all'), list: channels, grid: true },
  ];
</script>

<div class="kl" aria-busy={loading ? 'true' : undefined}>
  <div class="kbg" aria-hidden="true"></div>
  {#if loading}
    <ul class="grid" aria-hidden="true">{#each Array(6) as _, k (k)}<li class="sk"></li>{/each}</ul>
  {:else if !channels.length}
    <p class="note" role="status">{none ? $t('live.empty') : $t('live.emptyGroup')}</p>
  {:else}
    {#each sections as s (s.key)}
      {#if s.list.length}
        <section class="sec" aria-labelledby="kl-{s.key}">
          <h2 id="kl-{s.key}">{s.head}</h2>
          <ul class="grid" class:strip={!s.grid} aria-label={s.grid ? $t('live.player.channelList') : undefined}>
            {#each s.list as c (c.id)}
              <li class="cell">
                <button type="button" class="tile" aria-label={rowName(c, now)}
                  on:pointerdown={(e) => down(e, c)} on:pointermove={move} on:pointerup={cancel} on:pointerleave={cancel} on:pointercancel={cancel}
                  on:contextmenu|preventDefault on:click={() => click(c)} on:keydown={(e) => key(e, c)} on:blur={dropOk} on:keyup={(e) => { if (e.key === 'Enter') longOk.up(); }}>
                  <span class="logo" aria-hidden="true">{#if c.logo}<img src={c.logo} alt="" width="96" height="96" loading="lazy" decoding="async" use:fadeIn />{/if}</span>
                  <span class="nm" aria-hidden="true"><b class="num">{c.number}</b> {c.name}</span>
                  <span class="ti" aria-hidden="true">{#if c.receiving !== false && c.epg === 'ok' && c.now}<i class="lb">{$t('live.now')}</i> {/if}{title(c)}</span>
                  {#if c.favourite}<span class="fv" aria-hidden="true"><Icon name="star" size={26} fill={true} /></span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .kl { --k-ink: #20233a; --k-focus: #ffb703; position: relative; color: var(--k-ink); }
  /* the kids home's sky, full-bleed behind the page (the layout's page frame is narrower than the screen) */
  .kbg { position: fixed; z-index: -1; left: 0; right: 0; top: 0; bottom: 0; background: radial-gradient(circle at 12% 8%, #fff6c9 0, transparent 38%), radial-gradient(circle at 92% 18%, #ffd6e8 0, transparent 34%), linear-gradient(180deg, #bfe9ff 0%, #e8f7ff 55%, #fffaf0 100%); }
  .sec { margin: 0 0 1.8rem; }
  h2 { margin: 0 0 .8rem; font-size: clamp(1.3rem, 3vw, 1.75rem); font-weight: 900; color: var(--k-ink); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr)); gap: 1.1rem; margin: 0; padding: 6px; list-style: none; }
  .strip { display: flex; overflow-x: auto; scrollbar-width: none; padding-bottom: 12px; }
  .strip::-webkit-scrollbar { display: none; }
  .strip .cell { flex: none; width: 230px; }
  .cell { list-style: none; }
  /* a big solid tile: the global coral button look is restated away, also for hover and press */
  .tile, .tile:hover:not(:disabled), .tile:active:not(:disabled) {
    position: relative; display: grid; grid-template-rows: 96px auto auto; justify-items: center; align-content: start; gap: .35rem; width: 100%; min-height: 190px; box-sizing: border-box; padding: 1rem .8rem .9rem; margin: 0;
    border: 0; border-radius: 24px; background: #fff; color: var(--k-ink); font: inherit; font-weight: 400; text-align: center; box-shadow: 0 6px 16px rgba(32, 35, 58, .15); transform: none; transition: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .tile:focus-visible { outline: 5px solid var(--k-focus); outline-offset: 2px; }
  .logo { display: grid; place-items: center; width: 96px; height: 96px; border-radius: 20px; background: #eef3fb; overflow: hidden; }
  .logo img { width: 80%; height: 80%; object-fit: contain; opacity: 0; transition: none; }
  .logo :global(img.in) { opacity: 1; }
  .nm { max-width: 100%; font-size: 1.25rem; font-weight: 900; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .num { font-variant-numeric: tabular-nums; color: #3c4a8f; }
  .ti { max-width: 100%; min-height: 1.3em; font-size: 1.02rem; line-height: 1.3; color: #3c4a8f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lb { font-style: normal; font-weight: 800; }
  :global(html.m-still) .tile { transition: none; }
  .fv { position: absolute; top: 10px; right: 10px; display: grid; color: #ffb703; }
  .sk { height: 190px; border-radius: 24px; background: rgba(255, 255, 255, .7); list-style: none; }
  .note { margin: 2rem 0; font-size: 1.2rem; font-weight: 700; min-height: 44px; }
</style>
