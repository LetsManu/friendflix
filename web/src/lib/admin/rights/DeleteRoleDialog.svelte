<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Deleting a role somebody still holds (spec §2.1): "6 Personen und 1 offene Einladung bekommen die Rolle:" and a `Select` of the
   * roles they move to (never the role itself or admin), then *Löschen*. The counts come from the server's 409 `role_in_use`.
   * `confirm` carries the chosen role's key; the page runs the delete (`busy`, `error` come back from it). A modal alertdialog:
   * Tab stays inside, Escape or a press on the dimmed page cancels, the focus returns to `trigger`. Mounted while open.
   *   <DeleteRoleDialog name="Oma & Opa" targets={others} accounts={6} invites={1} {busy} {error} on:confirm={(e) => run(e.detail)} on:cancel={close} />
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { dialogKeys } from '#lib/actions';
  import { t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { dur } from '#lib/ui/motion';
  import Select from '#lib/ui/Select.svelte';
  import { uid } from '#lib/ui/ids';

  export let name: string;
  /** the roles the people can move to: key and display name */
  export let targets: Array<{ key: string; name: string }>;
  export let accounts: number;
  export let invites: number;
  export let busy = false;
  export let error = '';
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ confirm: string; cancel: void }>();
  const id = uid('dr');
  let to = '', box: HTMLElement | undefined;

  $: options = [{ value: '', label: $t('adminPeople.roles.deleteChoose'), disabled: true }, ...targets.map((r) => ({ value: r.key, label: r.name }))];
  $: line = tr('adminPeople.roles.deleteMove', { people: tr('adminPeople.roles.deletePeople', { n: accounts }), invites: tr('adminPeople.roles.deleteInvites', { n: invites }) });

  function cancel() {
    if (busy) return;
    dispatch('cancel');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  function submit() { if (to && !busy) dispatch('confirm', to); }
  onMount(() => { box?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true }); });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events (Escape is handled by dialogKeys) -->
<div class="ov" transition:fade={{ duration: dur(140) }} role="presentation" on:click|self={cancel}>
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="{id}-t" aria-describedby="{id}-b" bind:this={box}
    in:scale={{ start: .96, duration: dur(160) }} use:dialogKeys={{ close: cancel }}>
    <form on:submit|preventDefault={submit}>
      <h2 id="{id}-t">{$t('adminPeople.roles.deleteTitle', { name })}</h2>
      <p id="{id}-b" class="body">{line}</p>
      <Select label={$t('adminPeople.roles.deleteTo')} {options} bind:value={to} disabled={busy} error={error} />
      <div class="acts">
        <Button variant="ghost" disabled={busy} on:click={cancel}>{$t('common.cancel')}</Button>
        <Button type="submit" variant="danger" solid pending={busy} disabled={!to}>{$t('adminPeople.roles.delete')}</Button>
      </div>
    </form>
  </div>
</div>

<style>
  .ov { position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, .7); display: grid; place-items: center; padding: max(1rem, var(--safe-top)) 1rem max(1rem, var(--safe-bottom)); }
  .dlg { width: min(460px, 100%); background: #1b2127; border: 1px solid #323a43; border-radius: 12px; padding: 1.4rem 1.4rem 1.2rem; box-shadow: var(--shadow-pop); }
  h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
  .body { color: var(--mut); margin: .8rem 0 1rem; overflow-wrap: anywhere; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.4rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts :global(.ui-btn) { width: 100%; } }
  :global(html.m-still) .ov :global(*) { transition: none !important; animation: none !important; }
</style>
