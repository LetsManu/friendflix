<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Rollen & Rechte on the desktop (spec §6.1, §8): every right as a row (under its group), every role as a column, in a glass
   * panel that scrolls inside itself (head row and first column stay). A `role="grid"`: one tab stop, arrows / Home / End /
   * Ctrl+Home / Ctrl+End move (gridKeys.ts), Enter / Space or a click open the cell's editor (CellPopover); edits go into
   * `stage` (bindable) and the staged cells get the amber outline. The admin role's switches are locked (lock icon, tooltip).
   *   <RoleMatrix {matrix} bind:stage disabled={busy} />
   */
  import { locale, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { PERM_KEYS } from '#lib/perms';
  import CellPopover from './CellPopover.svelte';
  import { gridKey, moveCell, type CellPos } from './gridKeys';
  import {
    cellName, cellText, fieldLabel, peopleLine, roleName, stageSet, visibleFields, type FieldGroup, type MatrixField, type MatrixRole, type RoleMatrix, type Stage,
  } from './model';

  export let matrix: RoleMatrix;
  export let stage: Stage = {};
  /** a save runs: cells do not open */
  export let disabled = false;

  const PERM_SET: ReadonlySet<string> = new Set(PERM_KEYS);

  $: fields = visibleFields(matrix);
  $: roles = matrix.roles;
  /** the visible fields under their groups, in field order */
  $: groups = fields.reduce<Array<{ id: FieldGroup; rows: Array<{ f: MatrixField; r: number }> }>>((acc, f, r) => {
    const last = acc[acc.length - 1];
    if (last && last.id === f.group) last.rows.push({ f, r }); else acc.push({ id: f.group, rows: [{ f, r }] });
    return acc;
  }, []);

  const isStaged = (s: Stage, role: MatrixRole, f: MatrixField): boolean => Object.hasOwn(s[role.key] ?? {}, f.key);
  const valueOf = (s: Stage, role: MatrixRole, f: MatrixField): unknown => (isStaged(s, role, f) ? s[role.key]![f.key] : role.values[f.key]);
  /** the admin role's switches: always on, not editable (its numbers are) */
  const locked = (role: MatrixRole, f: MatrixField): boolean => role.base === 'admin' && PERM_SET.has(f.key);
  /** the cell's tooltip (its accessible description); `_l`: the language, so a switch re-renders it */
  function tip(s: Stage, role: MatrixRole, f: MatrixField, _l: unknown): string | undefined {
    if (locked(role, f)) return tr('adminPeople.roles.adminLocked');
    if (isStaged(s, role, f)) return tr('adminPeople.roles.unsaved');
    const src = role.sources[f.key];
    if (src === 'role') return tr('adminPeople.roles.changedHere');
    if (src === 'env') return tr('adminPeople.roles.fromEnv');
    return undefined;
  }

  // ---- focus (one tab stop) and the editor
  let active: CellPos = { r: 0, c: 0 };
  let editing: CellPos | null = null;
  const cells: Record<string, HTMLElement> = {};
  const key = (p: CellPos) => `${p.r}:${p.c}`;
  $: editKey = editing ? key(editing) : '';
  $: editRole = editing ? roles[editing.c] : undefined;
  $: editField = editing ? fields[editing.r] : undefined;
  $: if (active.r >= fields.length || active.c >= roles.length) active = { r: 0, c: 0 };

  function open(p: CellPos) {
    active = p;
    const role = roles[p.c], f = fields[p.r];
    if (disabled || !role || !f || locked(role, f)) return;
    editing = p;
  }
  function onKey(e: KeyboardEvent) {
    const td = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!td || e.altKey) return;
    const [r, c] = td.dataset.cell!.split(':').map(Number) as [number, number];
    if ((e.key === 'Enter' || e.key === ' ') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); open({ r, c }); return; }
    const to = moveCell({ r, c }, gridKey(e), fields.length, roles.length);
    if (!to) return;
    e.preventDefault();
    active = to;
    cells[key(to)]?.focus();
  }
  function change(v: unknown) {
    if (!editRole || !editField) return;
    stage = stageSet(stage, matrix, editRole.key, editField.key, v);
  }
</script>

