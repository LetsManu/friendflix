<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Duplizieren*: asks for the name of the copy (1 to 30 characters, the role write's bounds) and hands it to the page, which
   * creates the role (`busy`, `error` come back from it). A modal dialog: the name field starts focused, Tab stays inside, Escape or
   * a press on the dimmed page cancels, the focus returns to `trigger`. Mounted while open.
   *   <NameDialog title="…" hint="…" confirmLabel="Anlegen" {busy} {error} on:submit={(e) => create(e.detail)} on:cancel={close} />
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import { uid } from '#lib/ui/ids';

  export let title: string;
  export let hint = '';
  export let confirmLabel: string;
  export let label: string;
  export let busy = false;
  export let error = '';
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ submit: string; cancel: void }>();
  const id = uid('nd');
  let name = '', tooShort = false, shell: ModalShell;
  $: clean = name.trim();
  $: bad = tooShort && (clean.length < 1 || clean.length > 30) ? $t('adminPeople.roles.errLabel') : '';

  function cancel() { if (!busy) dispatch('cancel'); }
  function submit() {
    tooShort = true;
    if (busy || clean.length < 1 || clean.length > 30) return;
    dispatch('submit', clean);
  }
</script>

<ModalShell bind:this={shell} labelledby="{id}-t" focus="input" {trigger} locked={busy} on:close={cancel}>
  <form on:submit|preventDefault={submit}>
    <h2 id="{id}-t">{title}</h2>
    {#if hint}<p class="body">{hint}</p>{/if}
    <Field {label} bind:value={name} maxlength={30} error={bad || error} disabled={busy} autocomplete="off" />
    <div class="acts">
      <Button variant="ghost" disabled={busy} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" pending={busy}>{confirmLabel}</Button>
    </div>
  </form>
</ModalShell>

<style>
  h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
  .body { color: var(--mut); margin: .8rem 0 1rem; }
  form :global(.field) { margin-top: 1rem; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.4rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts :global(.ui-btn) { width: 100%; } }
</style>
