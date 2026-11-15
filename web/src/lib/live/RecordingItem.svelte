<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { fmtDate, t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { clock } from './api';
  import { minutesOf, progressOf, stateLabel, type Recording, type Visibility } from './recordings';

  /**
   * One recording of *Meine Aufnahmen* (spec §15.7, plan Phase 3 Task 8). *Fertig*: play, *Behalten* (a toggle that keeps its size),
   * *Teilen…* (the owner; an inline choice of three, opened by the person), *Löschen* (the page holds it 5 s behind an undo toast);
   * *Geplant*: the time span, the *Konflikt* chip from the forecast and *Abbrechen*. The state chip, the progress line and the chip
   * slot are reserved, so arriving data moves nothing. 44 px targets; on a phone the actions wrap under the text.
   * A running recording of the owner also offers *Jetzt beenden* (DVR follow-ups): it ends now and stays, playable; *Löschen* still
   * removes it.
   */
  export let rec: Recording;
  export let kind: 'done' | 'planned' = 'done';
  /** a write of this item is running */
  export let busy = false;
  /**
   * the person may record (`liveRecord`): without it an owner keeps only what the server allows anyway (watch, narrow a share,
   * delete); *Behalten*, a wider share and the library copy would be refused
   */
  export let canRecord = true;
  /** *Behalten → in Bibliothek* is possible on this server (storage mode `both` with a library) */
  export let libraryExport = false;

  const dispatch = createEventDispatcher<{ play: Recording; keep: Recording; share: { rec: Recording; visibility: Visibility }; delete: Recording; cancel: Recording; library: Recording; stop: Recording }>();
  let shareOpen = false;
  const day = (iso: string) => fmtDate(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  $: playable = rec.state === 'recording' || rec.state === 'done' || rec.state === 'partial';
  $: tone = rec.state === 'failed' ? 'err' : rec.state === 'partial' ? 'warn' : rec.state === 'recording' ? 'rec' : 'ok';
  const SHARES: Array<{ v: Visibility; k: 'live.mine.sharePrivate' | 'live.mine.shareAccount' | 'live.mine.shareAll' }> = [
    { v: 'private', k: 'live.mine.sharePrivate' }, { v: 'account', k: 'live.mine.shareAccount' }, { v: 'everyone', k: 'live.mine.shareAll' },
  ];
  const rank = (v: Visibility) => SHARES.findIndex((s) => s.v === v);
  /** without `liveRecord` only the same or a narrower audience */
  $: shares = canRecord ? SHARES : SHARES.filter((s) => rank(s.v) <= rank(rec.visibility));
  $: exportable = canRecord && libraryExport && rec.mine && rec.storage === 'ff' && (rec.state === 'done' || rec.state === 'partial');
</script>

<li class="ritem" class:planned={kind === 'planned'}>
  {#if kind === 'done'}
    <button type="button" class="play" disabled={!playable} aria-label={$t('live.mine.play', { title: rec.subtitle ? `${rec.title}, ${rec.subtitle}` : rec.title })} on:click={() => dispatch('play', rec)}>
      <span class="lg" aria-hidden="true">{#if rec.channel.logo}<img src={rec.channel.logo} alt="" width="40" height="40" decoding="async" />{/if}</span>
      <span class="pi" aria-hidden="true"><Icon name="play" size={18} /></span>
    </button>
  {:else}
    <span class="lg solo" aria-hidden="true">{#if rec.channel.logo}<img src={rec.channel.logo} alt="" width="40" height="40" decoding="async" />{/if}</span>
  {/if}
  <div class="txt">
    <p class="ti">{rec.title}</p>
    <p class="sub">{rec.subtitle ?? rec.episode ?? ''}</p>
    <p class="meta">
      <span>{rec.channel.name}</span>
      {#if kind === 'planned'}
        <span>{day(rec.start)} · {clock(rec.start)}–{clock(rec.end)}</span>
      {:else}
        <span>{day(rec.start)} · {$t('live.rec.minutes', { n: minutesOf(rec) })}</span>
      {/if}
      <span class="chip {tone}">{#if rec.state === 'recording'}<i class="rdot" aria-hidden="true"></i>{/if}{stateLabel(rec)}</span>
      <span class="cslot">{#if kind === 'planned' && rec.conflict}<span class="chip warn"><Icon name="alert" size={14} />{$t('live.mine.conflict')}</span>{/if}</span>
    </p>
    {#if kind === 'done'}<span class="pg" aria-hidden="true"><i style="transform:scaleX({progressOf(rec)})"></i></span>{/if}
  </div>
  <div class="acts">
    {#if kind === 'done'}
      {#if rec.mine}
        {#if rec.state === 'recording'}
          <button type="button" class="ab" aria-busy={busy} on:click={() => dispatch('stop', rec)}><span class="ic on" aria-hidden="true"><Icon name="stop" size={18} /></span>{$t('live.mine.stop')}</button>
        {/if}
        {#if canRecord}
          <button type="button" class="ab" class:on={rec.keep} aria-pressed={rec.keep} aria-busy={busy} on:click={() => dispatch('keep', rec)}>
            <span class="ic" aria-hidden="true"><Icon name="lock" size={18} /></span>{$t('live.mine.keep')}
          </button>
        {/if}
        {#if exportable}<button type="button" class="ab" aria-busy={busy} on:click={() => dispatch('library', rec)}>{$t('live.mine.toLibrary')}</button>{/if}
        <button type="button" class="ab" aria-expanded={shareOpen} on:click={() => (shareOpen = !shareOpen)}>{$t('live.mine.share')}</button>
        <button type="button" class="ab del" on:click={() => dispatch('delete', rec)}>{$t('live.mine.delete')}</button>
      {:else}
        <span class="shared">{$t('live.mine.shared')}</span>
      {/if}
    {:else}
      <button type="button" class="ab del" aria-busy={busy} on:click={() => dispatch('cancel', rec)}>{$t('live.mine.cancel')}</button>
    {/if}
  </div>
  {#if shareOpen && rec.mine}
    <div class="share" role="group" aria-label={$t('live.mine.share')}>
      {#each shares as s (s.v)}
        <button type="button" class="ab" aria-pressed={rec.visibility === s.v} on:click={() => { shareOpen = false; if (rec.visibility !== s.v) dispatch('share', { rec, visibility: s.v }); }}>{$t(s.k)}</button>
      {/each}
    </div>
  {/if}
</li>

<style>
  .ritem { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px 14px; padding: 10px 12px; border-radius: var(--fr-r-card); background: rgba(255, 255, 255, .05); list-style: none; }
  .play, .play:hover:not(:disabled), .play:active:not(:disabled) { position: relative; display: grid; place-items: center; width: 72px; height: 54px; padding: 0; margin: 0; border: 0; border-radius: 10px; background: rgba(255, 255, 255, .08); color: #fff; transform: none; }
  .play:disabled { opacity: .5; }
  .lg { display: grid; place-items: center; width: 40px; height: 40px; overflow: hidden; border-radius: 8px; }
  .lg img { width: 100%; height: 100%; object-fit: contain; }
  .lg.solo { width: 54px; height: 54px; background: rgba(255, 255, 255, .08); border-radius: 10px; }
  .lg.solo img { width: 40px; height: 40px; }
  .pi { position: absolute; right: 4px; bottom: 4px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: rgba(0, 0, 0, .66); }
  .txt { min-width: 0; }
  .ti { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
  .sub { margin: 0; min-height: 1.3em; color: rgba(255, 255, 255, .78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 2px 0 0; font-size: .88rem; color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; }
  .chip { display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 0 8px; border-radius: 999px; font-size: .8rem; font-weight: 700; background: rgba(255, 255, 255, .1); color: #fff; }
  .chip.ok { color: #4ade80; }
  .chip.warn { color: #f7b344; }
  .chip.err { color: #ffa8a8; }
  .cslot { display: inline-flex; min-height: 22px; }
  .rdot { width: 8px; height: 8px; border-radius: 50%; background: var(--err-mark); }
  .pg { display: block; height: 3px; margin-top: 6px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .14); }
  .pg i { display: block; height: 100%; background: var(--acc); transform-origin: 0 50%; }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  /* action buttons: a light glass pill; Behalten keeps its width when it switches (the icon only fills) */
  .ab, .ab:hover:not(:disabled), .ab:active:not(:disabled) { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 14px; margin: 0; border: 0; border-radius: 999px;
    background: rgba(255, 255, 255, .1); color: #fff; font: inherit; font-size: .92rem; font-weight: 600; transform: none; white-space: nowrap; }
  .ab[aria-pressed='true'] { background: var(--fr-sel); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .5); }
  .ic { display: grid; opacity: .55; }
  .ab.on .ic, .ic.on { opacity: 1; }
  .del { color: #ffa8a8; }
  .shared { font-size: .85rem; color: rgba(255, 255, 255, .72); }
  .share { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  @media (max-width: 720px) {
    .ritem { grid-template-columns: auto minmax(0, 1fr); }
    .acts { grid-column: 1 / -1; justify-content: flex-start; }
    .share { justify-content: flex-start; }
  }
  :global(html.tv) .ab, :global(html.tv) .play { min-height: 54px; }
</style>