<div class="matrix panel">
  <div class="matrix-scroll">
    <!-- the grid owns the keys of its cells (onKey) -->
    <table role="grid" aria-label={$t('adminPeople.roles.matrixLabel')} on:keydown={onKey}>
      <thead>
        <tr>
          <th scope="col" class="corner">{$t('adminPeople.roles.fieldCol')}</th>
          {#each roles as role (role.key)}
            <th scope="col" class="rh"><span class="rn">{roleName(role)}</span><span class="rp">{$locale && peopleLine(role)}</span></th>
          {/each}
        </tr>
      </thead>
      {#each groups as g (g.id)}
        <tbody>
          <tr class="gh">
            <th scope="colgroup" colspan={roles.length + 1}><span class="gl">{$t(`adminPeople.roles.groups.${g.id}`)}</span></th>
          </tr>
          {#each g.rows as { f, r } (f.key)}
            <tr>
              <th scope="row" class="fh">{$locale && fieldLabel(f.key)}</th>
              {#each roles as role, c (role.key)}
                {@const v = valueOf(stage, role, f)}
                {@const staged = isStaged(stage, role, f)}
                {@const lock = locked(role, f)}
                {@const src = role.sources[f.key]}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <td role="gridcell" data-cell="{r}:{c}" bind:this={cells[`${r}:${c}`]} tabindex={active.r === r && active.c === c ? 0 : -1}
                  class:staged class:lock class:on={editKey === `${r}:${c}`} aria-disabled={lock ? 'true' : undefined}
                  aria-label={$locale && cellName(roleName(role), f, v, staged || src === 'role')} title={tip(stage, role, f, $locale)}
                  on:click={() => open({ r, c })} on:focus={() => (active = { r, c })}>
                  <span class="chip" class:bool={f.kind === 'bool'} class:off={f.kind === 'bool' && !v} aria-hidden="true">
                    {#if f.kind === 'bool'}<Icon name={v ? 'check' : 'x'} size={16} />{:else}{$locale && cellText(f, v)}{/if}
                  </span>
                  {#if lock}<span class="lock" aria-hidden="true"><Icon name="lock" size={14} /></span>
                  {:else if src === 'role' || src === 'env'}<span class="dot" class:env={src === 'env'} aria-hidden="true"></span>{/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      {/each}
    </table>
  </div>
</div>

{#key editKey}
  {#if editing && editRole && editField && cells[editKey]}
    <CellPopover trigger={cells[editKey]} title={$t('adminPeople.roles.cellTitle', { role: roleName(editRole), field: fieldLabel(editField.key) })}
      field={editField} value={valueOf(stage, editRole, editField)} libraries={matrix.libraries}
      on:change={(e) => change(e.detail)} on:close={() => (editing = null)} />
  {/if}
{/key}

<style>
  /* the glass panel holds the scroller edge to edge; the scroller keeps the head row and the first column (sticky) */
  .matrix.panel { padding: 0; overflow: hidden; margin-bottom: 0; }
  .matrix-scroll { overflow: auto; max-height: calc(100vh - var(--nav-total, 64px) - 12rem); min-height: 16rem;
    /* a focused cell scrolls clear of the sticky head row, group row and first column */
    scroll-padding: calc(var(--head-h) + var(--group-h)) 0 0 var(--first-w); --head-h: 5.2rem; --group-h: 2.2rem; --first-w: 13rem; }
  table { border-collapse: separate; border-spacing: 0; min-width: 100%; font-size: .92rem; }
  th, td { box-sizing: border-box; }
  thead th { position: sticky; top: 0; z-index: 2; height: var(--head-h); background: var(--fr-solid); border-bottom: 1px solid var(--fr-line); vertical-align: bottom; padding: .6rem .8rem; text-align: left; }
  .corner { left: 0; z-index: 4; width: var(--first-w); min-width: var(--first-w); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .rh { min-width: 8.5rem; }
  .rn { display: block; font-weight: 800; font-size: .98rem; overflow-wrap: anywhere; }
  .rp { display: block; margin-top: .15rem; font-size: .8rem; font-weight: 500; color: var(--mut); }
  /* group rows: sticky under the head row; the label stays at the left edge while the panel scrolls sideways */
  .gh th { position: sticky; top: var(--head-h); z-index: 3; height: var(--group-h); padding: 0; background: var(--fr-solid); border-bottom: 1px solid var(--fr-line); text-align: left; }
  .gl { position: sticky; left: 0; display: inline-block; padding: .5rem .8rem; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .fh { position: sticky; left: 0; z-index: 1; width: var(--first-w); min-width: var(--first-w); padding: .5rem .8rem; background: var(--fr-solid); text-align: left; font-weight: 600; border-bottom: 1px solid rgba(255, 255, 255, .06); }
  td { position: relative; height: 48px; padding: 4px 8px; border-bottom: 1px solid rgba(255, 255, 255, .06); cursor: pointer; outline: none; white-space: nowrap; }
  td.lock { cursor: default; }
  td:focus-visible { box-shadow: none; } /* the ring is drawn inside the cell (::after), not over its neighbours */
  td:hover:not(.lock) .chip { background: rgba(var(--fr-scrim-rgb), .4); }
  /* chips: a darker scrim fill (it only adds contrast; lib/admin/glass.test.ts) */
  .chip { display: inline-flex; align-items: center; min-height: 32px; padding: 0 .7rem; border-radius: var(--fr-r-pill, 99px); background: rgba(var(--fr-scrim-rgb), .25); font-weight: 600; font-variant-numeric: tabular-nums; }
  .chip.bool { color: var(--ok); }
  .chip.off { color: var(--mut); }
  /* a staged cell: the amber outline (spec §6.1); the open one and the focused one: the white ring */
  td.staged::after, td:focus-visible::after, td.on::after { content: ''; position: absolute; inset: 3px; border-radius: 12px; pointer-events: none; }
  td.staged::after { box-shadow: inset 0 0 0 2px var(--warn); }
  td:focus-visible::after, td.on::after { box-shadow: inset 0 0 0 2px #fff, inset 0 0 0 4px var(--ring-dark); }
  td.staged:focus-visible::after, td.staged.on::after { box-shadow: inset 0 0 0 2px var(--warn), inset 0 0 0 4px #fff; }
  .lock { margin-left: .35rem; color: var(--mut); display: inline-grid; vertical-align: middle; }
  /* a value set for this role (or from .env): the small dot; its words are the tooltip and the cell's name */
  .dot { position: absolute; top: 9px; right: 10px; width: 7px; height: 7px; border-radius: 50%; background: var(--info); }
  .dot.env { background: transparent; box-shadow: inset 0 0 0 1.5px var(--info); }
</style>
