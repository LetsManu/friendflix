<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Renders lib/ui/confirm.ts as a modal alertdialog. Mounted once in the root layout. */
  import { onMount, tick } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
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
      <div class="head">
        {#if req.danger}<span class="ic" aria-hidden="true"><Icon name="alert" size={22} /></span>{/if}
        <h2 id="cf-t">{req.title}</h2>
      </div>
      {#if req.body}<p id="cf-b" class="body">{req.body}</p>{/if}
      {#if req.typed}
        <label class="typed"><span>{$t('ui.confirm.typeToConfirm', { word: req.typed })}</span>
          <input bind:value={typedVal} autocomplete="off" autocapitalize="off" spellcheck="false" />
        </label>
      {/if}
      <div class="acts">
        <button type="button" class="sec cancel" on:click={() => answer(false)}>{req.cancelLabel ?? $t('ui.confirm.cancel')}</button>
        <button type="submit" class="ok" class:danger={req.danger} class:solid={req.danger} disabled={!ok}>{req.confirmLabel ?? (req.danger ? $t('ui.confirm.delete') : $t('ui.confirm.ok'))}</button>
      </div>
    </form>
  </ModalShell>
{/if}

<style>
  .head { display: flex; align-items: center; gap: .7rem; }
  .ic { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border-radius: 50%; background: var(--tone-err); color: var(--err); }
  h2 { margin: 0; font-size: 1.2rem; }
  .body { color: var(--mut); margin: .8rem 0 0; white-space: pre-line; overflow-wrap: anywhere; }
  .typed { display: flex; flex-direction: column; gap: .35rem; margin-top: 1rem; }
  .typed input { width: 100%; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.4rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts button { width: 100%; } }
</style>
