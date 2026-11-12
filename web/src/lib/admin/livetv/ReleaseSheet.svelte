<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Freigeben …* (spec §9.3): the sheet that releases one or several groups an import created. Role chips (none preselected; the
   * admin sees every group anyway, a role defined only in `.env` is shown read-only), *Kinderfreundlich* (off) and the line "Danach
   * sehen Personen mit diesen Rollen die {n} Sender der Gruppe." No role chosen is allowed: then only admins and per-person
   * exceptions see the group, and the sheet says so. The tab does the write (`pending` comes back from it). A modal dialog: Tab stays
   * inside, Escape or a press on the dimmed page cancels, focus returns to `trigger`. Mounted while open.
   *   <ReleaseSheet {groups} {roles} {pending} {trigger} on:confirm={(e) => release(e.detail)} on:cancel={close} />
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { uid } from '#lib/ui/ids';
  import { chipsText, type GrantRole, type GroupView } from './groups';

  /** the groups to release */
  export let groups: GroupView[];
  export let roles: GrantRole[];
  export let pending = false;
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ confirm: { roles: string[]; kidFriendly: boolean }; cancel: void }>();
  const id = uid('rel');
  let chosen = new Set<string>(), kidFriendly = false, shell: ModalShell;

  $: channels = groups.reduce((n, g) => n + g.channels, 0);
  const toggle = (key: string) => { const next = new Set(chosen); if (next.has(key)) next.delete(key); else next.add(key); chosen = next; };
  const cancel = () => { if (!pending) dispatch('cancel'); };
  // the roles in the catalogue's order, not in the order they were ticked
  const confirm = () => dispatch('confirm', { roles: roles.filter((r) => !r.readOnly && chosen.has(r.key)).map((r) => r.key), kidFriendly });
</script>

<ModalShell bind:this={shell} labelledby="{id}-t" describedby="{id}-b" focus="input:not(:disabled)" {trigger} locked={pending} on:close={cancel}>
  <form on:submit|preventDefault={confirm}>
    <h2 id="{id}-t">{$t('adminLive.grp.releaseTitle')}</h2>
    <p class="names">{chipsText(groups.map((g) => g.name), 3)}</p>
    <fieldset class="roles" disabled={pending}>
      <legend>{$t('adminLive.grp.releaseRoles')}</legend>
      {#each roles as r (r.key)}
        <label class="chip" class:on={chosen.has(r.key)} class:ro={r.readOnly} title={r.readOnly ? $t('adminLive.grp.envRole') : undefined}>
          <input type="checkbox" checked={chosen.has(r.key)} disabled={r.readOnly} on:change={() => toggle(r.key)} />
          <span>{r.name}</span>
        </label>
      {/each}
    </fieldset>
    <Toggle label={$t('adminLive.grp.kidFriendly')} bind:checked={kidFriendly} disabled={pending} />
    <p class="body" id="{id}-b">{$t('adminLive.grp.releaseBody', { n: channels })}</p>
    <!-- the room for this line is always there: nothing moves when the last role is ticked off -->
    <p class="hint" class:show={chosen.size === 0}>{$t('adminLive.grp.releaseNoRole')}</p>
    <div class="acts">
      <Button variant="ghost" disabled={pending} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" {pending}>{$t('adminLive.grp.releaseDo')}</Button>
    </div>
  </form>
</ModalShell>

<style>
  h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
  .names { margin: .4rem 0 .8rem; color: var(--mut); overflow-wrap: anywhere; }
  .roles { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 .8rem; padding: 0; border: 0; min-width: 0; }
  legend { padding: 0; margin-bottom: .5rem; font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .chip { position: relative; display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; padding: 0 1rem; border-radius: 99px; font-weight: 600; cursor: pointer;
    background: rgba(var(--fr-scrim-rgb), .25); box-shadow: inset 0 0 0 1px var(--fr-line, var(--line)); }
  .chip.on { background: var(--acc); color: #1a1a1a; box-shadow: none; }
  .chip.ro { opacity: .6; cursor: default; }
  .chip input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
  .chip:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark, #000); }
  .body { margin: .8rem 0 0; overflow-wrap: anywhere; }
  .hint { margin: .3rem 0 0; font-size: .85rem; color: var(--mut); min-height: 2.6em; visibility: hidden; }
  .hint.show { visibility: visible; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts :global(.ui-btn) { width: 100%; } }
</style>
