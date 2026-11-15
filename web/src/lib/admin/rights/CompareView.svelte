<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Vergleich* on the phone (roles redesign §5.5): one right at a time, every role as a row with its value in words, where it was
   * set ("geändert (Standard: …)", "aus .env") and a *Bearbeiten* link to the role page at that right; read-only, like the matrix.
   * A select picks the right ("Wer darf übertragen?"). The admin role's switches are locked (the lock says so, no link).
   *   <CompareView {matrix} />
   */
  import { locale, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { compareCell } from './compare';
  import { changedFromText, compareQuestion, fieldLabel, roleName, visibleFields, type MatrixField, type MatrixRole, type RoleMatrix } from './model';

  export let matrix: RoleMatrix;

  let picked = '';
  $: if (!picked && fields[0]) picked = fields[0].key;
  $: fields = visibleFields(matrix);
  $: field = fields.find((f) => f.key === picked) ?? fields[0];
  $: options = fields.map((f) => ({ value: f.key, label: $locale && fieldLabel(f.key) }));
  $: question = field ? $locale && compareQuestion(field.key) : '';

  const cellOf = (m: RoleMatrix, r: MatrixRole, f: MatrixField, _l: unknown) => compareCell(m, r, { kind: 'field', field: f });
  /** the value in words: a switch says "erlaubt" / "nicht erlaubt" */
  const words = (c: ReturnType<typeof compareCell>): string => (c.bool ? tr(c.value ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied') : c.text);
  /** under the value: "geändert (Standard: …)" for a role-set value, or that it comes from .env */
  function note(r: MatrixRole, f: MatrixField, _l: unknown): string {
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
    <ul aria-label={question}>
      {#each matrix.roles as r (r.key)}
        {@const c = cellOf(matrix, r, f, $locale)}
        {@const n = note(r, f, $locale)}
        <li class="row panel" data-role={r.key}>
          <div class="tx">
            <span class="nm">{$locale && roleName(r)}</span>
            <span class="val" class:off={c.bool && !c.value}>{#if c.bool}<Icon name={c.value ? 'check' : 'x'} size={16} />{/if}{words(c)}</span>
            {#if c.locked}<span class="note"><Icon name="lock" size={14} />{$t('adminPeople.roles.adminLocked')}</span>{:else if n}<span class="note">{n}</span>{/if}
          </div>
          {#if c.href}<a class="ed" href={c.href} aria-label={$locale && $t('adminPeople.roles.editRole', { name: roleName(r) })}>{$t('adminPeople.roles.edit')}</a>{/if}
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
  .val { display: inline-flex; align-items: center; gap: .35rem; font-weight: 600; color: var(--ok); }
  .val:not(:has(svg)) { color: var(--fg); }
  .val.off { color: var(--mut); }
  .note { display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; color: var(--mut); }
  /* the link to the role page: a 44 px target */
  .ed { flex: none; display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 .9rem; border-radius: 99px;
    background: rgba(var(--fr-scrim-rgb), .25); color: var(--fg); font-weight: 700; font-size: .9rem; text-decoration: none; }
  .ed:hover { background: rgba(var(--fr-scrim-rgb), .4); }
  .ed:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); }
</style>
