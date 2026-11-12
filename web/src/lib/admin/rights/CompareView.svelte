<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Vergleich* on the phone (spec §6.1): one right at a time, every role as a row with the right's own control (switch, number,
   * preset, library list), so the roles can be compared where the matrix does not fit. A select picks the right ("Wer darf
   * übertragen?"). Edits go into `stage` like the matrix's cells (the save bar counts them); the admin's switches are locked.
   *   <CompareView {matrix} bind:stage />
   */
  import { locale, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { PERM_KEYS } from '#lib/perms';
  import Select from '#lib/ui/Select.svelte';
  import FieldControl from './FieldControl.svelte';
  import { cellText, changedFromText, compareQuestion, fieldLabel, roleName, stageSet, visibleFields, type MatrixField, type MatrixRole, type RoleMatrix, type Stage } from './model';

  export let matrix: RoleMatrix;
  export let stage: Stage = {};

  const PERM_SET: ReadonlySet<string> = new Set(PERM_KEYS);

  let picked = '';
  $: if (!picked && fields[0]) picked = fields[0].key;
  $: fields = visibleFields(matrix);
  $: field = fields.find((f) => f.key === picked) ?? fields[0];
  $: options = fields.map((f) => ({ value: f.key, label: $locale && fieldLabel(f.key) }));
  $: question = field ? $locale && compareQuestion(field.key) : '';

  const isStaged = (s: Stage, r: MatrixRole, f: MatrixField): boolean => Object.hasOwn(s[r.key] ?? {}, f.key);
  const valueOf = (s: Stage, r: MatrixRole, f: MatrixField): unknown => (isStaged(s, r, f) ? s[r.key]![f.key] : r.values[f.key]);
  const nameOf = (s: Stage, r: MatrixRole, _l: unknown): string => (Object.hasOwn(s[r.key] ?? {}, 'label') ? String(s[r.key]!.label) : roleName(r));
  const locked = (r: MatrixRole, f: MatrixField): boolean => r.base === 'admin' && PERM_SET.has(f.key);
  /** under a role's control: what it was staged from, "geändert (Standard: …)" for a role-set value, or that it comes from .env */
  function note(s: Stage, r: MatrixRole, f: MatrixField, _l: unknown): string {
    if (isStaged(s, r, f)) return tr('adminPeople.roles.unsaved');
    const src = r.sources[f.key];
    if (src === 'role') return changedFromText(r, f) ?? tr('adminPeople.roles.changedHere');
    if (src === 'env') return tr('adminPeople.roles.fromEnv');
    return '';
  }
</script>

{#if field}
  {@const f = field}
  <div class="cmp">
    <Select label={question} {options} bind:value={picked} />
    <ul>
      {#each matrix.roles as r (r.key)}
        {@const n = nameOf(stage, r, $locale)}
        <li class="row panel" class:staged={isStaged(stage, r, f)} data-role={r.key}>
          {#if locked(r, f)}
            <div class="lockrow">
              <span class="nm">{n}</span>
              <span class="lk"><Icon name="lock" size={16} /> {$t('adminPeople.roles.adminLocked')}</span>
            </div>
          {:else}
            <FieldControl field={f} name={n} value={valueOf(stage, r, f)} libraries={matrix.libraries} on:change={(e) => (stage = stageSet(stage, matrix, r.key, f.key, e.detail))} />
            <!-- the line is always there: a staged or stored value adds its words without moving the rows -->
            <p class="note" class:on={note(stage, r, f, $locale) !== ''}>{note(stage, r, f, $locale)}</p>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="sr-only" aria-live="polite">{$locale && question}: {matrix.roles.map((r) => `${nameOf(stage, r, $locale)} ${cellText(f, valueOf(stage, r, f))}`).join(', ')}</p>
  </div>
{/if}

<style>
  .cmp { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .6rem; }
  /* a staged row: the amber rail of the matrix's staged cell */
  .row { margin: 0; min-width: 0; display: flex; flex-direction: column; gap: .3rem; border-left: 3px solid transparent; }
  .row.staged { border-left-color: var(--warn); }
  .lockrow { display: flex; flex-direction: column; gap: .3rem; min-height: 44px; justify-content: center; }
  .nm { font-weight: 700; overflow-wrap: anywhere; }
  .lk { display: flex; align-items: center; gap: .4rem; color: var(--mut); font-size: .88rem; }
  .note { margin: 0; min-height: 1.3em; font-size: .82rem; color: var(--mut); opacity: 0; }
  .note.on { opacity: 1; }
</style>
