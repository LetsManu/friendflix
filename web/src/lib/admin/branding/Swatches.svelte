<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The accent of Admin → Branding: six presets (a radiogroup of 44 px swatches, arrow keys move the choice), the own colour as hex
   * text and the browser's colour picker, and the contrast readout of the derived tokens (model.ts ratioRows: accent text on the dark
   * page, white on the buttons, accent text on light glass; "angepasst" when a shade had to move). The error line keeps its room.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import type { BrandTokens } from '#lib/brandColors';
  import { PRESETS, normalizeAccent, ratioRows, ratioText } from './model';

  /** the staged accent as typed */
  export let value: string;
  /** the tokens of the last valid accent */
  export let tokens: BrandTokens;
  export let error = '';
  const dispatch = createEventDispatcher<{ change: string }>();

  $: hex = normalizeAccent(value);
  $: rows = ratioRows(tokens);
  $: pickerValue = hex ?? tokens.acc;
  let btns: HTMLButtonElement[] = [];
  $: current = PRESETS.findIndex((p) => p.hex === hex);

  function key(e: KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + PRESETS.length) % PRESETS.length;
    btns[j]?.focus();
    dispatch('change', PRESETS[j]!.hex);
  }
  const LABELS = { text: 'admin.branding.colors.ratioText', fill: 'admin.branding.colors.ratioFill', glass: 'admin.branding.colors.ratioGlass' } as const;
  const label = (id: keyof typeof LABELS) => LABELS[id];
</script>

<div class="acc">
  <span class="lab" id="bf-accent-l">{$t('admin.branding.colors.accent')}</span>
  <div class="row">
    <div class="sws" role="radiogroup" aria-labelledby="bf-accent-l">
      {#each PRESETS as p, i (p.id)}
        <!-- the tab stop: the chosen preset, or the first when the colour is an own one -->
        <button type="button" class="sw" class:on={i === current} role="radio" aria-checked={i === current} aria-label={$t(`admin.branding.colors.presets.${p.id}`)}
          tabindex={i === current || (current < 0 && i === 0) ? 0 : -1} style:background={p.hex} bind:this={btns[i]}
          on:click={() => dispatch('change', p.hex)} on:keydown={(e) => key(e, i)}>
          <span class="chk" class:shown={i === current}><Icon name="check" size={20} /></span>
        </button>
      {/each}
    </div>
    <div class="own field" class:has-err={!!error}>
      <label class="sr-only" for="bf-accent">{$t('admin.branding.colors.hex')}</label>
      <input id="bf-accent" type="text" class="hex" value={value} maxlength={16} spellcheck="false" autocomplete="off" aria-invalid={error ? 'true' : undefined}
        aria-describedby="bf-accent-m" on:input={(e) => dispatch('change', e.currentTarget.value)} />
      <input type="color" class="pick" value={pickerValue} aria-label={$t('admin.branding.colors.picker')} on:input={(e) => dispatch('change', e.currentTarget.value)} />
    </div>
  </div>
  <p class="msg" id="bf-accent-m">{#if error}<span class="err" role="alert">{error}</span>{/if}</p>
  <ul class="ratios" aria-label={$t('admin.branding.colors.contrast')}>
    {#each rows as r (r.id)}
      <li class:adj={r.adjusted}>
        <span class="ic" aria-hidden="true"><Icon name={r.adjusted ? 'alert' : 'check'} size={18} /></span>
        <span class="rl">{$t(label(r.id))}</span>
        <span class="rv">{ratioText(r.ratio)}{#if r.adjusted}{` · ${$t('admin.branding.colors.adjusted')}`}{/if}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .acc { display: grid; gap: .5rem; min-width: 0; }
  .lab { font-size: .9rem; font-weight: 700; color: rgba(255, 255, 255, .85); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
  .sws { display: flex; flex-wrap: wrap; gap: 10px; }
  .sw { width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; border: 2px solid transparent; display: grid; place-items: center; color: #fff; }
  .sw.on { border-color: #fff; }
  .sw:hover:not(:disabled) { filter: none; }
  .chk { display: grid; opacity: 0; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .6)); }
  .chk.shown { opacity: 1; }
  .own { display: flex; flex-direction: row; gap: 8px; align-items: center; }
  .hex { width: 8.5rem; font-variant-numeric: tabular-nums; }
  .pick { width: 44px; height: 44px; min-height: 44px; padding: 2px; border-radius: 12px; cursor: pointer; background: rgba(var(--fr-scrim-rgb), .35); border: 1px solid var(--fr-line); }
  .msg { margin: 0; min-height: 1.35em; font-size: .85rem; }
  .err { color: var(--err); font-weight: 600; }
  .ratios { list-style: none; margin: .2rem 0 0; padding: 0; display: grid; gap: .35rem; }
  .ratios li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 24px; font-size: .88rem; color: rgba(255, 255, 255, .85); }
  .ic, .rv { color: var(--ok); }
  .adj .ic, .adj .rv { color: var(--warn); }
  .rv { font-variant-numeric: tabular-nums; font-weight: 700; white-space: nowrap; }
</style>
