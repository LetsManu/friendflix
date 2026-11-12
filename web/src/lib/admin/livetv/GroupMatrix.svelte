<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Nach Rolle* (spec §9.3): the groups as rows, the roles as columns, one switch per cell (the style of the role matrix: a chip with
   * a check or a cross). A switch grants or takes away the group for the role (`toggle`; the tab writes). The admin has no column (it
   * sees every released group; the line under the table says so); a role defined only in `.env` is read-only (lock, the backend
   * refuses to grant it a group); an unreleased group has no switches until it is released (its row says so).
   *   <GroupMatrix {groups} {roles} busy={…} on:toggle={(e) => setRole(e.detail)} />
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { uid } from '#lib/ui/ids';
  import type { GrantRole, GroupView } from './groups';

  export let groups: GroupView[];
  export let roles: GrantRole[];
  /** ids of the groups whose role set is being written: every cell of such a row waits (PATCH replaces the whole set) */
  export let busy: ReadonlySet<string> = new Set();

  const dispatch = createEventDispatcher<{ toggle: { group: GroupView; role: string; on: boolean } }>();
  const id = uid('gm');
</script>

<div class="matrix panel">
  <div class="scroll">
    <table aria-labelledby="{id}-c">
      <caption id="{id}-c" class="sr-only">{$t('adminLive.grp.matrixLabel')}</caption>
      <thead>
        <tr>
          <th scope="col" class="corner">{$t('adminLive.tabs.groups')}</th>
          {#each roles as r (r.key)}
            <th scope="col" class="rh"><span class="rn">{r.name}</span>{#if r.readOnly}<span class="rt">{$t('adminLive.grp.envShort')}</span>{/if}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each groups as g (g.id)}
          <tr class:off={!g.released}>
            <th scope="row" class="fh">
              <span class="gn">{g.name}</span>
              {#if !g.released}<span class="gs"><Icon name="eye-off" size={14} />{$t('adminLive.grp.unreleased')}</span>{/if}
            </th>
            {#each roles as r (r.key)}
              {@const kept = g.roles.includes(r.key)}
              {@const on = kept && g.released}
              {@const locked = r.readOnly || !g.released}
              <td>
                <!-- an unreleased group grants nothing to anyone: its kept roles show a neutral eye-off, never a check, and `aria-checked` is false -->
                <button type="button" role="switch" class="sw" class:on class:locked class:off={!g.released} aria-checked={on} aria-disabled={locked ? 'true' : undefined}
                  aria-label={g.released ? $t('adminLive.grp.cell', { group: g.name, role: r.name }) : $t('adminLive.grp.cellOff', { group: g.name, role: r.name })}
                  title={r.readOnly ? $t('adminLive.grp.envRole') : !g.released ? $t('adminLive.grp.unreleasedLine') : undefined}
                  disabled={!g.released || busy.has(g.id)} on:click={() => { if (!locked) dispatch('toggle', { group: g, role: r.key, on: !kept }); }}>
                  <span class="chip" aria-hidden="true"><Icon name={!g.released ? 'eye-off' : r.readOnly ? 'lock' : on ? 'check' : 'x'} size={16} /></span>
                </button>
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
<p class="note">{$t('adminLive.grp.adminAll')}</p>

<style>
  .matrix.panel { padding: 0; overflow: hidden; margin-bottom: .6rem; }
  .scroll { overflow: auto; max-height: calc(100vh - var(--nav-total, 64px) - 14rem); min-height: 8rem; }
  table { border-collapse: separate; border-spacing: 0; min-width: 100%; font-size: .92rem; }
  thead th { position: sticky; top: 0; z-index: 2; background: var(--fr-solid); border-bottom: 1px solid var(--fr-line); padding: .6rem .8rem; text-align: left; vertical-align: bottom; }
  .corner { left: 0; z-index: 4; min-width: 11rem; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .rh { min-width: 6.5rem; text-align: center; }
  .rn { display: block; font-weight: 800; overflow-wrap: anywhere; }
  .rt { display: block; font-size: .75rem; font-weight: 500; color: var(--mut); }
  .fh { position: sticky; left: 0; z-index: 1; min-width: 11rem; padding: .5rem .8rem; background: var(--fr-solid); text-align: left; font-weight: 600; border-bottom: 1px solid rgba(255, 255, 255, .06); }
  .gn { display: block; overflow-wrap: anywhere; }
  .gs { display: inline-flex; align-items: center; gap: .3rem; font-size: .75rem; font-weight: 600; color: var(--warn); }
  tr.off .fh { color: var(--mut); }
  td { height: 52px; padding: 4px 8px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, .06); }
  /* a 44 px target around the chip */
  .sw { min-width: 44px; min-height: 44px; padding: 0; display: inline-grid; place-items: center; background: transparent; border-radius: 12px; cursor: pointer; }
  .sw.locked { cursor: default; }
  .chip { display: inline-flex; align-items: center; justify-content: center; min-width: 40px; min-height: 32px; padding: 0 .7rem; border-radius: var(--fr-r-pill, 99px); background: rgba(var(--fr-scrim-rgb), .25); color: var(--mut); font-weight: 600; }
  .sw.on .chip { color: var(--ok); }
  .sw.locked .chip { opacity: .6; }
  .sw:hover:not(.locked):not(:disabled) .chip { background: rgba(var(--fr-scrim-rgb), .4); }
  .sw:focus-visible { outline: 2px solid #fff; outline-offset: 1px; box-shadow: 0 0 0 4px var(--ring-dark, #000); }
  .sw:disabled { opacity: .6; cursor: progress; }
  .sw.off:disabled { cursor: default; }
  .sw.off .chip { opacity: .5; }
  .note { margin: 0 0 1rem; font-size: .85rem; color: var(--mut); }
  @media (max-width: 720px) { .corner, .fh { min-width: 8.5rem; } }
</style>
