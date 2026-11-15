<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Rollen (roles redesign §5.1): one row per role, at every width. The row is a link to the role's page (its name; the link's
   * hit area covers the row) and reads: the name with its chips ("Admin", "aus .env", "nicht mehr in .env"), the areas
   * ("Mediathek · Live-TV · Wünsche", "Nur Live-TV", "Nichts freigegeben"; Live-TV without a channel group warns), and the
   * people as a link to Personen filtered by the role. The ⋯ menu (a 44 px button outside the link): *Bearbeiten*,
   * *Duplizieren*, *Nach oben*, *Nach unten*, *Verlauf*, *Löschen* (env-only roles cannot move or go; built-ins cannot go).
   * A moved row glides to its place by transform (`flip`). Duplicate, delete and the order are the page's to run.
   *   <RoleList bind:this={list} {matrix} {stage} disabled={busy} {status} on:move={…} on:duplicate={…} on:remove={…} />
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { fxMode, outEase } from '#lib/glass/fx';
  import Icon from '#lib/Icon.svelte';
  import { locale, t, tr } from '#lib/i18n';
  import ActionMenu from '#lib/ui/ActionMenu.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { areaSummary, stagedAreas } from './areas';
  import { peopleLine, roleName, type MatrixRole, type RoleMatrix, type Stage } from './model';
  import RoleHistory from './RoleHistory.svelte';

  export let matrix: RoleMatrix;
  /** staged edits of the compare view: a row reads as it would after saving and says it is not saved */
  export let stage: Stage = {};
  /** a save runs: the menu's writes wait */
  export let disabled = false;
  /** a polite announcement for screen readers (a role moved to a new place) */
  export let status = '';

  const dispatch = createEventDispatcher<{ duplicate: { role: MatrixRole; trigger: HTMLElement | null }; remove: { role: MatrixRole; trigger: HTMLElement | null }; move: { key: string; to: number } }>();

  $: roles = matrix.roles;
  $: storedCount = roles.filter((r) => r.stored).length;
  const dirty = (s: Stage, r: MatrixRole): boolean => Object.keys(s[r.key] ?? {}).length > 0;
  const nameOf = (s: Stage, r: MatrixRole, _l: unknown): string => (Object.hasOwn(s[r.key] ?? {}, 'label') ? String(s[r.key]!.label) : roleName(r));
  /** Live-TV on (as staged) and not one released group: the role sees no channel (the admin role sees every released group) */
  const noGroups = (s: Stage, r: MatrixRole, m: RoleMatrix): boolean => {
    if (!m.features.livetv || r.key === 'admin' || !stagedAreas(s, r).livetv) return false;
    const ids = Object.hasOwn(s[r.key] ?? {}, 'livetvGroups') ? (s[r.key]!.livetvGroups as string[]) : (r.livetvGroupIds ?? []);
    return ids.length === 0;
  };
  const href = (r: MatrixRole) => `/admin/roles/${encodeURIComponent(r.key)}`;

  let history: { key: string; trigger: HTMLElement | null } | null = null;
  $: historyRole = history ? roles.find((r) => r.key === history!.key) : undefined;
  const here = (): HTMLElement | null => (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  /** a menu item runs after the menu closed and gave the focus back to its button: that is where the focus returns to */
  function items(role: MatrixRole, i: number, _l: unknown, _busy: boolean, _n: number) {
    const canDelete = role.origin === 'admin' || role.envGone;
    // an env-only role stays after the stored ones: it cannot move, and nothing moves past it
    const up = disabled || !role.stored || i === 0, down = disabled || !role.stored || i + 1 >= storedCount;
    return [
      { id: 'edit', label: tr('adminPeople.roles.edit'), icon: 'pencil', href: href(role) },
      { id: 'duplicate', label: tr('adminPeople.roles.duplicate'), icon: 'copy', disabled, run: () => { dispatch('duplicate', { role, trigger: here() }); } },
      { id: 'up', label: tr('adminPeople.roles.moveUp'), icon: 'chevron-up', disabled: up, run: () => { dispatch('move', { key: role.key, to: i - 1 }); } },
      { id: 'down', label: tr('adminPeople.roles.moveDown'), icon: 'chevron-down', disabled: down, run: () => { dispatch('move', { key: role.key, to: i + 1 }); } },
      { id: 'history', label: tr('adminPeople.roles.history'), icon: 'clock', run: () => { history = { key: role.key, trigger: here() }; } },
      ...(canDelete ? [{ id: 'delete', label: tr('adminPeople.roles.delete'), icon: 'x', danger: true, disabled, run: () => { dispatch('remove', { role, trigger: here() }); } }] : []),
    ];
  }

  /** moves the focus to a row's link (a new role) or its menu button (a moved one) */
  export async function focusHead(key: string, what: 'name' | 'menu' = 'name'): Promise<void> {
    await tick();
    const li = document.querySelector<HTMLElement>(`li[data-role="${CSS.escape(key)}"]`);
    li?.querySelector<HTMLElement>(what === 'name' ? 'a.name' : '.ma')?.focus();
  }
  /** the glide of a moved row: transform only, on the glass curve; at once in calm mode and with reduced motion */
  const glide = () => ({ duration: fxMode() === 'full' ? 260 : 0, easing: outEase });
</script>

<p class="sr-only" aria-live="polite">{status}</p>

<ul class="list" aria-label={$t('adminPeople.roles.viewRoles')}>
  {#each roles as role, i (role.key)}
    {@const n = nameOf(stage, role, $locale)}
    {@const warn = noGroups(stage, role, matrix)}
    <li class="row panel edge-hover" class:dirty={dirty(stage, role)} data-role={role.key} animate:flip={glide()}>
      <div class="main">
        <div class="head">
          <a class="name" href={href(role)} aria-describedby="rl-{i}-s">{n}</a>
          {#if role.base === 'admin' && role.key !== 'admin'}<span class="chip">{$t('admin.roleNames.admin')}</span>{/if}
          {#if role.envGone}<span class="chip">{$t('adminPeople.roles.envGone')}</span>{:else if role.origin === 'env'}<span class="chip">{$t('adminPeople.roles.fromEnv')}</span>{/if}
          {#if dirty(stage, role)}<StatusPill tone="warn" label={$t('adminPeople.roles.unsaved')} icon="clock" />{/if}
        </div>
        <p class="sum" id="rl-{i}-s">
          <span>{$locale && areaSummary(stagedAreas(stage, role), matrix.features)}</span>
          {#if warn}<span class="warn"><Icon name="alert" size={15} />{$t('adminPeople.roles.summary.noGroups')}</span>{/if}
        </p>
      </div>
      <a class="pp" href="/admin/users?role={encodeURIComponent(role.key)}"><Icon name="users" size={16} /><span>{$locale && peopleLine(role)}</span></a>
      <span class="mn"><ActionMenu label={$locale && $t('ui.table.actionsFor', { name: n })} title={n} items={items(role, i, $locale, disabled, storedCount)} /></span>
    </li>
  {/each}
</ul>

{#if history && historyRole}
  <RoleHistory role={historyRole} trigger={history.trigger} names={(k) => { const r = roles.find((x) => x.key === k); return r ? roleName(r) : null; }} on:close={() => (history = null)} />
{/if}

<style>
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .6rem; }
  /* a row: the texts, the people link and the ⋯ button; the name's link covers the whole row (its ::after), the people link
     and the menu sit above it */
  .row { position: relative; margin: 0; min-height: 64px; box-sizing: border-box; padding: .7rem .6rem .7rem 1.1rem; display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: .2rem .6rem; }
  .row.dirty { border-color: var(--warn); }
  .main { min-width: 0; display: flex; flex-direction: column; gap: .2rem; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .5rem; min-width: 0; }
  .name { color: var(--fg); font-size: 1.05rem; font-weight: 800; text-decoration: none; overflow-wrap: anywhere; outline: none; }
  .name::after { content: ''; position: absolute; inset: 0; border-radius: inherit; z-index: 0; }
  .name:hover { text-decoration: underline; text-underline-offset: 3px; }
  /* the ring goes around the row the link covers */
  .row:has(.name:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 5px var(--ring-dark); }
  .chip { display: inline-flex; align-items: center; min-height: 22px; padding: 0 .55rem; border-radius: 99px; background: var(--wash-muted); color: var(--mut); font-size: .75rem; font-weight: 600; white-space: nowrap; }
  .sum { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .15rem .9rem; font-size: .92rem; color: var(--mut); }
  .warn { display: inline-flex; align-items: center; gap: .35rem; color: var(--warn); font-weight: 600; }
  .warn :global(svg) { flex: none; }
  .pp, .mn { position: relative; z-index: 1; }
  .pp { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; padding: 0 .6rem; border-radius: 10px; color: var(--mut); font-size: .88rem; text-decoration: none; white-space: nowrap; }
  .pp:hover { color: var(--fg); text-decoration: underline; text-underline-offset: 3px; }
  .pp :global(svg) { flex: none; }
  .mn { display: flex; }
  /* phones: the people link under the texts, the ⋯ button stays top right */
  @media (max-width: 600px) {
    .row { grid-template-columns: minmax(0, 1fr) auto; align-items: start; padding: .55rem .5rem .1rem 1rem; row-gap: 0; }
    .main { grid-column: 1; grid-row: 1; padding-top: .3rem; }
    .mn { grid-column: 2; grid-row: 1; }
    .pp { grid-column: 1 / -1; grid-row: 2; justify-self: start; margin-left: -.6rem; }
  }
  :global(html.m-still) .list :global(*) { transition: none !important; animation: none !important; }
</style>
