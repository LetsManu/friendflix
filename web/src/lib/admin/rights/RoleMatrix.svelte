<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Rollen vergleichen* on the desktop (roles redesign §1.1, §5.5): read-only. Every role is a column, every right a row: the
   * *Bereiche* first (✓ / – per area), then the details grouped by area and *Allgemein* (compare.ts), in a glass panel that scrolls
   * inside itself (head row and first column stay). Each cell is a link to the role page at that right (`?field=`), each column
   * head a link to the role's page; the admin role's switches and areas are locked (the lock, no link). A `role="grid"` for
   * reading: one tab stop, arrows / Home / End / Ctrl+Home / Ctrl+End move (gridKeys.ts), Enter follows the cell's link. Nothing
   * here edits: no popover, no drag, no column menu (the role page is the one editor, so its rules hold everywhere).
   *   <RoleMatrix bind:this={view} {matrix} />
   */
  import { tick } from 'svelte';
  import { locale, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { areaLabel } from './areas';
  import { compareCell, compareGroups, rowKey, rowLabel, type CompareGroup, type CompareRow } from './compare';
  import { gridKey, moveCell, type CellPos } from './gridKeys';
  import { changedFromText, peopleLine, roleName, type MatrixRole, type RoleMatrix } from './model';

  export let matrix: RoleMatrix;

  $: roles = matrix.roles;
  /** the row groups, each row with its index in the grid (the keyboard counts every row of every group) */
  $: groups = numbered(compareGroups(matrix));
  $: rowCount = groups.reduce((n, g) => n + g.rows.length, 0);
  function numbered(gs: ReturnType<typeof compareGroups>) {
    let i = 0;
    return gs.map((g) => ({ id: g.id, rows: g.rows.map((row) => ({ row, r: i++ })) }));
  }
  const groupTitle = (id: CompareGroup['id'], _l: unknown): string => (id === 'areas' ? tr('adminPeople.roles.areas.title') : id === 'general' ? tr('adminPeople.roles.areas.general') : areaLabel(id));

  /** a cell (compare.ts); `_l`: the language, so a switch re-renders its words */
  const cellOf = (m: RoleMatrix, role: MatrixRole, row: CompareRow, _l: unknown) => compareCell(m, role, row);
  /** the cell's tooltip: why it is locked, or where its value was set */
  function tip(role: MatrixRole, row: CompareRow, locked: boolean, src: 'role' | 'env' | null, _l: unknown): string | undefined {
    if (locked) return tr('adminPeople.roles.adminLocked');
    if (src === 'role' && row.kind === 'field') return changedFromText(role, row.field) ?? tr('adminPeople.roles.changedHere');
    if (src === 'env') return tr('adminPeople.roles.fromEnv');
    return undefined;
  }

  // ---- reading by keyboard: one tab stop (the active cell), the arrows move it; Enter on a link follows it (the browser's own)
  let active: CellPos = { r: 0, c: 0 };
  const cells: Record<string, HTMLElement> = {};
  const key = (p: CellPos) => `${p.r}:${p.c}`;
  $: if (active.r >= rowCount || active.c >= roles.length) active = { r: 0, c: 0 };
  function onKey(e: KeyboardEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!el || e.altKey) return;
    const [r, c] = el.dataset.cell!.split(':').map(Number) as [number, number];
    const to = moveCell({ r, c }, gridKey(e), rowCount, roles.length);
    if (!to) return;
    e.preventDefault();
    active = to;
    cells[key(to)]?.focus();
  }

  /** moves the focus to a column head's link (the page crossed 900 px with the focus on that role) */
  export async function focusHead(k: string): Promise<void> {
    await tick();
    document.querySelector<HTMLElement>(`th[data-role="${CSS.escape(k)}"] a`)?.focus();
  }
</script>

