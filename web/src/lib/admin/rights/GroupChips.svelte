<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The channel groups of a role on its page (roles redesign §5.3, §8): every released group as a toggle chip (44 px, the name, a
   * "Kinderfreundlich" mark, "12 Kanäle"; `aria-pressed` buttons in a group "Kanalgruppen von {role}"), with *Alle* / *Keine*
   * above. A line under the chips that is always there says what matters: no group chosen ("Ohne Kanalgruppe sieht diese Rolle
   * kein Live-TV."), Live-TV switched off (the chips stay listed, dimmed and locked: "Gespeichert, wirkt wenn Live-TV an ist"),
   * or an env-only role ("Steht in der .env": its grants need a catalogue row). The admin role sees every released group. Below:
   * the groups waiting for a release and *Gruppen verwalten*. `change` carries the chosen ids in group order; the page stages them
   * as `livetvGroups`.
   *   <GroupChips roleName="Freund" groups={m.livetv.groups} chosen={ids} pending={m.livetv.pending} mode="edit" dormant={!areas.livetv} on:change={…} />
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { locale, t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { uid } from '#lib/ui/ids';
  import type { LivetvGroupInfo } from './model';

  export let roleName: string;
  export let groups: LivetvGroupInfo[];
  export let chosen: string[];
  /** groups waiting for a release */
  export let pending = 0;
  /** 'admin': every released group, nothing to choose; 'env': an env-only role (no catalogue row), locked */
  export let mode: 'edit' | 'admin' | 'env' = 'edit';
  /** Live-TV is switched off: the grants stay stored and shown, dimmed */
  export let dormant = false;
  /** a save runs */
  export let disabled = false;

  const dispatch = createEventDispatcher<{ change: string[] }>();
  const id = uid('gc');
  $: set = new Set(chosen);
  $: locked = disabled || dormant || mode === 'env';
  const pick = (ids: Set<string>) => dispatch('change', groups.filter((g) => ids.has(g.id)).map((g) => g.id));
  function flip(gid: string) {
    if (locked) return;
    const next = new Set(set);
    if (next.has(gid)) next.delete(gid); else next.add(gid);
    pick(next);
  }
  /** the line under the chips: why they are locked, or that the role sees no channel */
  function lineOf(m: typeof mode, off: boolean, n: number, _l: unknown): { text: string; warn: boolean; icon: string } | null {
    if (m === 'env') return { text: tr('adminPeople.roles.page.envLocked'), warn: false, icon: 'lock' };
    if (off) return { text: tr('adminPeople.roles.groups.dormant'), warn: false, icon: 'info' };
    return n ? null : { text: tr('adminPeople.roles.groups.empty'), warn: true, icon: 'alert' };
  }
  $: line = lineOf(mode, dormant, chosen.length, $locale);
</script>

<div class="gc">
  {#if mode === 'admin'}
    <p class="all"><Icon name="check" size={18} />{$t('adminPeople.roles.groups.adminAll')}</p>
  {:else}
    <div class="quick">
      <Button variant="ghost" size="sm" disabled={locked || !groups.length || chosen.length === groups.length} on:click={() => pick(new Set(groups.map((g) => g.id)))}>{$t('adminPeople.roles.groups.all')}</Button>
      <Button variant="ghost" size="sm" disabled={locked || !chosen.length} on:click={() => pick(new Set())}>{$t('adminPeople.roles.groups.none')}</Button>
    </div>
    <div class="chips" data-groups class:dim={dormant || mode === 'env'} role="group" aria-label={$locale && tr('adminPeople.roles.groups.label', { role: roleName })} aria-describedby="{id}-l">
      {#each groups as g (g.id)}
        <button type="button" class="chip" class:on={set.has(g.id)} aria-pressed={set.has(g.id)} disabled={locked} on:click={() => flip(g.id)}>
          <span class="ck" aria-hidden="true"><Icon name="check" size={14} /></span>
          <span class="nm">{g.name}</span>
          {#if g.kidFriendly}<span class="kid">{$t('adminLive.grp.kidFriendly')}</span>{/if}
          <span class="n">{$locale && tr('adminPeople.roles.groups.channels', { n: g.channels })}</span>
        </button>
      {/each}
    </div>
    <!-- the line is always there: a warning that comes or goes moves nothing -->
    <p class="line" class:warn={line?.warn} id="{id}-l">{#if line}<Icon name={line.icon} size={15} />{line.text}{/if}</p>
  {/if}
  <p class="links">
    {#if pending > 0}<a href="/admin/livetv?tab=groups&pending=1">{$locale && tr('adminPeople.roles.groups.pending', { n: pending })}</a>{/if}
    <a href="/admin/livetv?tab=groups">{$t('adminPeople.roles.groups.manage')}</a>
  </p>
</div>

<style>
  .gc { display: flex; flex-direction: column; gap: .6rem; min-width: 0; }
  .all { margin: 0; display: flex; align-items: center; gap: .45rem; min-height: 44px; font-weight: 600; }
  .all :global(svg) { color: var(--ok); }
  .quick { display: flex; gap: .4rem; flex-wrap: wrap; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; }
  .chips.dim { opacity: .55; }
  .chip { min-height: 44px; padding: 0 .9rem 0 .6rem; gap: .45rem; border-radius: 999px; background: rgba(var(--fr-scrim-rgb), .3); color: var(--fg);
    box-shadow: inset 0 0 0 1px var(--fr-line); font-weight: 600; font-size: .9rem; max-width: 100%; }
  .chip:hover:not(:disabled) { background: rgba(var(--fr-scrim-rgb), .45); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .42); }
  .chip:active:not(:disabled) { transform: none; }
  .chip.on { background: rgba(var(--acc-rgb), .2); box-shadow: inset 0 0 0 1.5px var(--acc); }
  .chip.on:hover:not(:disabled) { background: rgba(var(--acc-rgb), .28); }
  .chip:disabled { cursor: default; }
  /* the check's room is always there: a chip keeps its width when it is ticked */
  .ck { width: 18px; height: 18px; flex: none; display: grid; place-items: center; border-radius: 50%; background: rgba(255, 255, 255, .12); color: transparent; }
  .chip.on .ck { background: var(--acc-fill); color: #fff; }
  .nm { overflow-wrap: anywhere; text-align: left; }
  .kid { font-size: .72rem; font-weight: 700; padding: .1rem .45rem; border-radius: 99px; background: var(--wash-ok); color: var(--ok); white-space: nowrap; }
  .n { font-size: .8rem; font-weight: 500; color: var(--mut); white-space: nowrap; }
  /* one line of room (two on phones, where the warning wraps), fixed: the chips above and the links below never move */
  .line { margin: 0; height: 1.4em; line-height: 1.4; display: flex; align-items: flex-start; gap: .4rem; font-size: .86rem; color: var(--mut); }
  .line :global(svg) { margin-top: .12em; }
  @media (max-width: 599px) { .line { height: 2.8em; } }
  .line.warn { color: var(--warn); font-weight: 600; }
  .line :global(svg) { flex: none; }
  .links { margin: 0; display: flex; flex-wrap: wrap; gap: 0 1.2rem; }
  .links a { display: inline-flex; align-items: center; min-height: 44px; color: var(--link, var(--info)); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
</style>
