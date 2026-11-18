<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One row of the notifications center (spec variant B): a 40-px icon tile (colour by category) with the unread dot, the title
   * with a count chip for a group, one body line, the relative time and at most one action link. The row itself is:
   *   - a group: a button that opens it in place (its entries with date and time beneath) and marks it read;
   *   - a single entry with a link: that link (marks it read; the action pill beside it is then for the pointer only);
   *   - an unread single entry without a link: a button that marks it read (the focus then goes to its ✕);
   *   - a read single entry without a link: plain text, nothing to press.
   * ✕ removes it (shown on hover or focus; always on touch, 44 px); on touch a swipe to the left removes it too (swipe.ts).
   * `compact` (Mein Bereich): nothing removes it, every row has the same height (one title line, the action beside it).
   *   <NoteRow {group} open={…} on:toggle on:read on:hide on:follow />
   */
  import { createEventDispatcher, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, locale, t } from '#lib/i18n';
  import { uid } from '#lib/ui/ids';
  import { actionKeyOf, iconOf, toneOf } from './look';
  import { swipeToRemove } from './swipe';
  import type { FeedGroup } from './types';

  export let group: FeedGroup;
  export let open = false;
  export let compact = false;

  /** each event carries the group id */
  const dispatch = createEventDispatcher<{ toggle: string; read: string; hide: string; follow: string }>();
  const id = uid('nr');
  $: many = group.count > 1;
  $: when = $locale && fmtRelative(group.at);
  /** the accessible name: title, count, "neu", time (the body is its description) */
  $: name = [group.title, many ? String(group.count) : '', group.unread ? $t('notes.newLabel') : '', when].filter(Boolean).join(', ');
  $: action = group.link ? $t(actionKeyOf(group.category, group.kind)) : '';
  /** what the row itself is (see above) */
  $: kind = many ? 'group' : group.link ? 'link' : group.unread ? 'mark' : 'still';
  let row: HTMLLIElement, xBtn: HTMLButtonElement | undefined;

  function press() {
    if (many) dispatch('toggle', group.id);
    if (group.unread) dispatch('read', group.id);
    // the button turns into plain text once read: the focus stays in the row
    if (kind === 'mark') void tick().then(() => { if (!row?.contains(document.activeElement)) (xBtn ?? row)?.focus({ preventScroll: true }); });
  }
</script>

