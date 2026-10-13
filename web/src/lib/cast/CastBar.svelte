<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { goto } from '$app/navigation';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { castEngine, castSession } from './engine';
</script>

{#if $castSession}
  <div class="castbar" role="region" aria-label={$t('player.castBar.region')}>
    <button type="button" class="title" on:click={() => goto('/watch/' + $castSession?.itemId)}>{$castSession.title}</button>
    <button type="button" class="pp" aria-label={$t($castSession.paused ? 'player.controls.play' : 'player.controls.pause')} on:click={() => castEngine.playPause()}>
      <Icon name={$castSession.paused ? 'play' : 'pause'} size={24} />
    </button>
  </div>
{/if}

<style>
  .castbar { position: fixed; z-index: 81; left: 0; right: 0; bottom: calc(56px + var(--safe-bottom)); height: 64px; display: flex; align-items: center; gap: .5rem; padding: 0 var(--pad-x); background: var(--card); border-top: 1px solid var(--line, #20262d); }
  .title { flex: 1 1 auto; min-width: 0; min-height: 48px; text-align: left; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: inherit; background: none; border: 0; cursor: pointer; }
  .pp { flex: none; width: 48px; height: 48px; display: grid; place-items: center; border: 0; border-radius: var(--radius); background: var(--acc-fill, var(--acc)); color: #fff; cursor: pointer; }
  @media (min-width: 721px) { .castbar { bottom: 0; } }
</style>
