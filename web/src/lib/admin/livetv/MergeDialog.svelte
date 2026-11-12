<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Zusammenführen …* (spec §9.3): the selected groups (two or more) move into the one chosen here: their provider groups and channel
   * overrides go over, the other groups are deleted. The dialog warns that the moved channels are visible at once to the audience of
   * the target group. The tab does the write (`pending`, `error` come back from it). A modal dialog: Tab stays inside, Escape or a
   * press on the dimmed page cancels, focus returns to `trigger`. Mounted while open.
   *   <MergeDialog {groups} {pending} {error} {trigger} on:confirm={(e) => merge(e.detail)} on:cancel={close} />
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Button from '#lib/ui/Button.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { uid } from '#lib/ui/ids';
  import { chipsText, type GroupView } from './groups';

  /** the selected groups */
  export let groups: GroupView[];
  export let pending = false;
  export let error = '';
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ confirm: { ids: string[]; into: string }; cancel: void }>();
  const id = uid('mrg');
  // the released group with the most channels is the likeliest target; the list order breaks ties
  let into = [...groups].sort((a, b) => Number(b.released) - Number(a.released) || b.channels - a.channels)[0]?.id ?? '';
  let shell: ModalShell;

  $: target = groups.find((g) => g.id === into);
  $: others = groups.filter((g) => g.id !== into);
  $: options = groups.map((g) => ({ value: g.id, label: g.name }));
  const cancel = () => { if (!pending) dispatch('cancel'); };
  const confirm = () => { if (!pending && target && others.length) dispatch('confirm', { ids: others.map((g) => g.id), into: target.id }); };
</script>

<ModalShell bind:this={shell} role="alertdialog" labelledby="{id}-t" describedby="{id}-b" focus="select" {trigger} locked={pending} on:close={cancel}>
  <form on:submit|preventDefault={confirm}>
    <h2 id="{id}-t">{$t('adminLive.grp.mergeTitle')}</h2>
    <p class="body" id="{id}-b">{$t('adminLive.grp.mergeBody', { names: chipsText(others.map((g) => g.name), 3), into: target?.name ?? '' })}</p>
    <Select label={$t('adminLive.grp.mergeInto')} bind:value={into} {options} disabled={pending} />
    <p class="warn" role="note"><Icon name="alert" size={16} /><span>{$t('adminLive.grp.mergeWarn', { into: target?.name ?? '' })}</span></p>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    <div class="acts">
      <Button variant="ghost" disabled={pending} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" {pending}>{$t('adminLive.grp.mergeDo')}</Button>
    </div>
  </form>
</ModalShell>

<style>
  h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
  .body { margin: .6rem 0 1rem; color: var(--mut); overflow-wrap: anywhere; }
  .warn { display: flex; gap: .5rem; align-items: flex-start; margin: 1rem 0 0; padding: .6rem .8rem; border-radius: 12px; background: var(--wash-warn); color: var(--warn); font-weight: 600; font-size: .9rem; }
  .warn :global(svg) { flex: none; margin-top: .15em; }
  .warn span { overflow-wrap: anywhere; }
  .err { margin: .6rem 0 0; color: var(--err); font-weight: 600; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.2rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts :global(.ui-btn) { width: 100%; } }
</style>
