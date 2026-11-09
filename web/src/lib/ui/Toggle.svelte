<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * On/off switch (button role=switch, Space/Enter toggle; 44px target).
   *   <Toggle label={$t('…')} bind:checked={enabled} hint="…" on:change={(e) => save(e.detail)} />
   */
  import { createEventDispatcher } from 'svelte';
  import { uid } from './ids';
  export let label: string;
  export let checked = false;
  export let disabled = false;
  export let hint = '';
  /** the label stays the accessible name but is not shown (e.g. a switch inside a table row) */
  export let hideLabel = false;
  /** shows a spinner and blocks input while a save runs */
  export let pending = false;
  export let id = uid('tgl');
  const dispatch = createEventDispatcher<{ change: boolean }>();
  function flip() {
    if (disabled || pending) return;
    checked = !checked;
    dispatch('change', checked);
  }
</script>

<div class="tgl">
  <button type="button" {id} role="switch" class="sw" class:on={checked} aria-checked={checked} {disabled} aria-busy={pending ? 'true' : undefined}
    aria-labelledby="{id}-l" aria-describedby={hint ? `${id}-h` : undefined} on:click={flip}>
    <span class="knob">{#if pending}<span class="spinner" aria-hidden="true"></span>{/if}</span>
  </button>
  <span class="txt"><label id="{id}-l" for={id} class:sr-only={hideLabel}>{label}</label>{#if hint}<span class="hint" id="{id}-h">{hint}</span>{/if}</span>
</div>

<style>
  .tgl { display: flex; align-items: flex-start; gap: .75rem; min-width: 0; }
  .sw { flex: none; width: 52px; min-height: 44px; padding: 0; background: transparent; position: relative; border-radius: 99px; }
  /* the settings page's switch (glass spec §6): a 46×28 track, white .18 with the glass line when off, coral when on; the
     knob travels 18 px (settings/+page.svelte .sw-tr) */
  .sw::before { content: ''; position: absolute; left: 3px; right: 3px; top: 50%; height: 28px; transform: translateY(-50%); border-radius: 99px; background: rgba(255, 255, 255, .18); box-shadow: inset 0 0 0 1px var(--fr-line); }
  .sw:hover:not(:disabled) { background: transparent; }
  .sw.on::before { background: var(--acc); box-shadow: none; }
  .knob { position: absolute; top: 50%; left: 6px; width: 22px; height: 22px; margin-top: -11px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .35); display: grid; place-items: center; color: #2b333c; font-size: .7rem; transition: transform 300ms var(--fr-spring); }
  .on .knob { transform: translateX(18px); }
  :global(html.m-still) .knob { transition: none; }
  .txt { display: flex; flex-direction: column; padding-top: .55rem; min-width: 0; }
  label { color: var(--fg); font-size: .95rem; cursor: pointer; }
  .hint { font-size: .82rem; color: var(--hint, var(--mut)); overflow-wrap: anywhere; } /* long example URLs wrap at 320 px */
</style>
