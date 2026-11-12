<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Rollen & Rechte on the phone (spec §6.1): one card per role with its name, its people and a two-line summary ("2 Streams ·
   * 20 Mbit/s · ab 12 · Downloads aus", staged values included). A tap opens the role sheet (full width on a phone); the card's
   * menu has the matrix column's actions (*Bearbeiten*, *Duplizieren*, *Umbenennen*, *Nach oben/unten*, *Verlauf*, *Löschen*).
   * A role without a table row (env-only) stays after the stored ones and has no move actions. Edits go into `stage`; the
   * page's save bar counts them. Duplicate, delete and a new order are the page's to run (the same events as `RoleMatrix`).
   *   <RoleCards bind:this={view} {matrix} bind:stage disabled={busy} {status} on:move={…} on:duplicate={…} on:remove={…} />
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { locale, t, tr } from '#lib/i18n';
  import ActionMenu from '#lib/ui/ActionMenu.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { peopleLine, roleName, summaryLine, type MatrixRole, type RoleMatrix, type Stage } from './model';
  import RoleHistory from './RoleHistory.svelte';
  import RoleSheet from './RoleSheet.svelte';

  export let matrix: RoleMatrix;
  export let stage: Stage = {};
  /** a save runs: nothing opens */
  export let disabled = false;
  /** a polite announcement for screen readers (a role moved to a new place) */
  export let status = '';

  const dispatch = createEventDispatcher<{ duplicate: { role: MatrixRole; trigger: HTMLElement | null }; remove: { role: MatrixRole; trigger: HTMLElement | null }; move: { key: string; to: number } }>();

  $: roles = matrix.roles;
  $: storedCount = roles.filter((r) => r.stored).length;
  const staged = (s: Stage, r: MatrixRole): boolean => Object.keys(s[r.key] ?? {}).length > 0;
  const nameOf = (s: Stage, r: MatrixRole, _l: unknown): string => (Object.hasOwn(s[r.key] ?? {}, 'label') ? String(s[r.key]!.label) : roleName(r));
  /** the summary of the role as it would be after saving */
  const summary = (s: Stage, r: MatrixRole, _l: unknown): string => summaryLine({ ...r, values: { ...r.values, ...s[r.key] } });

  let sheet: { key: string; rename: boolean; trigger: HTMLElement | null } | null = null;
  let history: { key: string; trigger: HTMLElement | null } | null = null;
  $: sheetRole = sheet ? roles.find((r) => r.key === sheet!.key) : undefined;
  $: historyRole = history ? roles.find((r) => r.key === history!.key) : undefined;
  /** a role deleted while its sheet is open: the sheet goes */
  function prune(list: MatrixRole[]) {
    if (sheet && !list.some((r) => r.key === sheet!.key)) sheet = null;
    if (history && !list.some((r) => r.key === history!.key)) history = null;
  }
  $: prune(roles);
  const here = (): HTMLElement | null => (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  /** a menu item runs after the menu closed and gave the focus back to its button: that is where the focus returns to */
  function items(role: MatrixRole, i: number, _l: unknown, _busy: boolean, _n: number) {
    const canDelete = role.origin === 'admin' || role.envGone;
    // an env-only role stays after the stored ones: it cannot move, and nothing moves past it
    const up = disabled || !role.stored || i === 0, down = disabled || !role.stored || i + 1 >= storedCount;
    return [
      { id: 'edit', label: tr('adminPeople.roles.edit'), icon: 'pencil', disabled, run: () => { sheet = { key: role.key, rename: false, trigger: here() }; } },
      { id: 'duplicate', label: tr('adminPeople.roles.duplicate'), icon: 'copy', disabled, run: () => { dispatch('duplicate', { role, trigger: here() }); } },
      // an env-only role has no row for a name: nothing to rename
      ...(role.stored ? [{ id: 'rename', label: tr('adminPeople.roles.rename'), icon: 'pencil', disabled, run: () => { sheet = { key: role.key, rename: true, trigger: here() }; } }] : []),
      { id: 'up', label: tr('adminPeople.roles.moveUp'), icon: 'chevron-up', disabled: up, run: () => { dispatch('move', { key: role.key, to: i - 1 }); } },
      { id: 'down', label: tr('adminPeople.roles.moveDown'), icon: 'chevron-down', disabled: down, run: () => { dispatch('move', { key: role.key, to: i + 1 }); } },
      { id: 'history', label: tr('adminPeople.roles.history'), icon: 'clock', run: () => { history = { key: role.key, trigger: here() }; } },
      ...(canDelete ? [{ id: 'delete', label: tr('adminPeople.roles.delete'), icon: 'x', danger: true, disabled, run: () => { dispatch('remove', { role, trigger: here() }); } }] : []),
    ];
  }

  /** moves the focus to a card's name button (a new role) or its menu button (a moved one) */
  export async function focusHead(key: string, what: 'name' | 'menu' = 'name'): Promise<void> {
    await tick();
    const li = document.querySelector<HTMLElement>(`li[data-role="${CSS.escape(key)}"]`);
    li?.querySelector<HTMLElement>(what === 'name' ? '.open' : '.ma')?.focus();
  }
</script>

<p class="sr-only" aria-live="polite">{status}</p>

<ul class="cards">
  {#each roles as role, i (role.key)}
    {@const n = nameOf(stage, role, $locale)}
    {@const dirty = staged(stage, role)}
    <li class="card panel" class:dirty data-role={role.key}>
      <button type="button" class="open" {disabled} aria-label={$locale && $t('adminPeople.roles.editRole', { name: n })} aria-describedby={dirty ? `rc-${role.key}-u` : undefined}
        on:click={(e) => (sheet = { key: role.key, rename: false, trigger: e.currentTarget })}>
        <span class="rn">{n}</span>
        <span class="pp">{#each ($locale && peopleLine(role) || '').split(' · ') as seg, k}{#if k}{' · '}{/if}<span class="seg">{seg}</span>{/each}</span>
        <span class="sm">{summary(stage, role, $locale)}</span>
        {#if role.envGone}<span class="tag">{$t('adminPeople.roles.envGone')}</span>{:else if role.origin === 'env'}<span class="tag">{$t('adminPeople.roles.fromEnv')}</span>{/if}
      </button>
      <span class="mn"><ActionMenu label={$locale && $t('ui.table.actionsFor', { name: roleName(role) })} title={roleName(role)} items={items(role, i, $locale, disabled, storedCount)} /></span>
      <!-- the pill's room is always there: a staged role does not move the cards below it -->
      <span class="flag" id="rc-{role.key}-u">{#if dirty}<StatusPill tone="warn" label={$t('adminPeople.roles.unsaved')} icon="clock" />{/if}</span>
    </li>
  {/each}
</ul>

{#if sheet && sheetRole}
  <RoleSheet {matrix} role={sheetRole} bind:stage focusName={sheet.rename} trigger={sheet.trigger} on:close={() => (sheet = null)} />
{/if}
{#if history && historyRole}
  <RoleHistory role={historyRole} trigger={history.trigger} names={(k) => { const r = roles.find((x) => x.key === k); return r ? roleName(r) : null; }} on:close={() => (history = null)} />
{/if}

<style>
  .cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .8rem; }
  .card { position: relative; margin: 0; padding: 0; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
  .card.dirty { border-color: var(--warn); }
  .open { grid-column: 1; display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; gap: .15rem; min-width: 0; min-height: 44px; padding: .9rem 0 .9rem 1rem;
    background: transparent; border: 0; border-radius: 8px; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .open:disabled { cursor: default; }
  .rn { font-size: 1.05rem; font-weight: 800; overflow-wrap: anywhere; hyphens: auto; }
  .pp { font-size: .85rem; color: var(--mut); }
  .seg { white-space: nowrap; }
  /* two lines at most: the summary clamps rather than growing the card */
  .sm { margin-top: .25rem; font-size: .9rem; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
  .tag { font-size: .75rem; color: var(--mut); }
  .mn { grid-column: 2; display: flex; padding: .35rem .35rem 0 0; }
  .flag { grid-column: 1 / -1; display: flex; min-height: 1.6rem; box-sizing: content-box; padding: 0 1rem .8rem; }
  :global(html.m-still) .cards :global(*) { transition: none !important; animation: none !important; }
</style>
