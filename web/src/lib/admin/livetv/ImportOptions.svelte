<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The *Import* section of the source sheet (spec §9.1): how channel numbers are made (*Aus der Liste (tvg-chno)* or *Nach Reihenfolge
   * ab* with the first number, `numbering` / `numberBase`), which logo comes first (`logoPref`) and the programme-time offset in
   * 30-minute steps (`epgShiftMin`, −12…+14 h). Each choice has its help line. The first-number field and its error line keep their
   * room whatever is chosen, so nothing below moves. The two choices are radio groups (arrow keys move and select), the stepper's
   * buttons are 44 px targets.
   */
  import { t } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import type { LogoPref, Numbering } from './api';
  import { SHIFT_MAX, SHIFT_MIN, shiftLabel, stepShift } from './picker';

  export let numbering: Numbering = 'chno';
  /** the field's text; the sheet validates it (1–99 999) */
  export let numberBase = '1';
  export let logoPref: LogoPref = 'm3u';
  export let epgShiftMin = 0;
  export let baseErr = '';

  const id = uid('io');
  $: numberings = [{ value: 'chno' as const, label: $t('adminLive.src.numChno') }, { value: 'order' as const, label: $t('adminLive.src.numOrder') }];
  $: logos = [{ value: 'm3u' as const, label: $t('adminLive.src.logoM3u') }, { value: 'xmltv' as const, label: $t('adminLive.src.logoXmltv') }];

  /** a radio group: the arrow keys move the choice (and the focus) like native radios */
  function segKey(e: KeyboardEvent, count: number, index: number, pick: (i: number) => void) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const to = (index + d + count) % count;
    pick(to);
    const row = (e.currentTarget as HTMLElement).parentElement;
    (row?.children[to] as HTMLElement | undefined)?.focus();
  }
</script>

<section class="imp" aria-labelledby="{id}-h">
  <h3 id="{id}-h">{$t('adminLive.src.import')}</h3>

  <div class="ctl" role="group" aria-labelledby="{id}-n">
    <span class="lbl" id="{id}-n">{$t('adminLive.src.numbering')}</span>
    <div class="seg" role="radiogroup" aria-labelledby="{id}-n">
      {#each numberings as o, i (o.value)}
        <button type="button" role="radio" aria-checked={numbering === o.value} tabindex={numbering === o.value ? 0 : -1} class:on={numbering === o.value}
          on:click={() => (numbering = o.value)} on:keydown={(e) => segKey(e, numberings.length, i, (k) => (numbering = numberings[k]!.value))}>{o.label}</button>
      {/each}
    </div>
    <!-- the field keeps its room when the list's own numbers are chosen -->
    <div class="base" class:gone={numbering !== 'order'}>
      <Field label={$t('adminLive.src.numBase')} type="number" bind:value={numberBase} min={1} max={99999} step={1} width="8rem" error={baseErr} />
    </div>
    <p class="help"><Rich key="adminLive.src.numKeep" /></p>
  </div>

  <div class="ctl" role="group" aria-labelledby="{id}-l">
    <span class="lbl" id="{id}-l">{$t('adminLive.src.logoPref')}</span>
    <div class="seg" role="radiogroup" aria-labelledby="{id}-l">
      {#each logos as o, i (o.value)}
        <button type="button" role="radio" aria-checked={logoPref === o.value} tabindex={logoPref === o.value ? 0 : -1} class:on={logoPref === o.value}
          on:click={() => (logoPref = o.value)} on:keydown={(e) => segKey(e, logos.length, i, (k) => (logoPref = logos[k]!.value))}>{o.label}</button>
      {/each}
    </div>
    <p class="help">{$t('adminLive.src.logoOwn')}</p>
  </div>

  <div class="ctl" role="group" aria-labelledby="{id}-s">
    <span class="lbl" id="{id}-s">{$t('adminLive.src.epgShift')}</span>
    <div class="step">
      <button type="button" class="sb" aria-label={$t('adminLive.src.shiftLess')} title={$t('adminLive.src.shiftLess')} disabled={epgShiftMin <= SHIFT_MIN}
        on:click={() => (epgShiftMin = stepShift(epgShiftMin, -1))}><span aria-hidden="true">−</span></button>
      <output class="val" data-shift aria-live="polite">{shiftLabel(epgShiftMin)}</output>
      <button type="button" class="sb" aria-label={$t('adminLive.src.shiftMore')} title={$t('adminLive.src.shiftMore')} disabled={epgShiftMin >= SHIFT_MAX}
        on:click={() => (epgShiftMin = stepShift(epgShiftMin, 1))}><span aria-hidden="true">+</span></button>
    </div>
    <p class="help">{$t('adminLive.src.epgShiftHint')}</p>
  </div>
</section>

<style>
  .imp { display: flex; flex-direction: column; gap: 1rem; border-top: 1px solid rgba(255, 255, 255, .12); padding-top: .9rem; min-width: 0; }
  h3 { margin: 0; font-size: 1rem; font-weight: 800; }
  .ctl { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
  .lbl { display: block; font-size: .9rem; font-weight: 600; margin-bottom: .35rem; }
  .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid rgba(255, 255, 255, .2); border-radius: 22px; padding: 3px; gap: 3px; max-width: 100%; }
  .seg button { min-height: 44px; padding: .3rem 1rem; border-radius: 999px; background: transparent; border: 0; color: rgba(255, 255, 255, .8); font-weight: 600; }
  .seg button.on { background: #fff; color: #101418; }
  .seg button:not(.on):hover { color: #fff; }
  /* hidden, not removed: the first-number field and its error line keep their room */
  .base { margin-top: .6rem; width: 100%; }
  .base.gone { visibility: hidden; }
  .help { margin: .4rem 0 0; font-size: .85rem; color: rgba(255, 255, 255, .85); overflow-wrap: anywhere; }
  .step { display: inline-flex; align-items: center; gap: .3rem; border: 1px solid rgba(255, 255, 255, .2); border-radius: 22px; padding: 3px; }
  .sb { width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; border: 0; color: #fff; font-size: 1.4rem; font-weight: 700; line-height: 1; }
  .sb:hover:not(:disabled) { background: rgba(255, 255, 255, .12); }
  .sb:disabled { opacity: .4; }
  .val { min-width: 5.5rem; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
</style>
