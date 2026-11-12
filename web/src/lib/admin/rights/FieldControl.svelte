<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The editor of one right (spec §6.1): a switch (`Toggle`), a number (`Field`, plus "Unbegrenzt" where the field allows no cap),
   * a `Select` with presets (age rating, resolution, bitrate) or the library checklist. `change` carries the new value in the
   * matrix's own encoding (null = no cap, 'all' | names for libraries, bit/s); an out-of-range number is not sent.
   * Used by the role matrix's cell popover, the role sheet and the person's Rechte tab.
   *   <FieldControl {field} value={v} libraries={m.libraries} on:change={(e) => stage(e.detail)} />
   */
  import { createEventDispatcher } from 'svelte';
  import { locale, t, tr } from '#lib/i18n';
  import Field from '#lib/ui/Field.svelte';
  import Select, { type SelectOption } from '#lib/ui/Select.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { uid } from '#lib/ui/ids';
  import { cellText, fieldLabel, type MatrixField } from './model';

  export let field: MatrixField;
  export let value: unknown;
  /** a number field's hint of the value that applies without one (e.g. the role's value behind a person's override) */
  export let placeholder: unknown = undefined;
  export let libraries: Array<{ id: string; name: string }> = [];
  /** a name other than the field's (the compare view names each control after its role) */
  export let name: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ change: unknown }>();
  const id = uid('fc');
  /** bitrate presets in Mbit/s (within the field's min / max) */
  const MBIT = [1, 2, 4, 8, 12, 20, 40, 60, 80, 120, 200];

  $: label = name ?? ($locale && fieldLabel(field.key)); // $locale: follows a language switch

  // ---- presets (age rating, resolution, bitrate): '' stands for null (no cap)
  const enc = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  function presets(f: MatrixField, cur: unknown, _tf: unknown): SelectOption[] {
    let vals: Array<number | null> = f.kind === 'bitrate'
      ? MBIT.map((m) => m * 1_000_000).filter((b) => (f.min === undefined || b >= f.min) && (f.max === undefined || b <= f.max))
      : [...(f.options ?? [])];
    const c = typeof cur === 'number' || cur === null ? cur : undefined;
    if (c !== undefined && !vals.includes(c)) vals = [...vals, c].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
    return vals.map((v) => ({ value: enc(v), label: cellText(f, v) }));
  }
  $: options = field.kind === 'rating' || field.kind === 'height' || field.kind === 'bitrate' ? presets(field, value, $t) : [];
  $: picked = enc(value);
  const pick = (e: Event) => { const v = (e.target as HTMLSelectElement).value; dispatch('change', v === '' ? null : Number(v)); };

  // ---- numbers
  $: noCap = field.kind === 'int' && (field.options ?? []).includes(null);
  $: unlimited = value === null || value === undefined || value === 'unlimited';
  let num: number | string | null = null, shown: unknown = Symbol('none'), err = '';
  $: if (value !== shown) { shown = value; num = typeof value === 'number' ? value : null; err = ''; }
  function typed(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    const n = Number(raw);
    const lo = field.min ?? 0, hi = field.max ?? Number.MAX_SAFE_INTEGER;
    if (raw.trim() === '' || !Number.isInteger(n) || n < lo || n > hi) { err = tr('adminPeople.roles.errRange', { min: lo, max: hi }); return; }
    err = '';
    shown = n;
    dispatch('change', n);
  }
  function capOff(e: CustomEvent<boolean>) {
    if (e.detail) { dispatch('change', null); return; }
    const n = typeof num === 'number' ? num : Number(num);
    dispatch('change', Number.isInteger(n) && num !== null && num !== '' ? n : (field.min ?? 0));
  }

  // ---- libraries: 'all' or the chosen names (names the server no longer has stay listed, so they can be removed). At least one
  // stays ticked (the role write refuses an empty list): the last ticked box is disabled, with the hint saying why.
  $: all = value === 'all' || value === null || value === undefined;
  $: chosen = Array.isArray(value) ? (value as string[]) : [];
  $: names = [...libraries.map((l) => l.name), ...chosen.filter((n) => !libraries.some((l) => l.name === n))];
  const allToggled = (e: Event) => dispatch('change', (e.currentTarget as HTMLInputElement).checked ? 'all' : [...names]);
  $: lastOne = !all && chosen.length === 1 ? chosen[0] : null;
  const libToggled = (name: string, on: boolean) => {
    const next = on ? [...chosen, name] : chosen.filter((n) => n !== name);
    if (next.length) dispatch('change', next);
  };
</script>

<div class="fc">
  {#if field.kind === 'bool'}
    <Toggle {label} checked={Boolean(value)} on:change={(e) => dispatch('change', e.detail)} />
  {:else if field.kind === 'int'}
    {#if noCap}<Toggle label={$t('adminPeople.roles.unlimited')} checked={unlimited} on:change={capOff} />{/if}
    <Field {label} type="number" min={field.min} max={field.max} step={1} value={num} error={err} disabled={noCap && unlimited}
      placeholder={placeholder === undefined || placeholder === null ? '' : String(placeholder)} on:input={typed} />
  {:else if field.kind === 'libraries'}
    <fieldset class="libs">
      <legend>{label}</legend>
      <label class="chk all"><input type="checkbox" checked={all} disabled={all && !names.length} on:change={allToggled} /><span>{$t('adminPeople.roles.allLibraries')}</span></label>
      {#each names as n, i (n)}
        <label class="chk" for="{id}-{i}"><input id="{id}-{i}" type="checkbox" checked={all || chosen.includes(n)} disabled={all || n === lastOne}
          aria-describedby={n === lastOne ? `${id}-min` : undefined} on:change={(e) => libToggled(n, e.currentTarget.checked)} /><span>{n}</span></label>
      {/each}
      <!-- the hint's line is always there (nothing moves when it appears) -->
      <p class="min" id="{id}-min" aria-hidden={lastOne === null ? 'true' : undefined}>{lastOne === null ? '' : $t('adminPeople.roles.libsMin')}</p>
    </fieldset>
  {:else}
    <Select {label} {options} value={picked} on:change={pick} />
  {/if}
</div>

<style>
  .fc { display: flex; flex-direction: column; gap: .7rem; min-width: 0; }
  .libs { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  legend { padding: 0; margin-bottom: .35rem; font-size: .95rem; color: var(--fg); }
  .chk { display: flex; align-items: center; gap: .7rem; min-height: 44px; padding: 0 .5rem; border-radius: 10px; cursor: pointer; }
  .chk.all { font-weight: 600; }
  .chk input { width: 20px; height: 20px; margin: 0; accent-color: var(--acc); flex: none; }
  .chk:has(input:disabled) { cursor: default; color: var(--mut); }
  .chk span { min-width: 0; overflow-wrap: anywhere; }
  /* two lines of room: the hint wraps in the 300 px popover (German, Polish), and the popover never grows when it appears */
  .min { margin: .2rem .5rem 0; line-height: 1.35; height: calc(2 * 1.35em); font-size: .82rem; color: var(--hint, var(--mut)); }
</style>
