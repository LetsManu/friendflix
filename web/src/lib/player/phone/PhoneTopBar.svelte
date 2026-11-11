<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Phone top bar, end side (spec 2026-11-08 §1): the quality chip (default slot), "Play on" where a target is available, lock.
   * Glass circles of 44 px; the blur only with full motion (`blur`).
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';

  export let playon: { on: boolean; busy: boolean; open: boolean; label: string } | null = null;
  export let lock = false;
  export let blur = false;
  const dispatch = createEventDispatcher<{ playon: HTMLElement; lock: void }>();
</script>

<div class="ptop" class:blur>
  <slot />
  {#if playon}
    <button type="button" class="gl" class:on={playon.on} class:busy={playon.busy} aria-haspopup="dialog" aria-expanded={playon.open} aria-busy={playon.busy} data-testid="playon" aria-label={playon.label} title={playon.label} on:click={(e) => dispatch('playon', e.currentTarget)}><Icon name="cast" size={22} /></button>
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
