<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One provider list on *Quellen* (spec §9.1): name, the kind chip *Anbieterliste* (and *Deaktiviert*), the masked URL
   * ("https://iptv.example.com/…", the only form a browser ever sees), the *EPG* line, the interval select, the state line ("Zuletzt
   * aktualisiert heute 06:12 · 412 Sender (+3 / −1) · Programm: 6 812 Sendungen", or the error in words), the unreleased-groups line,
   * *Jetzt aktualisieren* (the spinner sits in the button, which keeps its width) and the menu *Bearbeiten* / *Deaktivieren* /
   * *Löschen*. Skipped groups show as "Ohne 6 Gruppen · Auswahl ändern" (the button opens the sheet at the group picker, which checks
   * the list again); the unreleased-groups line links to *Gruppen & Rechte* (`?tab=groups&pending=1`). The page does the writes; the
   * card only says what was asked.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import ActionMenu from '#lib/ui/ActionMenu.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { REFRESHES, type Refresh, type SourceView } from './api';
  import { stateLine } from './sources';

  export let source: SourceView;
  export let now: Date;
  /** *Jetzt aktualisieren* is running */
  export let refreshing = false;
  /** another write on this source is running */
  export let busy = false;

  const dispatch = createEventDispatcher<{ refresh: void; edit: HTMLElement | null; pick: HTMLElement | null; toggle: void; remove: void; interval: Refresh }>();
  let card: HTMLDivElement | undefined;
  const menuButton = (): HTMLElement | null => { const b = card?.querySelectorAll('.acts button'); return b?.length ? (b[b.length - 1] as HTMLElement) : null; };

  $: line = stateLine(source, now);
  $: failed = Boolean(source.state.lastError);
  $: intervals = REFRESHES.map((r) => ({ value: r, label: $t(`adminLive.src.interval.${r}`) }));
  $: items = [
    { id: 'edit', label: $t('adminLive.src.editAction'), icon: 'pencil', run: () => { dispatch('edit', menuButton()); } },
    { id: 'toggle', label: source.enabled ? $t('adminLive.src.disable') : $t('adminLive.src.enable'), icon: source.enabled ? 'pause' : 'play', run: () => { dispatch('toggle'); } },
    { id: 'delete', label: $t('adminLive.src.delete'), icon: 'x', danger: true, run: () => { dispatch('remove'); } },
  ];
  const onInterval = (e: Event) => {
    const v = (e.target as HTMLSelectElement | null)?.value;
    if (v && (REFRESHES as readonly string[]).includes(v) && v !== source.refresh) dispatch('interval', v as Refresh);
  };
</script>

<div class="sc" bind:this={card} data-source={source.id}>
  <AdminCard title={source.name}>
    <svelte:fragment slot="actions">
      <ActionMenu label={$t('adminLive.src.actions', { name: source.name })} title={source.name} {busy} {items} />
    </svelte:fragment>
    <p class="chips">
      <span class="chip">{$t('adminLive.src.kindList')}</span>
      {#if !source.enabled}<span class="chip off"><Icon name="pause" size={14} />{$t('adminLive.src.off')}</span>{/if}
    </p>
    <p class="url"><code>{source.urlHint ?? '–'}</code></p>
    <p class="epg">{source.epgHint ? $t('adminLive.src.epgLine', { hint: source.epgHint }) : $t('adminLive.src.epgNone')}</p>
    <p class="state" class:failed data-state>{#if failed}<Icon name="alert" size={18} />{/if}<span>{line}</span></p>
    {#if source.skipGroups.length > 0}
      <p class="picked" data-skipped><span>{$t('adminLive.src.skipped', { n: source.skipGroups.length })} ·</span>
        <Button variant="ghost" size="sm" disabled={busy} on:click={(e) => dispatch('pick', e.currentTarget instanceof HTMLElement ? e.currentTarget : null)}>{$t('adminLive.src.changePick')}</Button></p>
    {/if}
    {#if source.pendingGroups > 0}<p class="pending"><a href="/admin/livetv?tab=groups&pending=1" data-pending><Icon name="clock" size={16} /><span>{$t('adminLive.src.pending', { n: source.pendingGroups })}</span></a></p>{/if}
    <div class="row">
      <div class="iv"><Select label={$t('adminLive.src.interval.label')} value={source.refresh} options={intervals} disabled={busy} on:change={onInterval} /></div>
      <Button variant="secondary" icon="refresh" class="rf" pending={refreshing} disabled={!source.enabled} on:click={() => dispatch('refresh')}>{$t('adminLive.src.refreshNow')}</Button>
    </div>
  </AdminCard>
</div>

<style>
  .sc { min-width: 0; }
  p { margin: 0 0 .45rem; min-width: 0; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: .4rem; margin: -.4rem 0 .6rem; }
  .chip { display: inline-flex; align-items: center; gap: .25rem; font-size: .78rem; font-weight: 700; padding: .1rem .55rem; border-radius: 99px; border: 1px solid currentColor; }
  .url code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88rem; background: rgba(255, 255, 255, .07); padding: .05rem .4rem; border-radius: 4px; }
  .epg { font-size: .9rem; color: rgba(255, 255, 255, .85); }
  .state { display: flex; gap: .4rem; align-items: flex-start; font-size: .92rem; }
  .state :global(svg) { flex: none; margin-top: .1rem; color: var(--err); }
  .state.failed { font-weight: 600; }
  .picked { display: flex; flex-wrap: wrap; align-items: center; gap: 0 .3rem; font-size: .92rem; }
  /* the same 44 px target the picker's buttons have, on a fine pointer too */
  .picked :global(.ui-btn) { min-height: 44px; }
  .pending { font-size: .9rem; }
  .pending a { display: inline-flex; gap: .4rem; align-items: center; min-height: 44px; color: inherit; text-decoration: underline; text-underline-offset: 3px; }
  .row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .6rem 1rem; margin-top: .7rem; }
  .iv { flex: 0 1 14rem; min-width: 0; }
  /* the spinner takes the icon's 18 px, so the button keeps its width while it turns */
  .row :global(.rf .spinner) { width: 18px; height: 18px; }
</style>
