<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One extra programme guide on *Quellen* (extra-guides spec, Admin UI): name, the kind chip *Programmführer* (and *Deaktiviert*), the
   * masked link ("https://epg.example.com/…"), the *Gilt für* line ("Gilt für: Alle Sender" / "Gilt für: Nordlicht Paket, Eigene
   * Streams" / "Gilt für keine Quelle mehr"), the import line ("Zuletzt aktualisiert heute 05:40 · Programm: 2.140 Sendungen"), "versorgt
   * {n} Sender", the interval, *Jetzt aktualisieren* and the order among the guides (up / down, 44 px; both always there, disabled at
   * the ends, so nothing moves), plus the menu *Bearbeiten* / *Deaktivieren* / *Löschen*. A guide left without a scope (its last scoped
   * source was deleted; the backend refuses turning it on without a new scope) opens the sheet on *Aktivieren* (`enable`). The page
   * does the writes.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import ActionMenu from '#lib/ui/ActionMenu.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { REFRESHES, type Refresh, type SourceView } from './api';
  import { fileLine, guideProviderLabel, guideScopeLabel, guideStateLine, isFileGuide, scopeOptions } from './sources';

  export let source: SourceView;
  /** every source of the page: the scope names come from them */
  export let sources: SourceView[];
  export let now: Date;
  export let refreshing = false;
  export let busy = false;
  /** the first / last guide: no move up / down */
  export let first = false;
  export let last = false;

  const dispatch = createEventDispatcher<{ upload: File; refresh: void; edit: HTMLElement | null; enable: HTMLElement | null; toggle: void; remove: void; interval: Refresh; move: 1 | -1 }>();
  let card: HTMLDivElement | undefined;
  let picker: HTMLInputElement | undefined;
  export let uploading = false;
  $: isFile = isFileGuide(source);
  function picked(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = '';
    if (f) dispatch('upload', f);
  }
  const menuButton = (): HTMLElement | null => card?.querySelector<HTMLElement>('[data-guide-menu] button') ?? null;

  $: scopeLine = guideScopeLabel(source.guideScope, sources);
  $: noScope = source.guideScope !== null && !scopeOptions(sources).some((o) => source.guideScope?.includes(o.id));
  $: line = guideStateLine(source, now);
  $: failed = Boolean(source.state.epg.lastError);
  $: intervals = REFRESHES.map((r) => ({ value: r, label: $t(`adminLive.src.interval.${r}`) }));
  $: items = [
    { id: 'edit', label: $t('adminLive.src.editAction'), icon: 'pencil', run: () => { dispatch('edit', menuButton()); } },
    { id: 'toggle', label: source.enabled ? $t('adminLive.src.disable') : $t('adminLive.src.enable'), icon: source.enabled ? 'pause' : 'play', run: () => { if (noScope && !source.enabled) dispatch('enable', menuButton()); else dispatch('toggle'); } },
    { id: 'delete', label: $t('adminLive.src.delete'), icon: 'x', danger: true, run: () => { dispatch('remove'); } },
  ];
  const onInterval = (e: Event) => {
    const v = (e.target as HTMLSelectElement | null)?.value;
    if (v && (REFRESHES as readonly string[]).includes(v) && v !== source.refresh) dispatch('interval', v as Refresh);
  };
</script>

<div class="gc" bind:this={card} data-guide={source.id}>
  <AdminCard title={source.name}>
    <svelte:fragment slot="actions">
      <span class="menu" data-guide-menu><ActionMenu label={$t('adminLive.src.actions', { name: source.name })} title={source.name} {busy} {items} /></span>
    </svelte:fragment>
    <p class="chips">
      <span class="chip">{$t('adminLive.src.kindGuide')}</span>
      {#if isFile}<span class="chip">{guideProviderLabel(source)}</span>{/if}
      {#if !source.enabled}<span class="chip off"><Icon name="pause" size={14} />{$t('adminLive.src.off')}</span>{/if}
    </p>
    {#if isFile}
      <p class="url" data-file-line><code>{fileLine(source)}</code></p>
    {:else}
      <p class="url"><code>{source.epgHint ?? '–'}</code></p>
    {/if}
    <p class="scope" class:none={noScope} data-scope>{#if noScope}<Icon name="alert" size={18} />{/if}<span>{scopeLine}</span></p>
    <p class="state" class:failed data-state>{#if failed}<Icon name="alert" size={18} />{/if}<span>{line}</span></p>
    <p class="served" data-served>{$t('adminLive.src.guide.served', { n: source.servedChannels })}</p>
    <div class="row">
      {#if isFile}
        <input type="file" class="pick" accept=".xml,.xml.gz,.gz" bind:this={picker} on:change={picked} tabindex="-1" aria-hidden="true" />
        <Button variant="secondary" icon="arrow-up" class="rf" pending={uploading} disabled={busy} on:click={() => picker?.click()}>{$t('adminLive.src.guide.newFile')}</Button>
      {:else}
        <div class="iv"><Select label={$t('adminLive.src.interval.label')} value={source.refresh} options={intervals} disabled={busy} on:change={onInterval} /></div>
        <Button variant="secondary" icon="refresh" class="rf" pending={refreshing} disabled={!source.enabled} on:click={() => dispatch('refresh')}>{$t('adminLive.src.refreshNow')}</Button>
      {/if}
      <span class="order">
        <button type="button" class="mv" aria-label={$t('adminLive.src.guide.moveUp', { name: source.name })} title={$t('adminLive.src.guide.moveUp', { name: source.name })}
          disabled={first || busy} on:click={() => dispatch('move', -1)}><Icon name="arrow-up" size={20} /></button>
        <button type="button" class="mv" aria-label={$t('adminLive.src.guide.moveDown', { name: source.name })} title={$t('adminLive.src.guide.moveDown', { name: source.name })}
          disabled={last || busy} on:click={() => dispatch('move', 1)}><Icon name="arrow-down" size={20} /></button>
      </span>
    </div>
  </AdminCard>
</div>

<style>
  .gc { min-width: 0; }
  .pick { display: none; }
  .menu { display: contents; }
  p { margin: 0 0 .45rem; min-width: 0; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: .4rem; margin: -.4rem 0 .6rem; }
  .chip { display: inline-flex; align-items: center; gap: .25rem; font-size: .78rem; font-weight: 700; padding: .1rem .55rem; border-radius: 99px; border: 1px solid currentColor; }
  .url code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88rem; background: rgba(255, 255, 255, .07); padding: .05rem .4rem; border-radius: 4px; }
  .scope, .state { display: flex; gap: .4rem; align-items: flex-start; font-size: .92rem; }
  .scope :global(svg), .state :global(svg) { flex: none; margin-top: .1rem; color: var(--err); }
  .scope.none, .state.failed { font-weight: 600; }
  .served { font-size: .9rem; color: rgba(255, 255, 255, .85); }
  .row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .6rem 1rem; margin-top: .7rem; }
  .iv { flex: 0 1 14rem; min-width: 0; }
  .row :global(.rf .spinner) { width: 18px; height: 18px; }
  .order { display: inline-flex; gap: .3rem; margin-left: auto; }
  .mv { width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff;
    border: 1px solid rgba(255, 255, 255, .2); }
  .mv:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .mv:disabled { opacity: .4; }
</style>
