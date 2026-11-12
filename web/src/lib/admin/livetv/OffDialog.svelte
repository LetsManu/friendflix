<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Live-TV ausschalten (spec §4.5): two checkboxes, "Image entfernen" and "Zwischenspeicher löschen"; the cache choice is possible
   * only together with the image (the updater's one data-deleting op is `remove`). Recordings are kept. Without an updater the
   * dialog shows the manual command instead. Opens and closes with the glass grow / scrim fade (calm mode: at once).
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { growBoth, scrimFade } from '#lib/glass/fx';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import CopyField from '#lib/ui/CopyField.svelte';

  export let open = false;
  /** no updater to do it: show the command */
  export let manual = false;
  export let pending = false;
  /** the button that opened it (the dialog grows out of it and focus goes back to it) */
  export let trigger: HTMLElement | null = null;
  const dispatch = createEventDispatcher<{ confirm: { removeImage: boolean; removeCache: boolean }; close: void }>();
  const COMMAND = 'docker compose stop livetv && docker compose rm -f livetv';

  let removeImage = false, removeCache = false, box: HTMLElement | undefined;
  $: if (!removeImage) removeCache = false;
  $: if (open) void focusFirst(); else { removeImage = false; removeCache = false; }

  async function focusFirst() {
    await tick();
    box?.querySelector<HTMLElement>('input, button')?.focus();
  }
  function close() {
    dispatch('close');
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  const scrim = (node: Element) => scrimFade(node);
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events (Escape is handled by dialogKeys) -->
  <div class="ov" transition:scrim role="presentation" on:click|self={close}>
    <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="lt-off-t" bind:this={box} transition:growBoth={{ trigger }} use:dialogKeys={{ close }}>
      <h2 id="lt-off-t">{$t('adminLive.off.title')}</h2>
      {#if manual}
        <p class="body">{$t('adminLive.off.manualBody')}</p>
        <CopyField label={$t('adminLive.off.manualCommand')} value={COMMAND} />
      {:else}
        <p class="body">{$t('adminLive.off.body')}</p>
        <label class="opt"><input type="checkbox" bind:checked={removeImage} /><span>{$t('adminLive.off.removeImage')}</span></label>
        <!-- the space for the hint is always there: nothing moves when the box gets enabled -->
        <label class="opt" class:off={!removeImage}><input type="checkbox" bind:checked={removeCache} disabled={!removeImage} aria-describedby="lt-off-h" /><span>{$t('adminLive.off.removeCache')}</span></label>
        <p class="hint" id="lt-off-h" class:show={!removeImage}>{$t('adminLive.off.cacheNeedsImage')}</p>
      {/if}
      <p class="keeps">{$t('adminLive.off.keepsRecordings')}</p>
      <div class="acts">
        <Button variant="secondary" on:click={close}>{$t('adminLive.off.cancel')}</Button>
        {#if !manual}<Button variant="danger" solid {pending} on:click={() => dispatch('confirm', { removeImage, removeCache })}>{$t('adminLive.off.confirm')}</Button>{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 130; background: rgba(0,0,0,.7); display: grid; place-items: center; padding: max(1rem, var(--safe-top)) 1rem max(1rem, var(--safe-bottom)); }
  .dlg { width: min(460px, 100%); max-height: 100%; overflow-y: auto; background: var(--fr-solid); border: 1px solid #323a43; border-radius: 12px; padding: 1.4rem 1.4rem 1.2rem; box-shadow: var(--shadow-pop); display: grid; gap: .4rem; min-width: 0; }
  h2 { margin: 0 0 .4rem; font-size: 1.2rem; overflow-wrap: anywhere; }
  .body { color: var(--mut); margin: 0 0 .5rem; overflow-wrap: anywhere; }
  .opt { display: flex; align-items: center; gap: .7rem; min-height: 44px; cursor: pointer; }
  .opt.off { cursor: default; }
  .opt.off span { color: var(--mut); }
  .hint { margin: 0; font-size: .85rem; color: var(--mut); min-height: 1.3em; visibility: hidden; }
  .hint.show { visibility: visible; }
  .keeps { margin: .3rem 0 0; font-weight: 600; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts :global(.btn), .acts :global(button) { width: 100%; } }
</style>
