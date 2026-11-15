<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One section of the role page (roles redesign §5.3): a `.panel` region named by its title with the area's detail fields, each a
   * `FieldControl` with its marker line under it ("aus .env", "geändert (Standard: …)", "nicht gespeichert"; the line is always
   * there, so nothing moves when a value is staged). The slot adds what is not a field (the channel groups, the invitable switch).
   * A section fades in (opacity) when its area is switched on; it goes at once, so what is below moves only as the press's result.
   *   <AreaSection title="Mediathek" icon="film" fields={fieldsOfArea(m, 'library')} {role} {stage} {matrix} on:change={(e) => …} />
   */
  import { createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { fxMode } from '#lib/glass/fx';
  import Icon from '#lib/Icon.svelte';
  import { locale, tr } from '#lib/i18n';
  import { uid } from '#lib/ui/ids';
  import FieldControl from './FieldControl.svelte';
  import { changedFromText, type MatrixField, type MatrixRole, type RoleMatrix, type Stage } from './model';

  export let title: string;
  export let icon = '';
  export let fields: MatrixField[] = [];
  export let role: MatrixRole;
  export let stage: Stage;
  export let matrix: RoleMatrix;
  /** a save runs: every control is locked */
  export let disabled = false;

  const dispatch = createEventDispatcher<{ change: { key: string; value: unknown } }>();
  const id = uid('as');
  const isStaged = (s: Stage, f: MatrixField): boolean => Object.hasOwn(s[role.key] ?? {}, f.key);
  const valueOf = (s: Stage, f: MatrixField): unknown => (isStaged(s, f) ? s[role.key]![f.key] : role.values[f.key]);
  /** under a control: staged, "geändert (Standard: …)" for a role-set value, or that it comes from .env */
  function mark(s: Stage, f: MatrixField, _l: unknown): string {
    if (isStaged(s, f)) return tr('adminPeople.roles.unsaved');
    const src = role.sources[f.key];
    if (src === 'role') return changedFromText(role, f) ?? tr('adminPeople.roles.changedHere');
    if (src === 'env') return tr('adminPeople.roles.fromEnv');
    return '';
  }
  const appear = (node: Element) => fade(node, { duration: fxMode() === 'full' ? 180 : 0 });
</script>

<section class="sec panel" aria-labelledby="{id}-t" in:appear>
  <h3 id="{id}-t">{#if icon}<Icon name={icon} size={18} />{/if}<span>{title}</span></h3>
  {#if fields.length}<div class="fields">
  {#each fields as f (f.key)}
    <div class="fr" class:staged={isStaged(stage, f)} data-field={f.key}>
      <FieldControl field={f} value={valueOf(stage, f)} libraries={matrix.libraries} {disabled} keepOne={role.base === 'admin'}
        on:change={(e) => dispatch('change', { key: f.key, value: e.detail })} />
      <p class="mark" class:on={mark(stage, f, $locale) !== ''}>{mark(stage, f, $locale)}</p>
    </div>
  {/each}
  </div>{/if}
  <slot />
</section>

<style>
  .sec { margin: 0; padding: 1.1rem 1.2rem 1rem; display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
  h3 { margin: 0 0 .3rem; display: flex; align-items: center; gap: .5rem; font-size: 1.02rem; font-weight: 800; }
  h3 :global(svg) { color: var(--mut); flex: none; }
  /* two columns where there is room (the library checklist spans both), one on phones */
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .3rem 1.6rem; align-items: start; }
  .fr[data-field='libraries'] { grid-column: 1 / -1; }
  @media (max-width: 699px) { .fields { grid-template-columns: minmax(0, 1fr); } }
  /* a staged field: the amber rail of the matrix's staged cell, on the left of its control */
  .fr { padding-left: .7rem; margin-left: -.7rem; border-left: 3px solid transparent; min-width: 0; }
  .fr.staged { border-left-color: var(--warn); }
  .mark { margin: .2rem 0 0; min-height: 1.5em; line-height: 1.5; font-size: .8rem; color: var(--mut); }
  .fr.staged .mark { color: var(--warn); }
</style>
