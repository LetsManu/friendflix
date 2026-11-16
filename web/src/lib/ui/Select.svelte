<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  export interface SelectOption { value: string; label: string; disabled?: boolean }
</script>

<script lang="ts">
  /**
   * Labelled native <select> (keyboard/TV friendly) with hint and error. The native select stays the control (form value,
   * `bind:value`, `on:change`, Playwright's selectOption); on a desktop pointer its system picker is replaced by the glass listbox
   * (GlassListbox: a press or Space / Enter / F4 / Alt+Arrow opens it; a pick sets the select's value and fires `input` and
   * `change` like the picker would). Phones and TV keep the system picker.
   *   <Select label={$t('admin.users.role')} bind:value={role} options={[{ value: 'friend', label: 'Freund' }]} on:change={save} />
   */
  import { onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import GlassListbox from './GlassListbox.svelte';
  import { uid } from './ids';
  import { wantsGlassList } from './listbox';
  export let label: string;
  export let value = '';
  export let options: SelectOption[] = [];
  export let hint = '';
  export let error = '';
  export let disabled = false;
  export let hideLabel = false;
  export let id = uid('sel');
  let sel: HTMLSelectElement;
  let listOpen = false, picking = false;
  /** this select uses the glass list (desktop pointer): it says whether the list is open (aria-expanded) */
  let glassy = false;
  const listId = `${id}-lb`;
  $: if (disabled) listOpen = false;

  /** the glass list only on a desktop pointer (asked at each open: a tablet can gain or lose its mouse) */
  const glass = (): boolean => typeof matchMedia !== 'undefined' && wantsGlassList({
    tv: document.documentElement.classList.contains('tv'),
    coarse: matchMedia('(pointer: coarse)').matches,
    hover: matchMedia('(hover: hover) and (pointer: fine)').matches,
  });
  function onDown(e: MouseEvent) {
    if (e.button !== 0 || disabled || !(glassy = glass())) return;
    e.preventDefault(); // no system picker
    sel.focus({ preventScroll: true });
    listOpen = !listOpen;
  }
  function onKey(e: KeyboardEvent) {
    if (disabled || listOpen) return;
    const k = e.key, plain = !e.altKey && !e.ctrlKey && !e.metaKey;
    if ((plain && (k === ' ' || k === 'Enter' || k === 'F4')) || (e.altKey && (k === 'ArrowDown' || k === 'ArrowUp'))) {
      if (!(glassy = glass())) return;
      e.preventDefault();
      listOpen = true;
    }
  }
  /** a pick: the select gets the value and fires what its own picker fires (nothing when the value stays) */
  function pick(v: string) {
    listOpen = false;
    sel.focus({ preventScroll: true });
    if (sel.value === v) return;
    picking = true;
    sel.value = v;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    picking = false;
  }
  onMount(() => {
    glassy = glass();
    // a value set from elsewhere (the keyboard on the closed select, a script, a test's selectOption) closes the list
    const outside = () => { if (!picking) listOpen = false; };
    sel.addEventListener('input', outside);
    sel.addEventListener('change', outside);
    return () => { sel.removeEventListener('input', outside); sel.removeEventListener('change', outside); };
  });
  $: describedby = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
</script>

<div class="field" class:inline={hideLabel} class:has-err={!!error}>
  <label for={id} id="{id}-l" class:sr-only={hideLabel}>{label}</label>
  <span class="wrap">
    <select {id} bind:this={sel} bind:value {disabled} aria-describedby={describedby} aria-invalid={error ? 'true' : undefined}
      aria-expanded={glassy ? listOpen : undefined} aria-controls={listOpen ? listId : undefined} on:mousedown={onDown} on:keydown={onKey} on:change>
      {#each options as o (o.value)}<option value={o.value} disabled={o.disabled}>{o.label}</option>{/each}
    </select>
    <span class="chev" aria-hidden="true"><Icon name="chevron-down" size={16} /></span>
  </span>
  {#if listOpen}
    <GlassListbox anchor={sel} {options} value={value ?? ''} labelledby="{id}-l" id={listId} on:pick={(e) => pick(e.detail)} on:close={() => (listOpen = false)} />
  {/if}
  {#if hint}<span class="hint" id="{id}-h">{hint}</span>{/if}
  {#if error}<span class="error" id="{id}-e" role="alert">{error}</span>{/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
  .wrap { position: relative; display: block; }
  select { width: 100%; appearance: none; -webkit-appearance: none; padding-right: 2.2rem; cursor: pointer; }
  .chev { position: absolute; right: .7rem; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--mut); }
  .hint { font-size: .82rem; color: var(--hint, var(--mut)); overflow-wrap: anywhere; } /* long example URLs wrap at 320 px */
  .error { font-size: .85rem; color: var(--err); font-weight: 600; }
  /* the dense glass admin's look for this field: app.css (.adm .field), shared with Field */
</style>
