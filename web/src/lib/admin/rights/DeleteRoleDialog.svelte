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
  import { createEventDispatcher } from 'svelte';
  import { t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
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
  let to = '', shell: ModalShell;

  $: options = [{ value: '', label: $t('adminPeople.roles.deleteChoose'), disabled: true }, ...targets.map((r) => ({ value: r.key, label: r.name }))];
  /** only the parts that are not zero: "2 Personen und 1 offene Einladung …", "1 Person bekommt …", "3 offene Einladungen …" (each form agrees with its count) */
  $: people = tr('adminPeople.roles.deletePeople', { n: accounts });
  $: open = tr('adminPeople.roles.deleteInvites', { n: invites });
  $: line = accounts > 0 && invites > 0 ? tr('adminPeople.roles.deleteMove', { people, invites: open })
    : invites > 0 ? tr('adminPeople.roles.deleteMoveInvites', { n: invites }) : tr('adminPeople.roles.deleteMovePeople', { n: accounts });

  function cancel() { if (!busy) dispatch('cancel'); }
  function submit() { if (to && !busy) dispatch('confirm', to); }
</script>

<ModalShell bind:this={shell} role="alertdialog" labelledby="{id}-t" describedby="{id}-b" focus="select" {trigger} locked={busy} on:close={cancel}>
  <form on:submit|preventDefault={submit}>
    <h2 id="{id}-t">{$t('adminPeople.roles.deleteTitle', { name })}</h2>
    <p id="{id}-b" class="body">{line}</p>
    <Select label={$t('adminPeople.roles.deleteTo')} {options} bind:value={to} disabled={busy} error={error} />
    <div class="acts">
      <Button variant="ghost" disabled={busy} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" variant="danger" solid pending={busy} disabled={!to}>{$t('adminPeople.roles.delete')}</Button>
    </div>
  </form>
</ModalShell>

<style>
  h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
  .body { color: var(--mut); margin: .8rem 0 1rem; overflow-wrap: anywhere; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.4rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts :global(.ui-btn) { width: 100%; } }
</style>
