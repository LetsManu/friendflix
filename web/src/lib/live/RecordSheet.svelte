<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { grow, scrimFade, sheetSlide, type FxMode } from '#lib/glass/fx';
  import { fmtDate, t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { errorText } from '#lib/ui/action';
  import { toast } from '#lib/ui/toast';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { clock, type Prog } from './api';
  import { channelHead } from './progress';
  import {
    conflictText, createRule, deleteRecording, deleteRule, getRecording, listRecordings, patchRecording, patchRule, programme as fetchProgramme, schedule, stepKeep, stepPad,
    type Forecast, type ProgrammeDetail, type Rule, type ScheduleBody,
  } from './recordings';

  /**
   * A programme's detail sheet (spec §15.7, plan Phase 3 Task 7; Phase 2b's guide opens the same sheet): title, time, channel and
   * description, then *Jetzt ansehen* (only while it runs), *Aufnehmen* / *Aufnahme abbrechen*, *Serie aufnehmen* (only with a
   * series key: *Nur neue Folgen*, *Nur dieser Sender* / *Alle Sender*, *Höchstens … behalten*) and, under *Mehr*, the *Vorlauf* /
   * *Nachlauf* steppers. A conflict (409 with its forecast, §15.4) shows the §20 line in a slot that is reserved from the start, with
   * *Trotzdem planen* (force): nothing moves when it appears. The opener shows the sheet only with `perms.liveRecord` (never for kids).
   * A bottom sheet on phones, a panel that grows in elsewhere; calm mode / reduced motion / TV / kids: at once, solid. A modal dialog
   * whose buttons are a D-pad scope; the main action takes the focus, Back / Escape (the opener's keys) or the close button close it.
   */
  export let channel: { id: string; number: number | null; name: string; logo: string | null };
  export let programme: Prog | null;
  export let phone = false;
  export let still = false;
  /** the opener's clock (the minute store) decides *Jetzt ansehen* */
  export let now: Date = new Date();

  const dispatch = createEventDispatcher<{ close: void; watch: { channelId: string }; changed: void }>();
  let box: HTMLElement | undefined;
  $: mode = (still ? 'still' : undefined) as FxMode | undefined;
  const fx = (node: Element, p: { dir: 'in' | 'out'; mode?: FxMode }) => (phone ? sheetSlide(node, p) : grow(node, { ...p, origin: '50% 50%' }));

  const PAD_DEFAULT = { before: 2, after: 5 };
  let detail: ProgrammeDetail | null = null;
  let recId: string | null = null;
  let rule: Rule | null = null;
  let ruleId: string | null = null;
  let busy = false;
  let conflict: Forecast | null = null;
  let more = false;
  let pad = { ...PAD_DEFAULT };
  let padTouched = false;
  let onlyNew = true;
  let thisChannel = true;
  let keepMax: number | null = null;

  $: running = programme !== null && Date.parse(programme.start) <= now.getTime() && now.getTime() < Date.parse(programme.end);
  $: title = detail?.title ?? programme?.title ?? channelHead(channel);
  $: seriesKey = detail?.seriesKey ?? null;
  $: ready = detail !== null;
  $: day = programme ? fmtDate(programme.start, { weekday: 'short', day: 'numeric', month: 'short' }) : '';

  async function load(): Promise<void> {
    if (!programme) return;
    try {
      detail = await fetchProgramme(channel.id, programme.start);
      recId = detail.recording && (detail.recording.state === 'scheduled' || detail.recording.state === 'recording') ? detail.recording.id : null;
      ruleId = detail.rule?.id ?? null;
      if (recId) {
        const r = await getRecording(recId).catch(() => null);
        if (r && !padTouched) pad = { before: r.padBefore, after: r.padAfter };
      }
      if (ruleId) {
        rule = (await listRecordings('scheduled').catch(() => ({ rules: [] as Rule[] }))).rules.find((x) => x.id === ruleId) ?? null;
        if (rule) { onlyNew = rule.onlyNew; thisChannel = rule.channelId !== null; keepMax = rule.keepMax; }
      }
    } catch (e) {
      toast.error(errorText(e));
    }
  }

  async function record(force = false): Promise<void> {
    if (!programme || busy) return;
    busy = true;
    try {
      const body: ScheduleBody = { channelId: channel.id, start: programme.start, ...(padTouched ? { padBefore: pad.before, padAfter: pad.after } : {}), ...(force ? { force: true } : {}) };
      const r = await schedule(body);
      if (!r.ok) { conflict = r.forecast; return; }
      conflict = null;
      recId = r.recording.id;
      toast.success($t('live.rec.planned'));
      dispatch('changed');
    } catch (e) {
      toast.error(errorText(e));
    } finally { busy = false; }
  }
  async function cancel(): Promise<void> {
    if (!recId || busy) return;
    busy = true;
    try {
      await deleteRecording(recId);
      recId = null;
      toast.success($t('live.rec.cancelled'));
      dispatch('changed');
    } catch (e) {
      toast.error(errorText(e));
    } finally { busy = false; }
  }
  async function recordSeries(): Promise<void> {
    if (!seriesKey || busy) return;
    busy = true;
    try {
      const r = await createRule({
        kind: 'series', channelId: thisChannel ? channel.id : null, seriesKey, title, onlyNew, keepMax,
        ...(padTouched ? { padBefore: pad.before, padAfter: pad.after } : {}),
      });
      rule = r.rule;
      ruleId = r.rule.id;
      if (r.forecast?.conflict) conflict = r.forecast;
      toast.success($t('live.rec.seriesOn'));
      dispatch('changed');
    } catch (e) {
      toast.error(errorText(e));
    } finally { busy = false; }
  }
  async function stopSeries(): Promise<void> {
    if (!ruleId || busy) return;
    busy = true;
    try {
      await deleteRule(ruleId);
      rule = null;
      ruleId = null;
      toast.success($t('live.rec.seriesStopped'));
      dispatch('changed');
    } catch (e) {
      toast.error(errorText(e));
    } finally { busy = false; }
  }
  /** a series option changed: an existing rule follows at once (its channel scope cannot change) */
  function ruleOption(patch: { onlyNew?: boolean; keepMax?: number | null }): void {
    if (!ruleId) return;
    void patchRule(ruleId, patch).then((r) => { rule = r; dispatch('changed'); }).catch((e) => toast.error(errorText(e)));
  }
  function setPad(which: 'before' | 'after', delta: number): void {
    pad = { ...pad, [which]: stepPad(which, pad[which], delta) };
    padTouched = true;
    // a planned recording takes the new padding at once
    if (recId) void patchRecording(recId, { padBefore: pad.before, padAfter: pad.after }).then(() => dispatch('changed')).catch((e) => toast.error(errorText(e)));
  }
  function setKeep(delta: number): void {
    keepMax = stepKeep(keepMax, delta);
    ruleOption({ keepMax });
  }

  onMount(() => {
    box?.querySelector<HTMLElement>('.main')?.focus();
    void load();
  });
</script>

<div class="rsdim" role="presentation" on:click={() => dispatch('close')} in:scrimFade={{ mode }} out:scrimFade={{ mode }}></div>
<div class="rswrap" class:phone>
  <div bind:this={box} class="rsheet" class:frost={!still} class:frost-safe={!still} class:solid={still} role="dialog" aria-modal="true" aria-labelledby="lrs-title"
    tabindex="-1" data-nav data-scope in:fx={{ dir: 'in', mode }} out:fx={{ dir: 'out', mode }}>
    <header>
      <h2 id="lrs-title">{title}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} on:click={() => dispatch('close')}><Icon name="x" size={22} /></button>
    </header>
    <p class="meta">
      <span class="lg" aria-hidden="true">{#if channel.logo}<img src={channel.logo} alt="" width="28" height="28" decoding="async" />{/if}</span>
      <span>{channelHead(channel)}</span>
      {#if programme}<span class="tm">{day} · {clock(programme.start)}–{clock(programme.end)}</span>{/if}
    </p>
    <p class="sub">{detail?.subtitle ?? programme?.subtitle ?? ''}</p>
    {#if programme}
      <p class="desc">{detail?.description ?? ''}</p>
    {:else}
      <p class="desc">{$t('live.rec.noProgramme')}</p>
    {/if}

    {#if programme}
      <div class="acts">
        {#if running}<button type="button" class="frost-btn act" on:click={() => dispatch('watch', { channelId: channel.id })}>{$t('live.guide.watch')}</button>{/if}
        {#if recId}
          <button type="button" class="frost-btn act main" aria-busy={busy} disabled={!ready} on:click={cancel}>{$t('live.guide.cancelRecord')}</button>
        {:else}
          <button type="button" class="frost-btn act main rec" aria-busy={busy} disabled={!ready} on:click={() => record(false)}><span class="dot" aria-hidden="true"></span>{$t('live.guide.record')}</button>
        {/if}
      </div>
      <!-- reserved from the start (spec "nothing may jump"): the conflict line and Trotzdem planen appear in it -->
      <div class="cslot" aria-live="polite">
        {#if conflict}
          <p class="cline"><Icon name="alert" size={18} /><span>{conflictText(conflict)}</span></p>
          {#if !recId}<button type="button" class="frost-btn act force" aria-busy={busy} on:click={() => record(true)}>{$t('live.rec.planAnyway')}</button>{/if}
        {/if}
      </div>

      {#if seriesKey}
        <div class="series">
          <Toggle label={$t('live.rec.onlyNew')} bind:checked={onlyNew} on:change={(e) => ruleOption({ onlyNew: e.detail })} />
          <div class="seg" role="group" aria-label={$t('live.rec.channels')}>
            <button type="button" aria-pressed={thisChannel} disabled={ruleId !== null} on:click={() => (thisChannel = true)}>{$t('live.rec.thisChannel')}</button>
            <button type="button" aria-pressed={!thisChannel} disabled={ruleId !== null} on:click={() => (thisChannel = false)}>{$t('live.rec.allChannels')}</button>
          </div>
          <div class="step">
            <button type="button" class="sb" aria-label={$t('live.rec.keepLess')} disabled={keepMax === 1} on:click={() => setKeep(-1)}><span aria-hidden="true">−</span></button>
            <span class="sv">{keepMax === null ? $t('live.rec.keepAll') : $t('live.rec.keepMax', { n: keepMax })}</span>
            <button type="button" class="sb" aria-label={$t('live.rec.keepMore')} disabled={keepMax === null} on:click={() => setKeep(1)}><span aria-hidden="true">+</span></button>
          </div>
          {#if ruleId}
            <button type="button" class="frost-btn act" aria-busy={busy} on:click={stopSeries}>{$t('live.rec.seriesStop')}</button>
          {:else}
            <button type="button" class="frost-btn act" aria-busy={busy} disabled={!ready} on:click={recordSeries}>{$t('live.guide.recordSeries')}</button>
          {/if}
        </div>
      {/if}

      <button type="button" class="more" aria-expanded={more} on:click={() => (more = !more)}>
        <span>{$t('live.rec.more')}</span><span class="chev" class:open={more} aria-hidden="true"><Icon name="chevron-down" size={20} /></span>
      </button>
      {#if more}
        <div class="pads">
          {#each [{ k: 'before', label: $t('live.rec.padBefore') }, { k: 'after', label: $t('live.rec.padAfter') }] as p (p.k)}
            {@const which = p.k === 'before' ? 'before' : 'after'}
            <div class="step">
              <span class="pl">{p.label}</span>
              <button type="button" class="sb" aria-label={$t('live.rec.padLess', { what: p.label })} disabled={pad[which] === 0} on:click={() => setPad(which, -1)}><span aria-hidden="true">−</span></button>
              <span class="sv num">{$t('live.rec.minutes', { n: pad[which] })}</span>
              <button type="button" class="sb" aria-label={$t('live.rec.padMore', { what: p.label })} disabled={pad[which] === (which === 'before' ? 30 : 120)} on:click={() => setPad(which, 1)}><span aria-hidden="true">+</span></button>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .rsdim { position: fixed; left: 0; top: 0; right: 0; bottom: 0; z-index: 120; background: rgba(8, 7, 11, .45); }
  .rswrap { position: fixed; left: 0; top: 0; right: 0; bottom: 0; z-index: 121; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .rswrap.phone { align-items: flex-end; }
  .rsheet { pointer-events: auto; width: min(480px, calc(100% - 32px)); max-height: 88%; overflow-y: auto; box-sizing: border-box; padding: 18px 20px 20px; border-radius: var(--fr-r-panel); color: #fff; outline: none; }
  .rswrap.phone .rsheet { width: 100%; max-height: 92%; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding: 16px 16px calc(20px + var(--safe-bottom, 0px)); }
  .rsheet.solid { background: var(--fr-solid); }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  h2 { margin: 8px 0 0; font-size: 1.25rem; line-height: 1.3; overflow-wrap: anywhere; }
  .x { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; background: transparent; color: #fff; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 6px 0 0; min-height: 28px; font-weight: 700; }
  .lg { flex: none; width: 28px; height: 28px; border-radius: 6px; overflow: hidden; background: rgba(255, 255, 255, .08); }
  .lg img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .tm { font-weight: 400; color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; }
  .sub { margin: 4px 0 0; min-height: 1.3em; color: rgba(255, 255, 255, .78); }
  /* the description keeps three lines whether it has arrived or not */
  .desc { margin: 8px 0 14px; min-height: calc(3 * 1.4em); line-height: 1.4; color: rgba(255, 255, 255, .86); display: -webkit-box; -webkit-line-clamp: 5; line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
  .acts { display: grid; gap: 10px; }
  .act { width: 100%; min-height: 44px; }
  .rec { gap: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--err-mark); }
  /* room for three lines of the conflict text and Trotzdem planen */
  .cslot { min-height: calc(3 * 1.35em + 44px + 18px); margin: 8px 0 6px; }
  .cline { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 8px; line-height: 1.35; color: #f7b344; }
  .cline :global(svg) { flex: none; margin-top: 1px; }
  .series { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--fr-line); }
  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 3px; border-radius: 999px; background: rgba(255, 255, 255, .08); }
  .seg button { min-height: 44px; padding: 0 10px; border-radius: 999px; background: transparent; color: #fff; font-size: .95rem; }
  .seg button[aria-pressed='true'] { background: var(--fr-sel); font-weight: 700; }
  .step { display: flex; align-items: center; gap: 8px; min-height: 44px; }
  .sb { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; background: rgba(255, 255, 255, .1); color: #fff; font-size: 1.3rem; line-height: 1; }
  .sv { flex: 1 1 auto; text-align: center; font-variant-numeric: tabular-nums; }
  .pl { flex: 1 1 auto; min-width: 6em; }
  .pads .sv { flex: none; min-width: 5.5em; }
  .more { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 44px; margin-top: 12px; padding: 0 4px; border-radius: 12px; background: transparent; color: #fff; font-weight: 700; }
  .chev { display: grid; transition: transform 200ms var(--fr-out); }
  .chev.open { transform: rotate(180deg); }
  .pads { display: grid; gap: 6px; padding-top: 4px; }
  /* calm mode and reduced motion (both triggers, the CastBar pattern): the sheet, its dim and its parts do not move */
  :global(html.m-still) .rsdim, :global(html.m-still) .rsheet, :global(html.m-still) .rsheet :global(*), :global(html.m-still) .rsheet :global(*::before) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .rsdim, .rsheet, .rsheet :global(*), .rsheet :global(*::before) { transition: none !important; animation: none !important; }
  }
  /* TV: 54 px targets, 28 px text at 1080p */
  :global(html.tv) .rsheet { width: calc(100vw / 1920 * 760); font-size: calc(100vw / 1920 * 28); }
  :global(html.tv) .rsheet button { min-height: 54px; }
  :global(html.tv) .sb, :global(html.tv) .x { width: 54px; height: 54px; }
  :global(html.tv) .cslot { min-height: calc(3 * 1.35em + 54px + 18px); }
</style>
