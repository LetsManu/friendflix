<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { castEngine, castSession } from './engine';

  /** play / pause only drives a TV that plays (connecting / reconnect / failed / ended have no live token) */
  $: live = $castSession?.state === 'playing';
  $: line2 = $castSession?.state === 'reconnect' ? $t('player.castBar.reconnect') : $castSession?.subtitle ?? '';

  /**
   * `reconnect`: the engine reconnects inside this tap (AirPlay opens the system picker, which needs the gesture);
   * `failed`: the session is dropped and the title plays here; otherwise the remote (watch page) opens
   */
  function openTitle() {
    const s = get(castSession);
    if (!s) return;
    if (s.state === 'reconnect') { castEngine.reconnect(); return; }
    if (s.state === 'failed') castEngine.release();
    void goto('/watch/' + s.itemId);
  }
  function playPause() { if (get(castSession)?.state === 'playing') castEngine.playPause(); }
</script>

{#if $castSession}
  <div class="castbar" role="region" aria-label={$t('player.castBar.region')}>
    <button type="button" class="title" on:click={openTitle}>
      <span class="t1">{$castSession.title}</span>
      {#if line2}<span class="t2" class:hint={$castSession.state === 'reconnect'}>{line2}</span>{/if}
    </button>
    <button type="button" class="pp" aria-disabled={live ? undefined : 'true'} aria-label={$t($castSession.paused ? 'player.controls.play' : 'player.controls.pause')} on:click={playPause}>
      <Icon name={$castSession.paused ? 'play' : 'pause'} size={24} />
    </button>
  </div>
{/if}

<style>
  .castbar { position: fixed; z-index: 81; left: 0; right: 0; bottom: calc(56px + var(--safe-bottom)); height: 64px; display: flex; align-items: center; gap: .5rem; padding: 0 var(--pad-x); background: var(--card); border-top: 1px solid var(--line, #20262d); }
  .title { flex: 1 1 auto; min-width: 0; min-height: 48px; display: flex; flex-direction: column; justify-content: center; text-align: left; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  .t1, .t2 { display: block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t1 { font-weight: 600; }
  .t2 { font-size: .85rem; color: var(--mut); }
  .t2.hint { color: var(--warn); }
  .pp { flex: none; width: 48px; height: 48px; display: grid; place-items: center; border: 0; border-radius: var(--radius); background: var(--acc-fill, var(--acc)); color: #fff; cursor: pointer; }
  .pp[aria-disabled='true'] { opacity: .5; cursor: default; }
  @media (min-width: 721px) { .castbar { bottom: 0; } }
</style>
