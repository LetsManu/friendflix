<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Renders lib/ui/confirm.ts as a modal alertdialog in the shared dialog frame (ModalShell; app.css `.dlg-*`): title, body, the
   * glass Abbrechen and the coral (danger: solid red) confirm on the right, stacked with the confirm on top on phones. Mounted once in
   * the root layout.
   */
  import { onMount, tick } from 'svelte';
  import { t } from '#lib/i18n';
  import { answer, confirmRequest, registerHost, typedOk } from './confirm';
  import ModalShell from './ModalShell.svelte';

  onMount(registerHost);
  let box: HTMLElement | undefined, typedVal = '', back: HTMLElement | null = null, shownId = 0;
  $: req = $confirmRequest;
  $: ok = typedOk(req?.typed, typedVal);
  $: if (req && req.id !== shownId) void opened(req.id);
  $: if (!req && shownId) closed();

  async function opened(id: number) {
    if (!shownId) back = document.activeElement as HTMLElement | null;
    shownId = id; typedVal = '';
    await tick();
    const first = box?.querySelector<HTMLElement>(req?.typed ? 'input' : req?.danger ? '.cancel' : '.ok');
    first?.focus();
  }
  function closed() {
    shownId = 0;
    const el = back; back = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }
  function submit() { if (ok) answer(true); }
</script>

{#if req}
  <ModalShell role="alertdialog" labelledby="cf-t" describedby={req.body ? 'cf-b' : undefined} layer={130} bind:box on:close={() => answer(false)}>
    <form on:submit|preventDefault={submit}>
      <h2 id="cf-t" class="dlg-title">{req.title}</h2>
      {#if req.body}<p id="cf-b" class="dlg-body">{req.body}</p>{/if}
      {#if req.typed}
        <label class="typed"><span>{$t('ui.confirm.typeToConfirm', { word: req.typed })}</span>
          <input bind:value={typedVal} autocomplete="off" autocapitalize="off" spellcheck="false" />
        </label>
      {/if}
      <!-- the shared status line's room (a confirm has no refusal of its own): the same space above the buttons as every dialog -->
      <div class="dlg-err" aria-hidden="true"></div>
      <div class="dlg-acts">
        <button type="button" class="frost-btn cancel" on:click={() => answer(false)}>{req.cancelLabel ?? $t('ui.confirm.cancel')}</button>
        <button type="submit" class="ok" class:danger={req.danger} class:solid={req.danger} disabled={!ok}>{req.confirmLabel ?? (req.danger ? $t('ui.confirm.delete') : $t('ui.confirm.ok'))}</button>
      </div>
    </form>
  </ModalShell>
{/if}

<style>
  .dlg-body { white-space: pre-line; }
  .typed { display: flex; flex-direction: column; gap: .35rem; margin-top: 14px; }
  .typed input { width: 100%; }
</style>
