<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The remote's up-next card (spec 2026-11-10 §1): eyebrow, the next episode's still, its label, a status line, "Play now" and
   * the session's autoplay switch. Hidden without an offer and for films. The switch is session-scoped (`castEngine.setAutoplay`).
   */
  import { onDestroy } from 'svelte';
  import { img } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { castEngine, type CastSession } from './engine';
  import { upNextLine, upNextOf } from './remotescreen';

  export let session: CastSession;
  /** phone: the buttons take the full width, the card docks under the controls */
  export let compact = false;

  $: next = upNextOf(session);
  /** the countdown ticks while it runs */
  let now = Date.now(), tick: ReturnType<typeof setInterval> | undefined;
  $: counting = next?.startsAt != null;
  $: if (counting && !tick) { now = Date.now(); tick = setInterval(() => (now = Date.now()), 250); } else if (!counting && tick) { clearInterval(tick); tick = undefined; }
  onDestroy(() => clearInterval(tick));
  $: line = upNextLine(session, now, $t);
  let failed = '';
</script>

{#if next}
  <section class="un frost frost-safe frost-panel" class:compact aria-label={$t('player.castRemote.upNext')}>
    <div class="thumb">
      {#if failed !== next.itemId}<img src={img(next.itemId, 320)} alt="" loading="lazy" on:error={() => (failed = next?.itemId ?? '')} />{:else}<span class="ph"><Icon name="film" size={26} /></span>{/if}
    </div>
    <div class="txt">
      <p class="eyebrow">{$t('player.castRemote.upNext')}</p>
      <b class="unt">{next.label}</b>
      <span class="mut">{line}</span>
    </div>
    <div class="acts">
      <button type="button" class="frost-btn go" on:click={() => void castEngine.next()}><Icon name="play" size={18} />{$t('player.castRemote.playNow')}</button>
      <div class="sw"><Toggle label={$t('player.castRemote.autoplay')} checked={session.autoplay} on:change={(e) => castEngine.setAutoplay(e.detail)} /></div>
    </div>
  </section>
{/if}

<style>
  .un { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 6px 14px; align-items: center; padding: 14px; }
  .compact { grid-template-columns: 96px minmax(0, 1fr); padding: 12px 14px; }
  .thumb { grid-row: 1; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: #1c2228; display: grid; place-items: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph { color: #9aa4ad; }
  .txt { display: grid; gap: 2px; min-width: 0; }
  .eyebrow { margin: 0; font-size: .78rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #ff8aa0; }
  .unt { font-size: 1rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mut { color: rgba(255, 255, 255, .72); font-size: .9rem; }
  .acts { grid-column: 1 / -1; display: grid; gap: 6px; margin-top: 4px; }
  .go { white-space: nowrap; }
  .sw { min-width: 0; }
  .sw :global(.tgl) { align-items: center; }
  .sw :global(label) { font-size: .88rem; line-height: 1.2; color: #fff; }
</style>
