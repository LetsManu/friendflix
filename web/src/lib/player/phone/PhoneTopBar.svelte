<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Phone top bar, end side (spec 2026-11-08 §1): the quality chip (default slot), Cast and AirPlay where available, lock.
   * Glass circles of 44 px; the blur only with full motion (`blur`).
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';

  export let cast: { on: boolean; label: string } | null = null;
  export let airplay: { on: boolean; busy: boolean; label: string } | null = null;
  export let lock = false;
  export let blur = false;
  const dispatch = createEventDispatcher<{ cast: void; airplay: void; lock: void }>();
</script>

<div class="ptop" class:blur>
  <slot />
  {#if cast}
    <button type="button" class="gl" class:on={cast.on} aria-pressed={cast.on} aria-label={cast.label} title={cast.label} on:click={() => dispatch('cast')}><Icon name="cast" size={22} /></button>
  {/if}
  {#if airplay}
    <button type="button" class="gl" class:on={airplay.on} class:busy={airplay.busy} aria-pressed={airplay.on} aria-busy={airplay.busy} data-testid="airplay" aria-label={airplay.label} title={airplay.label} on:click={() => dispatch('airplay')}><Icon name="airplay" size={22} /></button>
  {/if}
  {#if lock}
    <button type="button" class="gl" aria-label={$t('player.lock.lockAria')} title={$t('player.lock.lockAria')} on:click={() => dispatch('lock')}><Icon name="lock" size={22} /></button>
  {/if}
</div>

<style>
  .ptop { display: flex; align-items: center; gap: 8px; flex: none; }
  .gl { display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; color: #fff;
    background: rgba(20, 20, 24, .62); border: 1px solid rgba(255, 255, 255, .12); }
  .gl:hover:not(:disabled) { background: rgba(40, 40, 46, .72); }
  .blur .gl { -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
  .gl.on { color: var(--acc, #ff4f6d); }
  .gl.busy { opacity: .55; }
</style>
