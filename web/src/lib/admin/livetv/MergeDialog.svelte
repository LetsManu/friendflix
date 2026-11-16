<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Zusammenführen …* (spec §9.3): the selected groups (two or more) move into the one chosen here: their provider groups and channel
   * overrides go over, the other groups are deleted. The dialog warns that the moved channels are visible at once to the audience of
   * the target group (an unreleased target: that they stay invisible to everyone). The tab does the write (`pending`, `error` come back from it). A modal dialog: Tab stays inside, Escape or a
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
  /** an unreleased target: released sources turn invisible (they were visible before), unreleased ones stay invisible; a released target shows them at once */
  $: warning = target && !target.released
    ? $t(others.some((g) => g.released) ? 'adminLive.grp.mergeWarnHide' : 'adminLive.grp.mergeWarnOff')
    : $t('adminLive.grp.mergeWarn', { into: target?.name ?? '' });
  $: options = groups.map((g) => ({ value: g.id, label: g.name }));
  const cancel = () => { if (!pending) dispatch('cancel'); };
  const confirm = () => { if (!pending && target && others.length) dispatch('confirm', { ids: others.map((g) => g.id), into: target.id }); };
</script>

<ModalShell bind:this={shell} role="alertdialog" labelledby="{id}-t" describedby="{id}-b" focus="select" {trigger} locked={pending} on:close={cancel}>
  <form on:submit|preventDefault={confirm}>
    <h2 id="{id}-t" class="dlg-title">{$t('adminLive.grp.mergeTitle')}</h2>
    <div class="dlg-main">
      <p class="dlg-body" id="{id}-b">{$t('adminLive.grp.mergeBody', { names: chipsText(others.map((g) => g.name), 3), into: target?.name ?? '' })}</p>
      <div class="into"><Select label={$t('adminLive.grp.mergeInto')} bind:value={into} {options} disabled={pending} /></div>
      <p class="warn" role="note"><Icon name="alert" size={16} /><span>{warning}</span></p>
    </div>
    <!-- the server's refusal: its line is always there, so the buttons never move -->
    <p class="dlg-err" role="alert">{error}</p>
    <div class="dlg-acts">
      <Button variant="glass" disabled={pending} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" {pending}>{$t('adminLive.grp.mergeDo')}</Button>
    </div>
  </form>
</ModalShell>

<style>
  .into { margin-top: 14px; }
  .warn { display: flex; gap: .5rem; align-items: flex-start; margin: 14px 0 0; padding: .6rem .8rem; border-radius: 12px; background: var(--wash-warn); color: var(--warn); font-weight: 600; font-size: .9rem; }
  .warn :global(svg) { flex: none; margin-top: .15em; }
  .warn span { overflow-wrap: anywhere; }
</style>
