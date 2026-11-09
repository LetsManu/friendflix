<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Renders lib/ui/toast.ts. Mounted once in the root layout; pages never mount it. Glass pills centred at the bottom (glass spec
   * §5): a status dot, the message, the action with its countdown ring (§8.5) and ✕. They rise in and slide out (toastRise).
   */
  import { flip } from 'svelte/animate';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { fxMode, toastRise } from '#lib/glass/fx';
  import { close, pause, resume, RING_LEN, runToastAction, timeLeft, toasts, type Toast } from './toast';
  let inside = false;
  function enter() { if (!inside) { inside = true; pause(); } }
  function leave(e?: FocusEvent) {
    const to = e?.relatedTarget as Node | null;
    if (e && to && (e.currentTarget as HTMLElement).contains(to)) return;
    if (inside) { inside = false; resume(); }
  }
  /** Escape closes the toast that has focus */
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-toast]');
    if (li) { e.stopPropagation(); close(Number(li.dataset.toast)); }
  }

  /**
   * The countdown ring's front circle: stroke-dashoffset runs from the time used to the full length over the time left (linear),
   * paused while the toasts are paused and restarted from the time left when they resume. Calm mode / reduced motion: no
   * animation, the ring stays full.
   */
  function ring(el: SVGCircleElement, p: { m: Toast; paused: boolean }) {
    let anim: Animation | null = null;
    function run({ m, paused }: { m: Toast; paused: boolean }) {
      if (typeof el.animate !== 'function' || fxMode() === 'still' || !m.duration) { anim?.cancel(); anim = null; return; }
      if (paused) { anim?.pause(); return; }
      if (anim?.playState === 'running') return; // the same countdown, still running
      anim?.cancel();
      const left = timeLeft(m.id);
      anim = el.animate([{ strokeDashoffset: RING_LEN * (1 - left / m.duration) }, { strokeDashoffset: RING_LEN }], { duration: Math.max(1, left), easing: 'linear', fill: 'forwards' });
    }
    run(p);
    return { update: run, destroy() { anim?.cancel(); } };
  }
  const flipMs = () => (fxMode() === 'full' ? 180 : 0);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (hover/focus pause the timers; Escape closes the focused toast) -->
<section class="toasts" aria-label={$t('ui.notifications')} on:mouseenter={enter} on:mouseleave={() => leave()} on:focusin={enter} on:focusout={leave} on:keydown={onKey}>
  <ol aria-live="polite" aria-relevant="additions text">
    {#each $toasts as m (m.id)}
      <li class="toast frost frost-pill frost-safe {m.kind}" animate:flip={{ duration: flipMs() }} in:toastRise={{ dir: 'in' }} out:toastRise={{ dir: 'out' }} data-toast={m.id}>
        <span class="dot {m.kind}" aria-hidden="true"></span>
        <p class="msg">{#if m.kind === 'error'}<span class="sr-only">{$t('ui.errorPrefix')} </span>{/if}{m.message}</p>
        {#if m.action}<button type="button" class="act" on:click={() => runToastAction(m.id)}>{m.action.label}</button>{/if}
        {#if m.action && m.duration}
          <svg class="ring" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false"><circle class="bg" cx="14" cy="14" r="11" /><circle class="fg" cx="14" cy="14" r="11" stroke-dasharray={RING_LEN} stroke-dashoffset="0" use:ring={{ m, paused: inside }} /></svg>
        {/if}
        <button type="button" class="x" aria-label={$t('ui.dismiss')} on:click={() => close(m.id)}><Icon name="x" size={18} /></button>
      </li>
    {/each}
  </ol>
</section>

<style>
  /* centred at the bottom on every layout (glass spec §5): 36 px up on desktop, above the tab bar on phones */
  .toasts { position: fixed; z-index: 120; left: 50%; transform: translateX(-50%); bottom: calc(36px + var(--castbar-h, 0px)); width: max-content; max-width: min(560px, calc(100vw - 2rem)); pointer-events: none; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; align-items: center; gap: .5rem; }
  .toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; max-width: 100%; box-sizing: border-box; padding: 4px 4px 4px 18px; min-height: 52px; font-weight: 700; }
  .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--mut); }
  .dot.success { background: var(--ok); box-shadow: 0 0 12px var(--ok); }
  .dot.error { background: var(--err); box-shadow: 0 0 12px var(--err); }
  .dot.info { background: var(--info); box-shadow: 0 0 12px var(--info); }
  .msg { flex: 1; margin: 0; font-size: .93rem; line-height: 1.35; overflow-wrap: anywhere; }
  .act { flex: none; min-height: 44px; background: transparent; color: #ff8aa0; padding: 0 8px; font-weight: 800; border-radius: var(--fr-r-pill); }
  .act:hover:not(:disabled) { background: var(--fr-sel); }
  .ring { flex: none; width: 28px; height: 28px; transform: rotate(-90deg); }
  .ring circle { fill: none; stroke-width: 3; }
  .ring .bg { stroke: rgba(255, 255, 255, .2); }
  .ring .fg { stroke: var(--acc, #ff4f6d); stroke-linecap: round; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; background: transparent; color: rgba(255, 255, 255, .8); border-radius: 50%; }
  .x:hover:not(:disabled) { background: var(--fr-sel); color: #fff; }
  @media (max-width: 720px) {
    /* above the phone tab bar (and the cast bar on it) */
    .toasts { bottom: calc(var(--tabbar-h) + var(--safe-bottom) + .6rem + var(--castbar-h, 0px)); }
  }
  :global(html.tv) .toasts { bottom: 2rem; }
</style>
