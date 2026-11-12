<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The bulk bar of the *Kanäle* list (spec §9.2): it rises (`barRise`) while channels are selected, as a floating glass bar above the
   * bottom edge (fixed, like the people page's save bar, so it moves nothing; the list pads its end meanwhile). It names the count and
   * offers *Ausblenden*, *Einblenden*, *Gruppe ändern…* and *Ab Nummer … durchnummerieren* (each opens a small prompt above the bar, an
   * overlay), *Überschreibungen zurücksetzen* and *Testen* (at most TEST_MAX channels at a time; more disables it and says so). The
   * bar only says what was chosen (events); the list sends it. Escape closes a prompt.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { barRise } from '#lib/glass/fx';
  import { SCRIM_BAR } from '#lib/glass/tone';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { TEST_MAX } from './channels';

  /** selected channels (by id, across pages) */
  export let count: number;
  export let groups: Array<{ id: string; name: string }> = [];
  /** a bulk call is running */
  export let busy = false;

  const dispatch = createEventDispatcher<{ hide: void; show: void; reset: void; test: void; clear: void; group: { groupId: string | null }; renumber: { from: number } }>();
  let prompt: 'group' | 'renumber' | null = null;
  let opener: HTMLElement | null = null;
  let groupId = '';
  /** the number field answers a number once it is filled (Field type number) */
  let first: string | number = '1';
  const MAX_NUMBER = 99_999;

  $: if (count === 0) prompt = null;
  $: firstText = String(first ?? '').trim();
  $: from = /^\d{1,5}$/.test(firstText) ? Number(firstText) : NaN;
  $: numberOk = from >= 1 && from + count - 1 <= MAX_NUMBER;
  $: groupOptions = [...groups.map((g) => ({ value: g.id, label: g.name })), { value: '', label: $t('adminLive.ch.groupImport') }];

  function toggle(which: 'group' | 'renumber', e: MouseEvent) {
    if (prompt === which) { prompt = null; return; }
    opener = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    if (which === 'group') groupId = groups[0]?.id ?? '';
    prompt = which;
    void tick().then(() => document.querySelector<HTMLElement>('[data-bulk-prompt] select, [data-bulk-prompt] input')?.focus({ preventScroll: true }));
  }
  function closePrompt() { prompt = null; void tick().then(() => opener?.focus({ preventScroll: true })); }
  function key(e: KeyboardEvent) { if (e.key === 'Escape' && prompt) { e.stopPropagation(); closePrompt(); } }
  function applyGroup() { dispatch('group', { groupId: groupId || null }); prompt = null; }
  function applyRenumber() { if (!numberOk) return; dispatch('renumber', { from }); prompt = null; }
</script>

{#if count > 0}
  <div class="bb-wrap">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="bb frost frost-safe frost-panel" style="--fr-scrim-safe:{SCRIM_BAR}" role="toolbar" aria-label={$t('adminLive.ch.bulk.label')} tabindex="-1"
      in:barRise out:barRise={{ dir: 'out' }} on:keydown={key}>
      <div class="head">
        <span class="sel" data-selected>{$t('adminLive.ch.bulk.selected', { n: count })}</span>
        <Button variant="ghost" on:click={() => dispatch('clear')}>{$t('adminLive.ch.bulk.clear')}</Button>
      </div>
      <div class="acts">
        <Button variant="secondary" disabled={busy} on:click={() => dispatch('hide')}>{$t('adminLive.ch.bulk.hide')}</Button>
        <Button variant="secondary" disabled={busy} on:click={() => dispatch('show')}>{$t('adminLive.ch.bulk.show')}</Button>
        <Button variant="secondary" disabled={busy} aria-expanded={prompt === 'group'} on:click={(e) => toggle('group', e)}>{$t('adminLive.ch.bulk.group')}</Button>
        <Button variant="secondary" disabled={busy} aria-expanded={prompt === 'renumber'} on:click={(e) => toggle('renumber', e)}>{$t('adminLive.ch.bulk.renumber')}</Button>
        <Button variant="secondary" disabled={busy} on:click={() => dispatch('reset')}>{$t('adminLive.ch.bulk.reset')}</Button>
        <Button variant="secondary" disabled={busy || count > TEST_MAX} on:click={() => dispatch('test')}>{$t('adminLive.ch.bulk.test')}</Button>
      </div>
      {#if count > TEST_MAX}<p class="note">{$t('adminLive.ch.bulk.testMax', { n: TEST_MAX })}</p>{/if}

      {#if prompt}
        <div class="prompt frost frost-safe frost-menu" style="--fr-scrim-safe:{SCRIM_BAR}" data-bulk-prompt role="group" aria-label={prompt === 'group' ? $t('adminLive.ch.bulk.group') : $t('adminLive.ch.bulk.renumber')}>
          {#if prompt === 'group'}
            <Select label={$t('adminLive.ch.filters.group')} bind:value={groupId} options={groupOptions} />
          {:else}
            <Field label={$t('adminLive.ch.bulk.firstNumber')} type="number" bind:value={first} min={1} max={MAX_NUMBER} width="9rem" hint={$t('adminLive.ch.bulk.renumberHint')}
              error={firstText && !numberOk ? $t('adminLive.push.numberBad', { max: MAX_NUMBER }) : ''} />
          {/if}
          <div class="pa">
            <Button disabled={prompt === 'renumber' && !numberOk} on:click={prompt === 'group' ? applyGroup : applyRenumber}>{$t('adminLive.ch.bulk.apply')}</Button>
            <Button variant="ghost" on:click={closePrompt}>{$t('adminLive.ch.bulk.cancel')}</Button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .bb-wrap { position: fixed; z-index: 85; left: 0; right: 0; bottom: 16px; display: flex; justify-content: center; padding: 0 16px; pointer-events: none; }
  .bb { position: relative; pointer-events: auto; box-sizing: border-box; width: min(900px, 100%); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; outline: none; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .sel { font-weight: 700; padding-left: 8px; }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .note { margin: 0; padding-left: 8px; font-size: .9rem; color: #ffbdbd; }
  /* the prompt overlays the page above the bar: it takes no room, so the bar never grows */
  .prompt { position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); display: flex; flex-direction: column; gap: .7rem; padding: 14px; }
  .pa { display: flex; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 720px) {
    .bb-wrap { bottom: calc(var(--tabbar-h, 0px) + var(--safe-bottom, 0px) + .6rem); padding: 0 .6rem; }
  }
  :global(html.m-still) .bb-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .bb-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
