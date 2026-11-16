<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Bereiche* of the role page (roles redesign §5.3, §8): one large card per area this server has (Mediathek, Live-TV, Wünsche,
   * Gemeinsam, Downloads), each with its icon, title, one-line description and a switch. The switch (`role="switch"`, named by
   * the title, described by the description and the reason it is locked) covers the whole card, so the card is the target.
   * Locked cards (the admin role; Wünsche, Gemeinsam and Downloads while the Mediathek is off) stay focusable and say why on a
   * line that is always there. Two columns from 600 px, one on phones; nothing in the grid changes size when a switch flips
   * (the knob moves by transform, a pressed card does not shrink). `toggle` carries the area and its new state.
   *   <AreaGrid {role} areas={stagedAreas(stage, role)} features={matrix.features} disabled={saving} on:toggle={(e) => …} />
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { locale, t, tr } from '#lib/i18n';
  import { uid } from '#lib/ui/ids';
  import { AREA_ICON, areaDisabled, areaLabel, shownAreas, type AreaKey, type Areas } from './areas';
  import type { Feature, MatrixRole } from './model';

  export let role: Pick<MatrixRole, 'base'>;
  /** the areas as staged (coupled) */
  export let areas: Areas;
  export let features: Record<Feature, boolean>;
  /** a save runs: nothing switches */
  export let disabled = false;

  const dispatch = createEventDispatcher<{ toggle: { area: AreaKey; on: boolean } }>();
  const id = uid('ag');
  const desc = (a: AreaKey, _l: unknown) => tr(`adminPeople.roles.areas.${a}Desc`);
  const why = (r: 'needsLibrary' | 'admin' | null, _l: unknown) => (r === 'admin' ? tr('adminPeople.roles.areas.adminLocked') : r === 'needsLibrary' ? tr('adminPeople.roles.areas.needsLibrary') : '');

  function press(a: AreaKey, lock: unknown) {
    if (lock || disabled) return;
    dispatch('toggle', { area: a, on: !areas[a] });
  }
</script>

<section class="ag" aria-labelledby="{id}-t">
  <h3 id="{id}-t">{$t('adminPeople.roles.areas.title')}</h3>
  <ul class="grid">
    {#each shownAreas(features) as a (a)}
      {@const lock = areaDisabled(role, a, areas)}
      <li class="card panel edge-hover" class:on={areas[a]} class:locked={lock !== null} data-area={a}>
        <span class="ic" aria-hidden="true"><Icon name={AREA_ICON[a]} size={22} /></span>
        <span class="tx">
          <span class="ti" id="{id}-{a}-t">{$locale && areaLabel(a)}</span>
          <span class="de" id="{id}-{a}-d">{desc(a, $locale)}</span>
          <!-- the reason's two lines are always there: it wraps in narrow columns, and a card never grows when it locks -->
          <span class="why" id="{id}-{a}-w">{#if lock}<Icon name="lock" size={13} />{/if}{why(lock, $locale)}</span>
        </span>
        <button type="button" class="sw" class:on={areas[a]} role="switch" aria-checked={areas[a]} aria-labelledby="{id}-{a}-t" aria-describedby="{id}-{a}-d {id}-{a}-w"
          aria-disabled={lock || disabled ? 'true' : undefined} on:click={() => press(a, lock)}><span class="track" aria-hidden="true"><span class="knob"></span></span></button>
      </li>
    {/each}
  </ul>
</section>

<style>
  .ag { min-width: 0; }
  h3 { margin: 0 0 .7rem; font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  .grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; }
  @media (max-width: 599px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  .card { position: relative; margin: 0; min-height: 96px; box-sizing: border-box; padding: .9rem .7rem .9rem 1rem; display: grid;
    grid-template-columns: 40px minmax(0, 1fr) 52px; align-items: center; gap: .8rem; }
  .ic { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: rgba(255, 255, 255, .08); color: var(--mut); }
  .card.on .ic { background: rgba(var(--acc-rgb), .18); color: var(--acc-text); }
  .tx { min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
  .ti { font-weight: 800; font-size: 1rem; color: var(--fg); }
  .de { font-size: .84rem; color: var(--mut); line-height: 1.35; }
  .why { display: block; height: 3em; line-height: 1.5; font-size: .8rem; color: var(--hint, var(--mut)); overflow: hidden; overflow-wrap: anywhere; }
  .why :global(svg) { display: inline-block; vertical-align: -1px; margin-right: .3rem; }
  /* the switch: Toggle's track and knob (in .track); the button's ::after covers the card, so a press anywhere on it switches */
  .sw { position: static; width: 52px; min-height: 44px; padding: 0; background: transparent; border-radius: 99px; outline: none; }
  .sw::after { content: ''; position: absolute; inset: 0; border-radius: var(--fr-r-panel); z-index: 1; cursor: pointer; }
  .sw:hover:not(:disabled), .sw:active:not(:disabled) { background: transparent; transform: none; }
  .track { position: relative; display: block; width: 52px; height: 44px; }
  .track::before { content: ''; position: absolute; left: 3px; right: 3px; top: 50%; height: 28px; transform: translateY(-50%); border-radius: 99px; background: rgba(255, 255, 255, .18); box-shadow: inset 0 0 0 1px var(--fr-line); }
  .sw.on .track::before { background: var(--acc); box-shadow: none; }
  .knob { position: absolute; top: 50%; left: 6px; width: 22px; height: 22px; margin-top: -11px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .35); transition: transform 300ms var(--fr-spring); }
  .sw.on .knob { transform: translateX(18px); }
  .locked .sw::after { cursor: not-allowed; }
  .locked .track { opacity: .55; }
  .locked .ti, .locked .ic { opacity: .7; }
  /* a link from the compare view to a detail of an area that is off lands here: a brief accent ring (opacity only) */
  .card::before { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 2px var(--acc); opacity: 0; pointer-events: none; transition: opacity 400ms var(--fr-out, ease-out); }
  .card:global(.flash)::before { opacity: 1; }
  :global(html.m-still) .ag .card::before { transition: none; }
  @media (prefers-reduced-motion: reduce) { .card::before { transition: none; } }
  /* the ring goes around the card the switch covers */
  .card:has(.sw:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 5px var(--ring-dark); }
  :global(html.m-still) .ag .knob { transition: none; }
</style>
