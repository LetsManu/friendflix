<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The remote's Audio and Subtitles chips: each opens a glass menu (`role="menu"` of `menuitemradio`, the keys of
   * `ui/menuKeys`; Escape closes and gives the focus back to the chip). Audio asks the engine for a new token with that track
   * (`refresh`), subtitles switch on the receiver (`setSubtitle`). AirPlay carries only the Audio chip until the stream has its
   * subtitles.
   */
  import { tick } from 'svelte';
  import { growBoth } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { menuKeys } from '#lib/ui/menuKeys';
  import { castEngine, type CastSession, type CastTrack } from './engine';

  export let session: CastSession;
  export let airplay = false;
  /** below 1200 px the chips keep their values but drop the icon */
  export let icons = true;

  type Which = 'audio' | 'subs';
  let open: Which | null = null;
  const btn: Partial<Record<Which, HTMLButtonElement>> = {};
  let box: HTMLDivElement | undefined;

  const nameOf = (x: CastTrack | undefined): string => x?.title || x?.language || (x ? String(x.index) : '');
  $: audio = session.audioTracks;
  $: subs = session.subtitles;
  $: audioSel = session.audioIndex ?? audio.find((a) => a.isDefault)?.index ?? audio[0]?.index;
  $: audioValue = nameOf(audio.find((a) => a.index === audioSel));
  $: subValue = session.subIndex === -1 ? $t('player.castRemote.off') : nameOf(subs.find((x) => x.index === session.subIndex)) || $t('player.castRemote.off');
  $: showAudio = audio.length > 0;
  $: showSubs = !airplay && subs.length > 0;
  $: items = open === 'audio' ? audio.map((a) => ({ index: a.index, name: nameOf(a) })) : [{ index: -1, name: $t('player.castRemote.off') }, ...subs.map((x) => ({ index: x.index, name: nameOf(x) }))];
  $: selected = open === 'audio' ? audioSel : session.subIndex;
  $: if (!showAudio && open === 'audio') open = null;
  $: if (!showSubs && open === 'subs') open = null;

  async function toggle(w: Which) {
    if (open === w) { open = null; return; }
    open = w;
    await tick();
    (box?.querySelector<HTMLElement>('[aria-checked="true"]') ?? box?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus({ preventScroll: true });
  }
  function close(refocus: boolean) {
    const w = open;
    open = null;
    if (refocus && w) btn[w]?.focus();
  }
  function pick(index: number) {
    const w = open;
    close(true);
    if (w === 'audio') { if (index !== audioSel) void castEngine.refresh({ audioIndex: index }); } else if (index !== session.subIndex) castEngine.setSubtitle(index);
  }
  function key(e: KeyboardEvent) {
    e.stopPropagation(); // the player's own keys (volume, seek) stay out of an open menu
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
  }
  /** a click outside closes (the chip that opened it toggles itself) */
  function outside(e: PointerEvent) {
    if (open && !(e.target as Element | null)?.closest('.tc')) open = null;
  }
  /** focus leaving the chips (Tab ends up elsewhere) closes the menu */
  function out(e: FocusEvent) {
    if (open && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) open = null;
  }
</script>

<svelte:window on:pointerdown={outside} />

{#if showAudio || showSubs}
  <div class="tc" role="group" aria-label={$t('player.controls.tracks')} on:focusout={out}>
    {#each [['audio', showAudio], ['subs', showSubs]] as [w, on] (w)}
      {#if on}
        {@const which = w as Which}
        <div class="anchor" class:r={which === 'subs' && showAudio}>
          <button type="button" class="frost-btn chip" bind:this={btn[which]} aria-haspopup="menu" aria-expanded={open === which}
            aria-label={$t(which === 'audio' ? 'player.castRemote.audioChip' : 'player.castRemote.subsChip', { value: which === 'audio' ? audioValue : subValue })}
            on:click={() => toggle(which)}>
            {#if icons}<Icon name={which === 'audio' ? 'volume' : 'subtitles'} size={18} />{/if}
            <span class="val"><span class="lbl">{$t(which === 'audio' ? 'player.controls.audio' : 'player.subs.title')}</span><span class="v">{which === 'audio' ? audioValue : subValue}</span></span>
            <Icon name="chevron-down" size={16} />
          </button>
          {#if open === which}
            <div class="menu frost frost-menu frost-safe" role="menu" aria-label={$t(which === 'audio' ? 'player.controls.audio' : 'player.subs.title')} tabindex="-1" bind:this={box}
              use:menuKeys={{ close: () => (open = null), trigger: btn[which] }} style="--fr-scrim-safe:{SCRIM_MENU}" transition:growBoth={{ trigger: btn[which] }} on:keydown={key}>
              {#each items as it (it.index)}
                <button type="button" class="mi" role="menuitemradio" aria-checked={it.index === selected} tabindex="-1" on:click={() => pick(it.index)}>
                  <span class="tick" aria-hidden="true">{#if it.index === selected}<Icon name="check" size={18} />{/if}</span><span class="nm">{it.name}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .tc { display: flex; gap: 10px; min-width: 0; }
  .anchor { position: relative; min-width: 0; }
  .chip { max-width: 100%; padding: 0 14px; font-size: .9rem; gap: 8px; }
  .val { display: flex; gap: 6px; min-width: 0; text-align: left; }
  .lbl { flex: none; font-weight: 600; color: rgba(255, 255, 255, .72); }
  .v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu { position: absolute; bottom: calc(100% + 8px); left: 0; min-width: 220px; max-width: min(320px, calc(100vw - 32px)); max-height: 40vh; overflow-y: auto; padding: 8px; box-sizing: border-box; display: flex; flex-direction: column; outline: none; z-index: 5; }
  .r .menu { left: auto; right: 0; }
  .mi { display: flex; align-items: center; gap: 10px; justify-content: flex-start; min-height: 44px; padding: 8px 12px; border-radius: 12px; background: transparent; color: #fff; font-size: .92rem; font-weight: 600; text-align: left; }
  .mi:hover:not(:disabled), .mi:focus-visible { background: var(--fr-sel); }
  .mi[aria-checked='true'] { background: var(--fr-sel); }
  .tick { flex: none; width: 18px; display: grid; place-items: center; }
  .nm { min-width: 0; overflow-wrap: anywhere; }
  /* phone: label over value ("Audio / English 5.1"), the two chips share the row */
  :global(.phone) .tc { width: 100%; }
  :global(.phone) .anchor { flex: 1 1 0; }
  :global(.phone) .chip { width: 100%; justify-content: space-between; padding: 6px 14px; min-height: 52px; }
  :global(.phone) .val { display: grid; gap: 0; }
  :global(.phone) .lbl { font-size: .7rem; }
</style>
