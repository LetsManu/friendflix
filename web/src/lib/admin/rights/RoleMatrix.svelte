<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Rollen & Rechte on the desktop (spec §6.1, §8): every right as a row (under its group), every role as a column, in a glass
   * panel that scrolls inside itself (head row and first column stay). A `role="grid"`: one tab stop, arrows / Home / End /
   * Ctrl+Home / Ctrl+End move (gridKeys.ts), Enter / Space or a click open the cell's editor (CellPopover); edits go into
   * `stage` (bindable) and the staged cells get the amber outline. The admin role's switches are locked (lock icon, tooltip).
   * Every column head has the role's name (a button: opens the role sheet), its people, a drag handle and the role menu
   * (*Bearbeiten*, *Duplizieren*, *Umbenennen*, *Nach links/rechts*, *Verlauf*, *Löschen*). The sheet and the history live here;
   * duplicate, delete and a new order are the page's to run (`duplicate`, `remove`, `move` events: a role, or a role and its new
   * place). The handle drags the column with `transform` only (the neighbours step aside), the menu items are its keyboard way.
   *   <RoleMatrix bind:this={view} {matrix} bind:stage disabled={busy} {status} on:move={…} on:duplicate={…} on:remove={…} />
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { locale, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { PERM_KEYS } from '#lib/perms';
  import ActionMenu from '#lib/ui/ActionMenu.svelte';
  import CellPopover from './CellPopover.svelte';
  import { gridKey, moveCell, type CellPos } from './gridKeys';
  import {
    cellName, cellText, changedFromText, fieldLabel, peopleLine, roleName, stageSet, visibleFields, type FieldGroup, type MatrixField, type MatrixRole, type RoleMatrix, type Stage,
  } from './model';
  import RoleHistory from './RoleHistory.svelte';
  import RoleSheet from './RoleSheet.svelte';

  export let matrix: RoleMatrix;
  export let stage: Stage = {};
  /** a save runs: cells do not open */
  export let disabled = false;
  /** a polite announcement for screen readers (a role moved to a new place) */
  export let status = '';

  const dispatch = createEventDispatcher<{ duplicate: { role: MatrixRole; trigger: HTMLElement | null }; remove: { role: MatrixRole; trigger: HTMLElement | null }; move: { key: string; to: number } }>();

  const PERM_SET: ReadonlySet<string> = new Set(PERM_KEYS);

  $: fields = visibleFields(matrix);
  $: roles = matrix.roles;
  /** the stored roles come first; only they can be ordered */
  $: storedCount = roles.filter((r) => r.stored).length;
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
    if (src === 'role') return changedFromText(role, f) ?? tr('adminPeople.roles.changedHere');
    if (src === 'env') return tr('adminPeople.roles.fromEnv');
    return undefined;
  }

  // ---- focus (one tab stop) and the editor
  let active: CellPos = { r: 0, c: 0 };
  /** the open editor: the role's and the field's key, never grid indices (a reload that shifts the columns keeps it on its role) */
  let editing: { role: string; field: string } | null = null;
  const cells: Record<string, HTMLElement> = {};
  const key = (p: CellPos) => `${p.r}:${p.c}`;
  $: editRole = editing ? roles.find((r) => r.key === editing!.role) : undefined;
  $: editField = editing ? fields.find((f) => f.key === editing!.field) : undefined;
  /** the editor's cell (where it grows out of) and its identity: a role that is gone closes it */
  $: editCell = editRole && editField ? key({ r: fields.indexOf(editField), c: roles.indexOf(editRole) }) : '';
  $: editKey = editing ? `${editing.role}|${editing.field}` : '';
  /** the role or the field of the open editor is gone (a reload): it closes */
  function pruneEdit(rs: MatrixRole[], fs: MatrixField[]) {
    if (editing && (!rs.some((r) => r.key === editing!.role) || !fs.some((f) => f.key === editing!.field))) editing = null;
  }
  $: pruneEdit(roles, fields);
  $: if (active.r >= fields.length || active.c >= roles.length) active = { r: 0, c: 0 };

  function open(p: CellPos) {
    active = p;
    const role = roles[p.c], f = fields[p.r];
    if (disabled || !role || !f || locked(role, f)) return;
    editing = { role: role.key, field: f.key };
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

  // ---- column heads: the name (staged rename shows at once), the menu, the sheets
  const headName = (s: Stage, role: MatrixRole, _l: unknown): string => (Object.hasOwn(s[role.key] ?? {}, 'label') ? String(s[role.key]!.label) : roleName(role));
  /** the open role sheet / history, and the element the focus returns to */
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
  function items(role: MatrixRole, c: number, _l: unknown, _busy: boolean, _n: number) {
    const canDelete = role.origin === 'admin' || role.envGone;
    // a role without a table row (env-only) stays after the stored ones: it cannot move, and nothing moves past it
    const left = disabled || !role.stored || c === 0, right = disabled || !role.stored || c + 1 >= storedCount;
    return [
      { id: 'edit', label: tr('adminPeople.roles.edit'), icon: 'pencil', disabled, run: () => { sheet = { key: role.key, rename: false, trigger: here() }; } },
      { id: 'duplicate', label: tr('adminPeople.roles.duplicate'), icon: 'copy', disabled, run: () => { dispatch('duplicate', { role, trigger: here() }); } },
      // an env-only role has no row for a name: nothing to rename
      ...(role.stored ? [{ id: 'rename', label: tr('adminPeople.roles.rename'), icon: 'pencil', disabled, run: () => { sheet = { key: role.key, rename: true, trigger: here() }; } }] : []),
      { id: 'left', label: tr('adminPeople.roles.moveLeft'), icon: 'chevron-left', disabled: left, run: () => { dispatch('move', { key: role.key, to: c - 1 }); } },
      { id: 'right', label: tr('adminPeople.roles.moveRight'), icon: 'chevron-right', disabled: right, run: () => { dispatch('move', { key: role.key, to: c + 1 }); } },
      { id: 'history', label: tr('adminPeople.roles.history'), icon: 'clock', run: () => { history = { key: role.key, trigger: here() }; } },
      ...(canDelete ? [{ id: 'delete', label: tr('adminPeople.roles.delete'), icon: 'x', danger: true, disabled, run: () => { dispatch('remove', { role, trigger: here() }); } }] : []),
    ];
  }
  /** moves the focus to a column head's name button (a new role) or its menu button (a moved one) */
  export async function focusHead(key: string, what: 'name' | 'menu' = 'name'): Promise<void> {
    await tick();
    const th = document.querySelector<HTMLElement>(`th[data-role="${CSS.escape(key)}"]`);
    th?.querySelector<HTMLElement>(what === 'name' ? '.rn' : '.ma')?.focus();
  }

  // ---- the drag handle: the column follows the pointer by `transform`, the neighbours step aside; the drop settles, then the page reorders
  interface Drag { from: number; to: number; dx: number; w: number; x0: number; settling: boolean }
  let drag: Drag | null = null;
  const still = (): boolean => document.documentElement.classList.contains('m-still') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  function gripDown(e: PointerEvent, c: number) {
    if (disabled || drag || !roles[c]?.stored || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const th = (e.currentTarget as HTMLElement).closest('th');
    if (!th) return;
    e.preventDefault();
    drag = { from: c, to: c, dx: 0, w: th.getBoundingClientRect().width, x0: e.clientX, settling: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function gripMove(e: PointerEvent) {
    if (!drag || drag.settling) return;
    const lo = -drag.from * drag.w, hi = (storedCount - 1 - drag.from) * drag.w;
    const dx = Math.min(hi, Math.max(lo, e.clientX - drag.x0));
    drag = { ...drag, dx, to: Math.min(storedCount - 1, Math.max(0, drag.from + Math.round(dx / drag.w))) };
  }
  function gripUp() {
    if (!drag || drag.settling) return;
    const { from, to, w } = drag;
    if (from === to && drag.dx === 0) { drag = null; return; }
    drag = { ...drag, dx: (to - from) * w, settling: true }; // glides into its place
    setTimeout(() => {
      const key = roles[from]?.key;
      drag = null;
      if (key && from !== to) dispatch('move', { key, to });
    }, still() ? 0 : 200);
  }
  function gripCancel() { if (drag && !drag.settling) drag = null; }
  /** the transform of column `c` while a drag runs */
  function shift(d: Drag | null, c: number): string | undefined {
    if (!d) return undefined;
    if (c === d.from) return `translateX(${d.dx}px)`;
    if (d.from < d.to && c > d.from && c <= d.to) return `translateX(${-d.w}px)`;
    if (d.from > d.to && c < d.from && c >= d.to) return `translateX(${d.w}px)`;
    return undefined;
  }
</script>

<p class="sr-only" aria-live="polite">{status}</p>

<div class="matrix panel">
  <div class="matrix-scroll">
    <!-- the grid owns the keys of its cells (onKey) -->
    <table role="grid" aria-label={$t('adminPeople.roles.matrixLabel')} on:keydown={onKey}>
      <thead>
        <tr>
          <th scope="col" class="corner">{$t('adminPeople.roles.fieldCol')}</th>
          {#each roles as role, c (role.key)}
            <th scope="col" class="rh" data-role={role.key} class:dragging={drag?.from === c} class:glide={drag !== null && drag.from !== c || drag?.settling === true} style:transform={shift(drag, c)}>
              <div class="hd">
                <div class="top">
                  <button type="button" class="rn" {disabled} title={$locale && $t('adminPeople.roles.editRole', { name: headName(stage, role, $locale) })} aria-label={$locale && $t('adminPeople.roles.editRole', { name: headName(stage, role, $locale) })}
                    on:click={(e) => (sheet = { key: role.key, rename: false, trigger: e.currentTarget })}><span class="rnt">{headName(stage, role, $locale)}</span></button>
                </div>
                <span class="rp">{#each ($locale && peopleLine(role) || '').split(' · ') as seg, i}{#if i}{' · '}{/if}<span class="seg">{seg}</span>{/each}</span>
                {#if role.envGone}<span class="rt">{$t('adminPeople.roles.envGone')}</span>{:else if role.origin === 'env'}<span class="rt">{$t('adminPeople.roles.fromEnv')}</span>{/if}
                <!-- the pointer's way to reorder; keyboard and screen reader use Nach links / Nach rechts in the menu -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span class="grip" class:off={disabled || !role.stored} aria-hidden="true" title={$t('adminPeople.roles.dragHandle')} on:pointerdown={(e) => gripDown(e, c)} on:pointermove={gripMove}
                  on:pointerup={gripUp} on:pointercancel={gripCancel} on:lostpointercapture={gripCancel}>
                  <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="2" r="1.4" /><circle cx="6" cy="2" r="1.4" /><circle cx="2" cy="7" r="1.4" /><circle cx="6" cy="7" r="1.4" /><circle cx="2" cy="12" r="1.4" /><circle cx="6" cy="12" r="1.4" /></svg>
                </span>
                <span class="mn"><ActionMenu label={$locale && $t('ui.table.actionsFor', { name: roleName(role) })} title={roleName(role)} items={items(role, c, $locale, disabled, storedCount)} /></span>
              </div>
            </th>
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
                  class:staged class:lock class:on={editing?.role === role.key && editing.field === f.key} class:dragging={drag?.from === c} class:glide={drag !== null && drag.from !== c || drag?.settling === true}
                  style:transform={shift(drag, c)} aria-disabled={lock ? 'true' : undefined}
                  aria-label={$locale && cellName(roleName(role), f, v, staged ? 'unsaved' : src === 'role')} title={tip(stage, role, f, $locale)}
                  on:click={() => open({ r, c })} on:focus={() => (active = { r, c })}>
                  <span class="chip" class:bool={f.kind === 'bool'} class:off={f.kind === 'bool' && !v} aria-hidden="true">
                    {#if f.kind === 'bool'}<Icon name={v ? 'check' : 'x'} size={16} />{:else}{$locale && cellText(f, v)}{/if}
                  </span>
                  {#if lock}<span class="lk" aria-hidden="true"><Icon name="lock" size={14} /></span>
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

{#if sheet && sheetRole}
  <RoleSheet {matrix} role={sheetRole} bind:stage focusName={sheet.rename} trigger={sheet.trigger} on:close={() => (sheet = null)} />
{/if}
{#if history && historyRole}
  <RoleHistory role={historyRole} trigger={history.trigger} names={(k) => { const r = roles.find((x) => x.key === k); return r ? roleName(r) : null; }} on:close={() => (history = null)} />
{/if}

{#key editKey}
  {#if editing && editRole && editField && cells[editCell]}
    <CellPopover trigger={cells[editCell]} title={$t('adminPeople.roles.cellTitle', { role: roleName(editRole), field: fieldLabel(editField.key) })}
      field={editField} value={valueOf(stage, editRole, editField)} libraries={matrix.libraries}
      on:change={(e) => change(e.detail)} on:close={() => (editing = null)} />
  {/if}
{/key}

<style>
  /* the glass panel holds the scroller edge to edge; the scroller keeps the head row and the first column (sticky) */
  .matrix.panel { padding: 0; overflow: hidden; margin-bottom: 0; }
  .matrix-scroll { overflow: auto; max-height: calc(100vh - var(--nav-total, 64px) - 12rem); min-height: 16rem;
    /* a focused cell scrolls clear of the sticky head row, group row and first column */
    scroll-padding: calc(var(--head-h) + var(--group-h)) 0 0 var(--first-w); --head-h: 6.8rem; --group-h: 2.2rem; --first-w: 11rem; }
  table { border-collapse: separate; border-spacing: 0; min-width: 100%; font-size: .92rem; }
  th, td { box-sizing: border-box; }
  thead th { position: sticky; top: 0; z-index: 2; height: var(--head-h); background: var(--fr-solid); border-bottom: 1px solid var(--fr-line); vertical-align: bottom; padding: .6rem .8rem; text-align: left; }
  .corner { left: 0; z-index: 4; width: var(--first-w); min-width: var(--first-w); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .rh { min-width: 9rem; padding: .4rem .3rem .5rem 1rem; vertical-align: top; }
  /* the head: the name beside the menu button (top right), the people under both; the drag handle sits in the left padding */
  .hd { position: relative; min-width: 0; }
  .top { display: flex; align-items: center; min-height: 40px; padding-right: 40px; }
  .mn { position: absolute; top: -2px; right: -4px; display: flex; z-index: 2; }
  /* a 44 px target (negative margins keep the head's height): the button is taller than the text, which clamps to two lines inside it */
  .rn { display: flex; flex: 1 1 auto; min-width: 0; align-items: center; justify-content: flex-start; max-width: 100%; min-height: 44px; margin: -2px 0; padding: 0; border: 0; border-radius: 4px; background: transparent;
    color: inherit; font: inherit; font-weight: 800; font-size: .98rem; text-align: left; cursor: pointer; position: relative; z-index: 1; }
  .rnt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; min-width: 0; overflow-wrap: anywhere; hyphens: auto; }
  .rn:disabled { cursor: default; text-decoration: none; }
  /* a count stays with its noun ("0 Kinderprofile" never splits) */
  .seg { white-space: nowrap; }
  .rn:hover:not(:disabled) { text-decoration: underline; }
  .rt { display: block; font-size: .75rem; color: var(--mut); }
  /* the drag handle: a pointer-only grip (the menu has the keyboard way); the column moves by transform, never by layout */
  .grip { position: absolute; left: -.85rem; top: 0; display: grid; place-items: center; width: 14px; height: 40px; color: var(--mut); cursor: grab; touch-action: none; border-radius: 6px; opacity: .6; }
  .grip:hover { color: var(--fg); background: rgba(255, 255, 255, .08); opacity: 1; }
  .grip.off { cursor: default; opacity: .3; }
  /* a 44 px target: the pointer reaches past the dots (the name button and the menu sit above it) */
  .grip::after { content: ''; position: absolute; inset: -2px -15px -2px -15px; }
  th.dragging, td.dragging { z-index: 5; }
  th.dragging { background: var(--fr-solid); }
  .glide { transition: transform 180ms var(--fr-out); }
  .dragging.glide { transition: transform 200ms var(--fr-out); }
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
  .lk { margin-left: .35rem; color: var(--mut); display: inline-grid; vertical-align: middle; }
  /* a value set for this role (or from .env): the small dot; its words are the tooltip and the cell's name */
  .dot { position: absolute; top: 9px; right: 10px; width: 7px; height: 7px; border-radius: 50%; background: var(--info); }
  .dot.env { background: transparent; box-shadow: inset 0 0 0 1.5px var(--info); }
  /* calm mode and reduced motion: the columns step aside at once */
  :global(html.m-still) .matrix :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .matrix :global(*) { transition: none !important; animation: none !important; } }
</style>
