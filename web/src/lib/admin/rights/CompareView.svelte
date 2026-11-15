<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Vergleich* on the phone (roles redesign §5.5): one row of the desktop matrix at a time (compare.ts: the Bereiche first, the
   * details by area, the Kanalgruppen), every role as a row with its value in words, where it was set ("geändert (Standard: …)",
   * "aus .env") and a *Bearbeiten* link to the role page at that right (named like the matrix cell: "Gast, Darf aufnehmen:
   * erlaubt, bearbeiten"); read-only, like the matrix. A select picks the row ("Wer hat den Bereich „Mediathek“?", "Wer darf
   * übertragen?"). The admin role's switches and areas are locked (the lock says so, no link).
   *   <CompareView {matrix} />
   */
  import { locale, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { areaLabel } from './areas';
  import { compareCell, compareGroups, rowKey, rowLabel, type CompareRow } from './compare';
  import { changedFromText, compareQuestion, roleName, type MatrixRole, type RoleMatrix } from './model';

  export let matrix: RoleMatrix;

  let picked = '';
  $: rows = compareGroups(matrix).flatMap((g) => g.rows);
  $: if (!picked && rows[0]) picked = rowKey(rows[0]);
  $: row = rows.find((r) => rowKey(r) === picked) ?? rows[0];
  /** `_l`: the language, so a switch re-renders the texts */
  const optionLabel = (r: CompareRow, _l: unknown): string => (r.kind === 'area' ? `${tr('adminPeople.roles.areas.title')}: ${areaLabel(r.area)}` : rowLabel(r));
  const questionOf = (r: CompareRow, _l: unknown): string =>
    (r.kind === 'area' ? tr('adminPeople.roles.compare.qArea', { area: areaLabel(r.area) }) : r.kind === 'groups' ? tr('adminPeople.roles.compare.qGroups') : compareQuestion(r.field.key));
  $: options = rows.map((r) => ({ value: rowKey(r), label: optionLabel(r, $locale) }));
  $: question = row ? questionOf(row, $locale) : '';

  const cellOf = (m: RoleMatrix, r: MatrixRole, x: CompareRow, _l: unknown) => compareCell(m, r, x);
  /** the value in words: a switch or an area says "erlaubt" / "nicht erlaubt" */
  const words = (c: ReturnType<typeof compareCell>): string => (c.bool ? tr(c.value ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied') : c.text);
  /** under the value: "geändert (Standard: …)" for a role-set value, or that it comes from .env (fields only) */
  function note(r: MatrixRole, x: CompareRow, _l: unknown): string {
    if (x.kind !== 'field') return '';
    const src = r.sources[x.field.key];
    if (src === 'role') return changedFromText(r, x.field) ?? tr('adminPeople.roles.changedHere');
    if (src === 'env') return tr('adminPeople.roles.fromEnv');
    return '';
  }
</script>

{#if row}
  {@const x = row}
  <div class="cmp">
    <Select label={question} {options} bind:value={picked} />
    <ul aria-label={question}>
      {#each matrix.roles as r (r.key)}
        {@const c = cellOf(matrix, r, x, $locale)}
        {@const n = note(r, x, $locale)}
        <li class="row panel" data-role={r.key}>
          <div class="tx">
            <span class="nm">{$locale && roleName(r)}</span>
            <span class="val" class:off={c.bool && !c.value}>{#if c.bool}<Icon name={c.value ? 'check' : 'x'} size={16} />{/if}{words(c)}</span>
            {#if c.locked}<span class="note"><Icon name="lock" size={14} />{$t('adminPeople.roles.adminLocked')}</span>{:else if n}<span class="note">{n}</span>{/if}
          </div>
          {#if c.href}<a class="ed" href={c.href} aria-label={c.label}>{$t('adminPeople.roles.edit')}</a>{/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .cmp { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .6rem; }
  .row { margin: 0; min-width: 0; min-height: 64px; box-sizing: border-box; display: flex; align-items: center; gap: .8rem; padding: .6rem .6rem .6rem 1rem; }
  .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
  .nm { font-weight: 700; overflow-wrap: anywhere; }
  .val { display: inline-flex; align-items: center; gap: .35rem; font-weight: 600; color: var(--ok); overflow-wrap: anywhere; }
  .val:not(:has(svg)) { color: var(--fg); }
  .val.off { color: var(--mut); }
  .note { display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; color: var(--mut); }
  /* the link to the role page: a 44 px target */
  .ed { flex: none; display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 .9rem; border-radius: 99px;
    background: rgba(var(--fr-scrim-rgb), .25); color: var(--fg); font-weight: 700; font-size: .9rem; text-decoration: none; }
  .ed:hover { background: rgba(var(--fr-scrim-rgb), .4); }
  .ed:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); }
</style>
