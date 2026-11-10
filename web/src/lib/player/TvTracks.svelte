<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import type { AudioFx } from '#lib/player/audiofx';
  import { sheetIn, sheetOut } from '#lib/player/tvSheet';

  /**
   * TV "Audio & subtitles" (spec 4): two vertical lists side by side on a sheet that slides up from the bottom. OK applies at
   * once (the sheet stays open, the check moves); Back closes it (Player). The sound modes ("clear voices", "night") sit under
   * the audio list so the TV keeps them.
   */
  export let audio: Array<{ index: number; title: string; isDefault?: boolean }> = [];
  export let subs: Array<{ index: number; title: string }> = [];
  /** selected audio track (undefined = the default one) and subtitle (-1 = off) */
  export let audioIndex: number | undefined = undefined;
  export let subIndex = -1;
  export let fx: AudioFx = { voice: false, night: false };
  export let fxDisabled: string | null = null;
  /** the per-device "Surround sound" switch: offered, on, and locked (a sound mode keeps the output stereo) */
  export let surroundShown = false;
  export let surroundOn = true;
  export let surroundLocked = false;

  const dispatch = createEventDispatcher<{ audio: number; sub: number; fx: keyof AudioFx; surround: void }>();
  const FX = [{ k: 'voice', label: 'scenes.audio.voice' }, { k: 'night', label: 'scenes.audio.night' }] as const;
  $: audioOn = (a: { index: number; isDefault?: boolean }) => audioIndex === a.index || (audioIndex === undefined && Boolean(a.isDefault));

  let root: HTMLDivElement | undefined;
  onMount(() => { void tick().then(() => (root?.querySelector<HTMLElement>('.subs [aria-checked="true"]') ?? root?.querySelector<HTMLElement>('[aria-checked="true"]') ?? root?.querySelector<HTMLElement>('button'))?.focus()); });
</script>

<div class="tvov tracks ui" bind:this={root} data-nav data-scope role="dialog" aria-label={$t('player.controls.tracks')} tabindex="-1" in:sheetIn out:sheetOut on:click|stopPropagation on:keydown={() => {}}>
  <div class="cols">
    {#if audio.length}
      <section>
        <h3 class="tv-row-title">{$t('player.controls.audio')}</h3>
        <div class="list">
          {#each audio as a (a.index)}
            <button type="button" class="ti" role="menuitemradio" aria-checked={audioOn(a)} on:click={() => dispatch('audio', a.index)}><span class="ck">{#if audioOn(a)}<Icon name="check" size={24} />{/if}</span><span class="tl">{a.title}</span></button>
          {/each}
        </div>
        <h3 class="tv-meta sh">{$t('scenes.audio.title')}</h3>
        <div class="list">
          {#each FX as o (o.k)}
            <button type="button" class="ti" role="switch" aria-checked={fx[o.k] && !fxDisabled} disabled={Boolean(fxDisabled)} on:click={() => dispatch('fx', o.k)}><span class="ck">{#if fx[o.k] && !fxDisabled}<Icon name="check" size={24} />{/if}</span><span class="tl">{$t(o.label)}</span></button>
          {/each}
          {#if surroundShown}
            <button type="button" class="ti" role="switch" aria-checked={surroundOn} disabled={surroundLocked} data-testid="surround-switch" on:click={() => dispatch('surround')}><span class="ck">{#if surroundOn}<Icon name="check" size={24} />{/if}</span><span class="tl">{$t('scenes.audio.surround')}<small>{$t(surroundLocked ? 'scenes.audio.surroundMode' : 'scenes.audio.surroundHint')}</small></span></button>
          {/if}
        </div>
      </section>
    {/if}
    <section class="subs">
      <h3 class="tv-row-title">{$t('player.subs.title')}</h3>
      <div class="list">
        <button type="button" class="ti" role="menuitemradio" aria-checked={subIndex === -1} on:click={() => dispatch('sub', -1)}><span class="ck">{#if subIndex === -1}<Icon name="check" size={24} />{/if}</span><span class="tl">{$t('common.off')}</span></button>
        {#each subs as s (s.index)}
          <button type="button" class="ti" role="menuitemradio" aria-checked={subIndex === s.index} on:click={() => dispatch('sub', s.index)}><span class="ck">{#if subIndex === s.index}<Icon name="check" size={24} />{/if}</span><span class="tl">{s.title}</span></button>
        {/each}
      </div>
    </section>
  </div>
</div>

<style>
  /* a sheet over the lower part of the picture: black from the bottom, the picture stays visible above it */
  .tracks { position: absolute; left: 0; right: 0; bottom: 0; z-index: 12; max-height: 72%; padding: 6rem var(--tv-safe-x, 5vw) var(--tv-safe-y, 5vh); box-sizing: border-box; display: flex; flex-direction: column; justify-content: flex-end;
    background: linear-gradient(0deg, #000 0%, rgba(0, 0, 0, .94) 62%, rgba(0, 0, 0, 0) 100%); color: #fff; }
  .cols { display: flex; gap: 5rem; min-height: 0; }
  section { display: flex; flex-direction: column; min-width: 18rem; max-width: 30rem; min-height: 0; }
  :global(html.tv) h3.tv-row-title { margin: 0 0 1rem .75rem; }
  :global(html.tv) h3.sh { margin: 1.5rem 0 .5rem .75rem; font-size: 1.1rem; }
  .list { display: flex; flex-direction: column; gap: .25rem; min-height: 0; overflow-y: auto; scrollbar-width: none; padding: .2rem; margin: -.2rem; }
  .list::-webkit-scrollbar { display: none; }
  :global(html.tv) .ti { flex: none; justify-content: flex-start; gap: .6rem; min-height: 3.5rem; padding: 0 1.25rem 0 .75rem; border: 0; border-radius: var(--tv-radius, 6px); background: transparent; color: var(--tv-white-78); font-size: 1.3rem; font-weight: 500; text-align: left;
    transform-origin: left center; transition: transform var(--tv-d-s) var(--tv-emph-out); }
  :global(html.tv) .ti[aria-checked='true'] { color: #fff; font-weight: 600; }
  :global(html.tv) .ti:focus-visible { outline: none; background: #fff; color: #000; transform: scale(1.03); transition: transform var(--tv-d-spring) var(--tv-spring); }
  :global(html.tv) .ti:disabled { opacity: .45; }
  .ck { display: inline-grid; place-items: center; width: 1.6rem; flex: none; }
  .tl { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tl small { display: block; font-size: .85rem; font-weight: 400; opacity: .75; }
  @media (prefers-reduced-motion: reduce) { :global(html.tv) .ti:focus-visible { transform: none; } }
</style>
