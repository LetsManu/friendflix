<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Gruppe anlegen* and *Umbenennen*: asks for the group's name (1 to 40 characters, the backend's bounds) and hands it to the tab,
   * which does the write (`busy`, `error` come back from it). A modal dialog: the name field starts focused, Tab stays inside, Escape
   * or a press on the dimmed page cancels, focus returns to `trigger`. Mounted while open.
   *   <GroupNameDialog title="…" confirmLabel="Anlegen" initial="Sport" {busy} {error} on:submit={(e) => save(e.detail)} on:cancel={close} />
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import { uid } from '#lib/ui/ids';

  export let title: string;
  export let confirmLabel: string;
  export let initial = '';
  export let busy = false;
  export let error = '';
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ submit: string; cancel: void }>();
  const id = uid('gnd');
  let name = initial, tried = false, shell: ModalShell;
  $: clean = name.trim();
  $: bad = tried && (clean.length < 1 || clean.length > 40) ? $t('adminLive.grp.errName') : '';

  function cancel() { if (!busy) dispatch('cancel'); }
  function submit() {
    tried = true;
    if (busy || clean.length < 1 || clean.length > 40) return;
    dispatch('submit', clean);
  }
</script>

<ModalShell bind:this={shell} labelledby="{id}-t" focus="input" {trigger} locked={busy} on:close={cancel}>
  <form on:submit|preventDefault={submit}>
    <h2 id="{id}-t" class="dlg-title">{title}</h2>
    <!-- a refusal is about the name (taken, too long): it stays the field's error; the status line keeps the row's place -->
    <div class="dlg-main"><Field label={$t('adminLive.grp.nameLabel')} bind:value={name} maxlength={40} error={bad || error} disabled={busy} autocomplete="off" /></div>
    <div class="dlg-err" aria-hidden="true"></div>
    <div class="dlg-acts">
      <Button variant="glass" disabled={busy} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" pending={busy}>{confirmLabel}</Button>
    </div>
  </form>
</ModalShell>

<style>
  form :global(.field) { margin-top: 4px; }
</style>
