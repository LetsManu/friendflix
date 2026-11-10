<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The "Wünschen" button for one title that is not in the library. States: none (coral button), pending (spinner, disabled),
   * requested / in progress / available (calm status), quota used up (disabled, with the day the quota renews) and error (the
   * message inline and a retry). A wish counts as made only after the server answered; the result is announced politely.
   * Never render it for kids profiles or without a request service (the page decides; the server refuses them as well).
   */
  import { tick } from 'svelte';
  import { fmtDate, t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { quotaExhausted, type WishState } from '#lib/newpage';
  import { quota, submitWish, wishKey, wished, wishView } from '#lib/requests/wish';
  import { features } from '#lib/capabilities';

  export let mediaType: 'movie' | 'tv';
  export let tmdbId: number;
  export let title: string;
  /** what the server says about the title (a suggestion carries it) */
  export let state: WishState = 'none';
  /** the button fills its container's width */
  export let block = false;

  let local: 'idle' | 'pending' | 'error' = 'idle';
  let said = '';
  let off = false;
  let root: HTMLElement;
  $: view = wishView({ server: state, local, wished: $wished.has(wishKey(mediaType, tmdbId)), exhausted: quotaExhausted($quota) });
  $: resets = $quota?.resetsAt ? fmtDate($quota.resetsAt, { day: 'numeric', month: 'long' }) : '';

  async function wish() {
    if (local === 'pending') return;
    const had = root.contains(document.activeElement);
    local = 'pending'; said = '';
    const r = await submitWish(mediaType, tmdbId);
    if (r.kind === 'requested') { local = 'idle'; said = $t('home.wish.done', { title }); }
    else if (r.kind === 'exists') { local = 'idle'; said = $t('home.wish.already', { title }); }
    else if (r.kind === 'limit') { local = 'idle'; said = `${$t('home.wish.exhausted')}. ${$t('home.wish.resetsAt', { date: fmtDate(r.resetsAt, { day: 'numeric', month: 'long' }) })}`; }
    else {
      local = 'error';
      if (r.disabled) { off = true; features.update((f) => ({ ...f, requests: false })); }
      said = r.disabled ? $t('home.wish.disabled') : $t('home.wish.failed');
    }
    // every state is its own element: a keyboard user's focus follows the button to the state that replaced it
    if (had) { await tick(); root?.querySelector<HTMLElement>('button:not([aria-disabled="true"]), [data-focus]')?.focus(); }
  }
</script>

<div class="rb" class:block bind:this={root}>
  {#if view === 'none' || view === 'pending'}
    <!-- one element for both: the focus stays on it while the wish is on its way -->
    <button type="button" class="pill go" aria-disabled={view === 'pending' ? 'true' : undefined} aria-busy={view === 'pending' ? 'true' : undefined}
      aria-label={view === 'pending' ? $t('home.wish.pending') : $t('home.wish.named', { title })} on:click={wish}>
      {#if view === 'pending'}<span class="spin" aria-hidden="true"></span><span>{$t('home.wish.pending')}</span>{:else}<Icon name="plus" size={18} /><span>{$t('home.wish.none')}</span>{/if}
    </button>
  {:else if view === 'requested' || view === 'processing' || view === 'available'}
    <span class="st ok" tabindex="-1" data-focus><Icon name="check" size={18} /><span>{$t(view === 'requested' ? 'home.wish.requested' : view === 'processing' ? 'home.wish.processing' : 'home.wish.available')}</span></span>
  {:else if view === 'exhausted'}
    <button type="button" class="pill off" aria-disabled="true" data-focus aria-label={`${$t('home.wish.exhausted')}: ${title}`}><span>{$t('home.wish.exhausted')}</span></button>
    {#if resets}<small class="note">{$t('home.wish.resetsAt', { date: resets })}</small>{/if}
  {:else}
    <p class="err" role="alert" tabindex="-1" data-focus>{said || $t('home.wish.failed')}</p>
    {#if !off}<button type="button" class="pill retry" aria-label={$t('home.wish.retryNamed', { title })} on:click={wish}><span>{$t('home.wish.retry')}</span></button>{/if}
  {/if}
  <span class="sr-only" role="status" aria-live="polite">{view === 'error' ? '' : said}</span>
</div>

<style>
  .rb { display: flex; flex-direction: column; align-items: flex-start; gap: .3rem; min-width: 0; }
  .rb.block { align-items: stretch; }
  button, .st { min-height: 44px; box-sizing: border-box; border-radius: 999px; font-size: .95rem; font-weight: 800; padding: 0 1.2rem; display: inline-flex; align-items: center; justify-content: center; gap: .45rem; white-space: nowrap; }
  .go { background: var(--acc-fill); color: #fff; }
  .go[aria-disabled='true'] { opacity: 1; cursor: default; background: var(--acc-fill); filter: saturate(.6); }
  .st.ok { background: rgba(74, 222, 128, .12); color: var(--ok, #4ade80); box-shadow: inset 0 0 0 1px rgba(74, 222, 128, .5); }
  .off, .off:hover { opacity: 1; background: rgba(255, 255, 255, .08); color: rgba(255, 255, 255, .86); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .3); cursor: default; }
  .retry { background: rgba(255, 255, 255, .12); color: #fff; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35); }
  .note { font-size: .8rem; color: var(--mut); text-align: center; line-height: 1.3; }
  .err { margin: 0; font-size: .85rem; line-height: 1.3; color: var(--err, #ffa8a8); }
  button:focus-visible, [data-focus]:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .35); border-top-color: #fff; animation: rb-spin .8s linear infinite; }
  @keyframes rb-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
</style>