<div class="matrix panel">
  <div class="matrix-scroll">
    <!-- the grid owns the keys of its cells (onKey) -->
    <table role="grid" aria-label={$t('adminPeople.roles.matrixLabel')} aria-readonly="true" on:keydown={onKey}>
      <thead>
        <tr>
          <th scope="col" class="corner">{$t('adminPeople.roles.fieldCol')}</th>
          {#each roles as role (role.key)}
            <th scope="col" class="rh" data-role={role.key}>
              <a class="rn" href="/admin/roles/{encodeURIComponent(role.key)}" aria-label={$locale && $t('adminPeople.roles.editRole', { name: roleName(role) })}><span class="rnt">{$locale && roleName(role)}</span></a>
              <span class="rp">{#each ($locale && peopleLine(role) || '').split(' · ') as seg, i}{#if i}{' · '}{/if}<span class="seg">{seg}</span>{/each}</span>
              {#if role.envGone}<span class="rt">{$t('adminPeople.roles.envGone')}</span>{:else if role.origin === 'env'}<span class="rt">{$t('adminPeople.roles.fromEnv')}</span>{/if}
            </th>
          {/each}
        </tr>
      </thead>
      {#each groups as g (g.id)}
        <tbody class:areas={g.id === 'areas'}>
          <tr class="gh">
            <th scope="colgroup" colspan={roles.length + 1}><span class="gl">{groupTitle(g.id, $locale)}</span></th>
          </tr>
          {#each g.rows as { row, r } (rowKey(row))}
            <tr>
              <th scope="row" class="fh">{$locale && rowLabel(row)}</th>
              {#each roles as role, c (role.key)}
                {@const x = cellOf(matrix, role, row, $locale)}
                {@const focus = active.r === r && active.c === c ? 0 : -1}
                {#if x.href}
                  <td role="gridcell" class:wrap={row.kind === 'groups'}>
                    <a class="cl" href={x.href} data-cell="{r}:{c}" bind:this={cells[`${r}:${c}`]} tabindex={focus} aria-label={x.label} title={tip(role, row, false, x.src, $locale)}
                      on:focus={() => (active = { r, c })}>
                      <span class="chip" class:bool={x.bool} class:off={x.bool && !x.value} class:names={row.kind === 'groups'} aria-hidden="true">
                        {#if x.bool}<Icon name={x.value ? 'check' : 'x'} size={16} />{:else}{x.text}{/if}
                      </span>
                      {#if x.src}<span class="dot" class:env={x.src === 'env'} aria-hidden="true"></span>{/if}
                    </a>
                  </td>
                {:else}
                  <td role="gridcell" class="lock" data-cell="{r}:{c}" bind:this={cells[`${r}:${c}`]} tabindex={focus} aria-disabled="true" aria-label={x.label}
                    title={tip(role, row, true, null, $locale)} on:focus={() => (active = { r, c })}>
                    <span class="chip" class:bool={x.bool} class:off={x.bool && !x.value} aria-hidden="true">
                      {#if x.bool}<Icon name={x.value ? 'check' : 'x'} size={16} />{:else}{x.text}{/if}
                    </span>
                    <span class="lk" aria-hidden="true"><Icon name="lock" size={14} /></span>
                  </td>
                {/if}
              {/each}
            </tr>
          {/each}
        </tbody>
      {/each}
    </table>
  </div>
</div>

<style>
  /* the glass panel holds the scroller edge to edge; the scroller keeps the head row and the first column (sticky) */
  .matrix.panel { padding: 0; overflow: hidden; margin-bottom: 0; }
  .matrix-scroll { overflow: auto; max-height: calc(100vh - var(--nav-total, 64px) - 12rem); min-height: 16rem;
    /* a focused cell scrolls clear of the sticky head row, group row and first column */
    scroll-padding: calc(var(--head-h) + var(--group-h)) 0 0 var(--first-w); --head-h: 6.2rem; --group-h: 2.2rem; --first-w: 11rem; }
  table { border-collapse: separate; border-spacing: 0; min-width: 100%; font-size: .92rem; }
  th, td { box-sizing: border-box; }
  thead th { position: sticky; top: 0; z-index: 2; height: var(--head-h); background: var(--fr-solid); border-bottom: 1px solid var(--fr-line); vertical-align: bottom; padding: .6rem .8rem; text-align: left; }
  .corner { left: 0; z-index: 4; width: var(--first-w); min-width: var(--first-w); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .rh { min-width: 9rem; padding: .4rem .6rem .5rem .8rem; vertical-align: top; }
  /* the head: the name is a 44 px link to the role page (the text clamps to two lines inside it), the people under it */
  .rn { display: flex; align-items: center; min-height: 44px; min-width: 44px; max-width: 100%; border-radius: 6px; color: inherit; font-weight: 800; font-size: .98rem; text-decoration: none; }
  .rn:hover { text-decoration: underline; text-underline-offset: 3px; }
  .rn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); }
  .rnt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; min-width: 0; overflow-wrap: anywhere; hyphens: auto; }
  /* a count stays with its noun ("0 Kinderprofile" never splits) */
  .seg { white-space: nowrap; }
  .rt { display: block; font-size: .75rem; color: var(--mut); }
  .rp { display: block; margin-top: .15rem; font-size: .8rem; font-weight: 500; color: var(--mut); }
  /* group rows: sticky under the head row; the label stays at the left edge while the panel scrolls sideways */
  .gh th { position: sticky; top: var(--head-h); z-index: 3; height: var(--group-h); padding: 0; background: var(--fr-solid); border-bottom: 1px solid var(--fr-line); text-align: left; }
  .gl { position: sticky; left: 0; display: inline-block; padding: .5rem .8rem; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .fh { position: sticky; left: 0; z-index: 1; width: var(--first-w); min-width: var(--first-w); padding: .5rem .8rem; background: var(--fr-solid); text-align: left; font-weight: 600; border-bottom: 1px solid rgba(255, 255, 255, .06); }
  /* the Bereiche rows read first: their names a little stronger */
  .areas .fh { font-weight: 800; }
  td { position: relative; height: 48px; padding: 0; border-bottom: 1px solid rgba(255, 255, 255, .06); white-space: nowrap; outline: none; }
  td.wrap { white-space: normal; }
  /* the cell's link fills it (a 48 px target); a locked cell is the focus stop itself */
  .cl { display: flex; align-items: center; box-sizing: border-box; min-height: 48px; height: 100%; padding: 4px 8px; color: inherit; text-decoration: none; outline: none; }
  td.lock { padding: 4px 8px; cursor: default; }
  .cl:hover .chip { background: rgba(var(--fr-scrim-rgb), .4); }
  /* chips: a darker scrim fill (it only adds contrast; lib/admin/glass.test.ts) */
  .chip { display: inline-flex; align-items: center; min-height: 32px; padding: 0 .7rem; border-radius: var(--fr-r-pill, 99px); background: rgba(var(--fr-scrim-rgb), .25); font-weight: 600; font-variant-numeric: tabular-nums; }
  .chip.bool { color: var(--ok); }
  .chip.off { color: var(--mut); }
  .chip.names { font-size: .85rem; white-space: normal; overflow-wrap: anywhere; padding: .3rem .7rem; }
  /* the focused cell: the white ring drawn inside it (::after), not over its neighbours */
  .cl:focus-visible::after, td.lock:focus-visible::after { content: ''; position: absolute; inset: 3px; border-radius: 12px; pointer-events: none; box-shadow: inset 0 0 0 2px #fff, inset 0 0 0 4px var(--ring-dark); }
  td:focus-visible { box-shadow: none; }
  .lk { margin-left: .35rem; color: var(--mut); display: inline-grid; vertical-align: middle; }
  /* a value set for this role (or from .env): the small dot; its words are the tooltip and the cell's name */
  .dot { position: absolute; top: 9px; right: 10px; width: 7px; height: 7px; border-radius: 50%; background: var(--info); }
  .dot.env { background: transparent; box-shadow: inset 0 0 0 1.5px var(--info); }
</style>
