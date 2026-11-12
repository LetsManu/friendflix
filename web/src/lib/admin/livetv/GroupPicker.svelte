<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The group picker under the *Prüfen* result (spec §9.1): "18 Gruppen gefunden – welche übernehmen?", a search field from 12 groups
   * on, *Alle* / *Keine* (they act on the shown groups only), one checkbox row per group with its channel count, the counter line
   * "312 von 412 Sendern werden übernommen" and the note that new groups stay hidden. The list has a fixed height with its own scroll,
   * and the counter line a fixed height, so ticking and searching never move anything around it. The state is the pure `PickerState`
   * of picker.ts (a skip list: unticked groups).
   */
  import { t } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import { SEARCH_FROM, setAll, shownGroups, toggle, totals, type PickerState } from './picker';

  export let state: PickerState;

  const id = uid('gp');
  $: shown = shownGroups(state);
  $: sum = totals(state);
  $: searchable = state.groups.length >= SEARCH_FROM;
  let q = state.q;
  $: if (q !== state.q) state = { ...state, q };
</script>

<section class="gp" aria-labelledby="{id}-t" data-picker>
  <h3 id="{id}-t">{$t('adminLive.src.pick.title', { n: state.groups.length })}</h3>

  <div class="bar">
    {#if searchable}
      <div class="find"><Field label={$t('adminLive.src.pick.search')} hideLabel type="search" placeholder={$t('adminLive.src.pick.search')} bind:value={q} /></div>
    {/if}
    <Button variant="secondary" size="sm" on:click={() => (state = setAll(state, true))}>{$t('adminLive.src.pick.all')}</Button>
    <Button variant="secondary" size="sm" on:click={() => (state = setAll(state, false))}>{$t('adminLive.src.pick.none')}</Button>
  </div>

  <!-- the list's height is fixed: ticking, searching and a short list never move what is below -->
  <div class="list" role="group" aria-labelledby="{id}-t" data-picker-list>
    {#each shown as g (g.name)}
      <label class="row">
        <input type="checkbox" checked={!state.skipped.has(g.name)} on:change={() => (state = toggle(state, g.name))} />
        <span class="txt">{g.name} <span class="ct">· {$t('adminLive.src.pick.count', { n: g.channels })}</span></span>
      </label>
    {:else}
      <p class="none">{$t('adminLive.src.pick.empty')}</p>
    {/each}
  </div>

  <p class="total" aria-live="polite" data-picker-total>{$t('adminLive.src.pick.total', { m: sum.picked, n: sum.total })}</p>
  <p class="note"><Rich key="adminLive.src.pick.hiddenNote" /></p>
  {#if state.kept.length > 0}<p class="note" data-picker-kept>{$t('adminLive.src.pick.kept', { n: state.kept.length })}</p>{/if}
</section>

<style>
  .gp { display: flex; flex-direction: column; gap: .6rem; min-width: 0; border-top: 1px solid rgba(255, 255, 255, .12); padding-top: .9rem; }
  h3 { margin: 0; font-size: 1rem; font-weight: 800; overflow-wrap: anywhere; }
  .bar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .find { flex: 1 1 10rem; min-width: 0; }
  .bar :global(.ui-btn) { min-height: 44px; }
  .list { height: 20rem; overflow-y: auto; overscroll-behavior: contain; border: 1px solid rgba(255, 255, 255, .2); border-radius: 12px; padding: 4px 10px; }
  .row { display: flex; align-items: center; gap: .7rem; min-height: 44px; cursor: pointer; }
  .row input { flex: none; }
  .txt { min-width: 0; overflow-wrap: anywhere; }
  .ct { color: rgba(255, 255, 255, .8); white-space: nowrap; }
  .none { margin: .8rem 0; color: rgba(255, 255, 255, .85); }
  /* one line is always reserved, even in a language that needs two */
  .total { margin: 0; font-weight: 700; min-height: 2.6em; overflow-wrap: anywhere; }
  .note { margin: 0; font-size: .85rem; color: rgba(255, 255, 255, .85); overflow-wrap: anywhere; }
</style>