{#snippet face(named: boolean)}
  <span class="tile tone-{toneOf(group.category, group.kind)}" aria-hidden="true"><Icon name={iconOf(group.category)} size={20} />{#if group.unread}<i class="udot"></i>{/if}</span>
  <span class="txt">
    <span class="top"><b class="ti">{group.title}</b>{#if many}<span class="cnt" aria-hidden="true">{group.count}×</span>{/if}<time datetime={group.at} aria-hidden={named ? 'true' : undefined}>{when}</time></span>
    {#if group.body}<span class="bd" id="{id}-b">{group.body}</span>{/if}
  </span>
{/snippet}

<li class="nr" class:compact class:unread={group.unread} data-group={group.id} bind:this={row} tabindex="-1"
  use:swipeToRemove={{ remove: () => dispatch('hide', group.id), enabled: !compact }}>
  {#if kind === 'link'}
    <a class="main" href={group.link} aria-label={name} aria-describedby={group.body ? `${id}-b` : undefined} on:click={() => dispatch('follow', group.id)}>{@render face(true)}</a>
  {:else if kind === 'still'}
    <div class="main still">{@render face(false)}</div>
  {:else}
    <button type="button" class="main" aria-label={name} aria-describedby={group.body ? `${id}-b` : undefined} aria-expanded={many ? open : undefined}
      aria-controls={many && open ? `${id}-i` : undefined} on:click={press}>{@render face(true)}</button>
  {/if}
  <!-- beside a row that is its link already, the action pill is for the pointer only (one stop per row for the keyboard) -->
  {#if group.link}<a class="act" href={group.link} aria-label="{action}: {group.title}" tabindex={kind === 'link' ? -1 : undefined} aria-hidden={kind === 'link' ? 'true' : undefined}
    on:click={() => dispatch('follow', group.id)}>{action}</a>{/if}
  {#if !compact}<button type="button" class="x" bind:this={xBtn} aria-label="{$t('notes.remove')}: {group.title}" title={$t('notes.remove')} on:click={() => dispatch('hide', group.id)}><Icon name="x" size={16} /></button>{/if}
  {#if many && open}
    <ul class="items" id="{id}-i">
      {#each group.items as it (it.id)}<li><span class="it">{it.title}</span><time datetime={it.at}>{fmtDateTime(it.at)}</time></li>{/each}
    </ul>
  {/if}
</li>

<style>
  /* every row has the same spacing: 4 px around, 10 px inside the button; the ✕ column is always reserved (it only fades in) */
  .nr { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 40px; column-gap: 2px; padding: 2px 0; list-style: none; }
  /* the row moves under the finger to the left (swipe.ts); the page still scrolls up and down */
  .nr:not(.compact) { touch-action: pan-y; }
  /* Mein Bereich: one height for every row (64 px), so the reserved room of five rows fits: one title line, the action beside it */
  .nr.compact { grid-template-columns: minmax(0, 1fr) auto; }
  /* 60 px at the default text size (the room /me reserves); larger text grows the row */
  .compact .main { min-height: 60px; padding-block: 8px; align-items: center; }
  .compact .ti { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .compact .act { grid-column: 2; grid-row: 1; align-self: center; margin: 0 4px 0 0; }
  .main { grid-column: 1; grid-row: 1; display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; align-items: start; width: 100%; min-height: 44px; box-sizing: border-box;
    padding: 10px 8px; margin: 0; text-decoration: none; border: 0; border-radius: 14px; background: transparent; color: #fff; text-align: left; font: inherit; cursor: pointer; }
  .main:hover { background: rgba(255, 255, 255, .08); text-decoration: none; }
  .main.still { cursor: default; }
  .main.still:hover { background: transparent; }
  .nr:focus { outline: none; }
  .main:focus-visible, .act:focus-visible, .x:focus-visible { outline: 2px solid #fff; outline-offset: -2px; box-shadow: inset 0 0 0 4px var(--ring-dark); }
  .tile { position: relative; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; color: var(--tone); background: color-mix(in srgb, var(--tone) 20%, transparent); }
  .tone-ok { --tone: var(--ok, #4ade80); }
  .tone-info { --tone: var(--info-mark, #73c6cf); }
  .tone-acc { --tone: var(--acc-light, #ff8aa0); }
  .tone-warn { --tone: var(--warn, #f5a623); }
  .tone-gold { --tone: #f5c542; }
  .tone-neutral { --tone: rgba(255, 255, 255, .9); }
  .udot { position: absolute; top: -3px; right: -3px; width: 10px; height: 10px; border-radius: 50%; background: var(--acc-fill); box-shadow: 0 0 0 2px rgba(18, 20, 24, .9); }
  .txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  /* a long title wraps (the row grows); the body stays one line */
  .ti { flex: 0 1 auto; min-width: 0; font-weight: 700; font-size: .92rem; line-height: 1.3; overflow-wrap: anywhere; }
  .unread .ti { font-weight: 800; }
  .cnt { flex: none; padding: 1px 7px; border-radius: 99px; background: rgba(255, 255, 255, .14); font-size: .75rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .top time { flex: none; margin-left: auto; font-size: .78rem; color: rgba(255, 255, 255, .9); white-space: nowrap; }
  .bd { font-size: .85rem; line-height: 1.35; color: rgba(255, 255, 255, .9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .act { grid-column: 1; grid-row: 2; justify-self: start; display: inline-flex; align-items: center; min-height: 36px; margin: -4px 0 4px 60px; padding: 0 12px; border-radius: 99px;
    background: rgba(255, 255, 255, .12); color: #fff; font-size: .82rem; font-weight: 700; text-decoration: none; }
  .act:hover { background: rgba(255, 255, 255, .2); text-decoration: none; }
  .x { grid-column: 2; grid-row: 1; align-self: start; width: 36px; height: 36px; min-height: 36px; margin-top: 6px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 50%;
    background: transparent; color: #fff; opacity: 0; transition: opacity 120ms linear; }
  .x:hover { background: rgba(255, 255, 255, .12); }
  .nr:hover .x, .nr:focus-within .x { opacity: 1; }
  .items { grid-column: 1 / -1; grid-row: 3; margin: 0 0 6px 60px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .items li { display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; border-left: 2px solid rgba(255, 255, 255, .18); font-size: .84rem; }
  .it { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .items time { flex: none; font-size: .78rem; color: rgba(255, 255, 255, .9); font-variant-numeric: tabular-nums; }
  @media (pointer: coarse) {
    .nr { grid-template-columns: minmax(0, 1fr) 44px; }
    .x { width: 44px; height: 44px; min-height: 44px; margin-top: 4px; opacity: 1; }
    .act { min-height: 44px; }
  }
  :global(html.m-still) .x { transition: none; }
  @media (prefers-reduced-motion: reduce) { .x { transition: none; } }
</style>
