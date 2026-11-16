<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Row/overflow menu ("⋯") for secondary and destructive actions. Built on MoreActions (popover on desktop, bottom
   * sheet on touch; Arrow keys, Home / End, Escape, focus return); its button is the title page's ⋯ (a round glass button). Items: { id, label, icon?, run?, href?, danger?, disabled? }.
   *   <ActionMenu label={$t('ui.table.actionsFor', { name: u.name })} title={u.name} busy={$busyKeys.has('user:' + u.id)}
   *     items={[{ id: 'lock', label: $t('admin.users.lock'), icon: 'lock', danger: true, run: () => lock(u) }]} />
   */
  import MoreActions, { type MoreAction } from '#lib/MoreActions.svelte';
  import { t } from '#lib/i18n';
  export let items: MoreAction[] = [];
  /** accessible name of the trigger (say whose actions these are) */
  export let label = '';
  /** heading inside the menu/sheet */
  export let title = '';
  /** a running action: the trigger shows a spinner and the menu cannot open */
  export let busy = false;
</script>

<span class="am">
  {#if busy}
    <button type="button" class="busy frost-btn round" aria-disabled="true" aria-busy="true" aria-label={label || $t('ui.table.actions')}><span class="spinner" aria-hidden="true"></span></button>
  {:else}
    <MoreActions actions={items} label={label || $t('ui.table.actions')} {title} variant="ring" />
  {/if}
</span>

<style>
  .am { display: inline-flex; }
  /* the trigger is MoreActions' ring: the title page's round glass button. The busy one has the same look, a spinner inside */
  .busy { width: 44px; height: 44px; min-height: 44px; padding: 0; color: #fff; display: grid; place-items: center; cursor: progress; }
</style>
