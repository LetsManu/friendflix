<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The three choices of the media server (spec "Admin and wizard"), shared by the Admin card *Medienserver* and the wizard's step 3:
   * *Ferrofin (eigener)* with *Test* while it is a trial, *Jellyfin (offiziell, verwaltet)*, *Bestehender Jellyfin/Plex (Adresse)*
   * (on Plex the labels come from serverText.plex). One radiogroup with a roving tabindex; the arrow keys move to the next choice that
   * can be taken. A choice that cannot be taken is disabled (unless the server is on it) and the line below says why (model.ts
   * choiceDisabled / reasonText), with the trial note and its docs link. The parent owns the choice: `pick` asks for it.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import type { MediaView } from './api';
  import { CHOICES, DOCS_HREF, TRIAL_KINDS, choiceDisabled, currentChoice, reasonText, type Choice } from './model';

  export let view: MediaView;
  export let choice: Choice;
  /** the id of the reasons line (the disabled choices point at it) */
  export let reasonsId = 'ms-reasons';
  const dispatch = createEventDispatcher<{ pick: Choice }>();

  /** a disabled choice, unless it is the one the server is on */
  const off = (v: MediaView, c: Choice) => c !== currentChoice(v) && Boolean(choiceDisabled(v, c));
  let btns: HTMLButtonElement[] = [];
  function key(e: KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    for (let k = 1; k <= CHOICES.length; k++) {
      const j = (i + d * k + CHOICES.length * 3) % CHOICES.length;
      if (!off(view, CHOICES[j]!)) { dispatch('pick', CHOICES[j]!); btns[j]?.focus(); return; }
    }
  }
  $: reasons = [...new Set((['ferrofin', 'jellyfin'] as const).map((k) => choiceDisabled(view, k)).filter((r): r is NonNullable<typeof r> => r !== null))];
</script>

<div class="seg" role="radiogroup" aria-label={$t('mediaserver.choice.label')} data-testid="media-choice">
  {#each CHOICES as c, i (c)}
    {@const disabled = off(view, c)}
    <button type="button" role="radio" aria-checked={choice === c} tabindex={choice === c ? 0 : -1} class:on={choice === c} {disabled} data-choice={c}
      aria-describedby={disabled ? reasonsId : undefined} bind:this={btns[i]} on:click={() => dispatch('pick', c)} on:keydown={(e) => key(e, i)}>
      <span class="lbl">{$t(`mediaserver.choice.${c}`)}</span>
      {#if c !== 'external' && TRIAL_KINDS.includes(c)}<span class="badge">{$t('mediaserver.choice.trial')}</span>{/if}
    </button>
  {/each}
</div>
<div id={reasonsId} class="reasons" data-testid="media-reasons">
  {#each reasons as r (r)}<p><Icon name="info" size={16} />{reasonText(r)}</p>{/each}
  {#if TRIAL_KINDS.length}<p class="muted">{$t('mediaserver.choice.trialNote')} <a href={DOCS_HREF} target="_blank" rel="noopener noreferrer">{$t('mediaserver.choice.trialDocs')}</a></p>{/if}
</div>

<style>
  /* glass tiles in one row, stacked on a phone; the selected one is marked by an overlay that only fades */
  .seg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 4px; border-radius: var(--fr-r-tile); border: 1px solid var(--line); background: rgba(255, 255, 255, .04); }
  .seg button { position: relative; min-height: 44px; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .3rem .5rem; padding: .45rem .7rem; border-radius: 14px;
    background: transparent; color: var(--mut); font-weight: 600; text-align: center; isolation: isolate; }
  .seg button::before { content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: rgba(var(--acc-rgb), .22); box-shadow: inset 0 0 0 1px var(--acc-line); opacity: 0; transition: opacity .2s ease; }
  .seg button.on { color: var(--fg); }
  .seg button.on::before { opacity: 1; }
  .seg button:hover:not(:disabled):not(.on) { color: var(--fg); background: rgba(255, 255, 255, .06); }
  .seg button:disabled { opacity: .55; cursor: not-allowed; }
  .lbl { overflow-wrap: anywhere; }
  .badge { padding: .05rem .5rem; border-radius: var(--fr-r-pill); background: var(--acc-fill); color: #fff; font-size: .72rem; font-weight: 700; }
  .reasons { display: grid; gap: .25rem; margin: .5rem 0 .8rem; font-size: .88rem; }
  .reasons p { display: flex; align-items: flex-start; gap: .4rem; margin: 0; }
  .reasons :global(svg) { flex: none; margin-top: .15rem; color: var(--info-mark); }
  .reasons a { text-decoration: underline; }
  @media (max-width: 720px) {
    .seg { grid-template-columns: minmax(0, 1fr); }
    .seg button { justify-content: flex-start; text-align: left; }
  }
  @media (prefers-reduced-motion: reduce) { .seg button::before { transition: none; } }
</style>
