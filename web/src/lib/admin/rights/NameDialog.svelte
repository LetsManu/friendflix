<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Duplizieren*: asks for the name of the copy (1 to 30 characters, the role write's bounds) and hands it to the page, which
   * creates the role (`busy`, `error` come back from it). A modal dialog: the name field starts focused, Tab stays inside, Escape or
   * a press on the dimmed page cancels, the focus returns to `trigger`. Mounted while open.
   *   <NameDialog title="…" hint="…" confirmLabel="Anlegen" {busy} {error} on:submit={(e) => create(e.detail)} on:cancel={close} />
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { dialogKeys } from '#lib/actions';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { dur } from '#lib/ui/motion';
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
  let name = '', tooShort = false, box: HTMLElement | undefined;
  $: clean = name.trim();
  $: bad = tooShort && (clean.length < 1 || clean.length > 30) ? $t('adminPeople.roles.errLabel') : '';

  function cancel() {
    if (busy) return;
    dispatch('cancel');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  function submit() {
    tooShort = true;
    if (busy || clean.length < 1 || clean.length > 30) return;
    dispatch('submit', clean);
  }
  onMount(() => { box?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true }); });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events (Escape is handled by dialogKeys) -->
<div class="ov" transition:fade={{ duration: dur(140) }} role="presentation" on:click|self={cancel}>
  <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="{id}-t" bind:this={box} in:scale={{ start: .96, duration: dur(160) }} use:dialogKeys={{ close: cancel }}>
    <form on:submit|preventDefault={submit}>
      <h2 id="{id}-t">{title}</h2>
      {#if hint}<p class="body">{hint}</p>{/if}
      <Field {label} bind:value={name} maxlength={30} error={bad || error} disabled={busy} autocomplete="off" />
      <div class="acts">
        <Button variant="ghost" disabled={busy} on:click={cancel}>{$t('common.cancel')}</Button>
        <Button type="submit" pending={busy}>{confirmLabel}</Button>
      </div>
    </form>
  </div>
</div>

<style>
  .ov { position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, .7); display: grid; place-items: center; padding: max(1rem, var(--safe-top)) 1rem max(1rem, var(--safe-bottom)); }
  .dlg { width: min(460px, 100%); background: #1b2127; border: 1px solid #323a43; border-radius: 12px; padding: 1.4rem 1.4rem 1.2rem; box-shadow: var(--shadow-pop); }
  h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
  .body { color: var(--mut); margin: .8rem 0 1rem; }
  form :global(.field) { margin-top: 1rem; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.4rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts :global(.ui-btn) { width: 100%; } }
  :global(html.m-still) .ov :global(*) { transition: none !important; animation: none !important; }
</style>
