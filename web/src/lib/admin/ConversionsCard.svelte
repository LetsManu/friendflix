<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Betrieb → Wiedergabe-Check, first card *Umwandlungen* (live TV spec §5.6): how many conversions run against the shared
   * budget, what runs, *Neu messen*, the limit (automatic or own value 1–16) and the priority with the hint of the selected option.
   * `readOnly` (Live-Status reuses the card): the numbers and the list only, optionally with a `link` to the full card.
   * Polls every 5 s while the tab is visible. The measured line, the warning, the note under the button, the last outcome and the
   * priority hint reserve their height, the stepper keeps its place while hidden, so switching options moves nothing.
   */
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtNumber, t, tr } from '#lib/i18n';
  import { poll } from '#lib/adminContent/poll';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import { toast } from '#lib/ui/toast';
  import { uid } from '#lib/ui/ids';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { fieldErrors, saveSettings } from './settings/api';
  import { busyKey, clampSlots, lastLine, measuredLine, priorityHint, PRIORITIES, runningSince, slotSegments, SLOTS_MAX, SLOTS_MIN, startError, type ConvKind, type ConversionsView, type ConvPriority, type SegKind } from './conversions';

  export let readOnly = false;
  export let link: string | null = null;

  const ids = { note: uid('cv-note'), slots: uid('cv-slots'), prio: uid('cv-prio') };
  let view: ConversionsView | null = null, loadErr = false, now = new Date();
  /** saves in flight or queued: a poll must not paint old numbers over the optimistic ones */
  let inflight = 0;

  async function load() {
    if (inflight) return;
    try {
      const v = await api<ConversionsView>('/api/admin/conversions');
      if (inflight) return;
      view = v; now = new Date(); loadErr = false;
    } catch { if (!view) loadErr = true; }
  }

  // ---------------------------------------------------------------- limit and priority (PUT /api/admin/settings, one at a time, in order)
  let chain: Promise<unknown> = Promise.resolve();
  function saveFailed(e: unknown): string {
    return Object.values(fieldErrors(e) ?? {}).includes('locked') ? tr('adminConv.err.locked') : errorText(e);
  }
  function enqueue(values: Record<string, unknown>) {
    inflight++;
    chain = chain
      .then(() => saveSettings(values))
      .catch((e) => { toast.error(saveFailed(e)); })
      .then(() => { inflight--; return load(); });
  }
  function setSlots(value: number | null) {
    if (!view || value === view.custom) return;
    view = { ...view, custom: value, limit: value ?? view.auto };
    enqueue({ CONVERSION_SLOTS: value });
  }
  function setPriority(p: ConvPriority) {
    if (!view || p === view.priority) return;
    view = { ...view, priority: p };
    enqueue({ CONVERSION_PRIORITY: p });
  }
  const step = (d: number) => { if (view) setSlots(clampSlots((view.custom ?? view.limit) + d)); };
  function stepKey(e: KeyboardEvent) {
    const n = view?.custom ?? view?.limit ?? SLOTS_MIN;
    const to = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? n + 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? n - 1 : e.key === 'Home' ? SLOTS_MIN : e.key === 'End' ? SLOTS_MAX : null;
    if (to === null) return;
    e.preventDefault();
    setSlots(clampSlots(to));
  }

  // radio-like segmented controls: arrows move and select, only the selected one is in the tab order
  let modeBtns: HTMLButtonElement[] = [], prioBtns: HTMLButtonElement[] = [];
  function arrows(e: KeyboardEvent, i: number, n: number, btns: HTMLButtonElement[], pick: (j: number) => void) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + n) % n;
    btns[j]?.focus();
    pick(j);
  }

  // ---------------------------------------------------------------- Neu messen
  async function measure() {
    const res = await runAction({
      key: 'conv:bench',
      apply: () => { const prev = view; if (view) view = { ...view, measure: { ...view.measure, running: true } }; return () => { view = prev; }; },
      run: () => api('/api/admin/conversions/benchmark', { method: 'POST' }),
      error: (e) => { const k = startError(e); return k ? tr(k) : errorText(e); },
    });
    if (!res.skipped) await load();
  }

  let stop: (() => void) | undefined;
  onMount(() => { void load(); stop = poll(load, 5000); });
  onDestroy(() => stop?.());

  // ---------------------------------------------------------------- view model
  const ICON: Record<SegKind, string> = { film: 'film', live: 'tv', record: 'record', other: 'activity', free: '' };
  const KIND_KEY = { film: 'adminConv.kind.film', live: 'adminConv.kind.live', record: 'adminConv.kind.record', else: 'adminConv.kind.else' } as const;
  // 'other' would read as a plural form in a dictionary, so the key is `else`
  const kindText = (k: SegKind | ConvKind) => (k === 'free' ? tr('adminConv.free') : tr(KIND_KEY[k === 'download' || k === 'reencode' || k === 'other' ? 'else' : k]));
  const segOf = (k: ConvKind): SegKind => (k === 'film' || k === 'live' || k === 'record' ? k : 'other');
  const prioName = (p: ConvPriority) => tr(`adminConv.priority.${p}`);

  $: segs = view ? slotSegments(view) : [];
  $: barLabel = view ? `${tr('adminConv.bar')}: ${segs.map((s) => kindText(s.kind) + (s.over ? ` (${tr('adminConv.over')})` : '')).join(', ')}` : '';
  $: unsupported = view?.measure.last?.outcome === 'unsupported';
  $: reason = view ? busyKey(view.measure.busy) : null;
  $: measuring = Boolean(view?.measure.running) || $busyKeys.has('conv:bench');
  $: isCustom = view?.custom != null;
  $: customValue = view?.custom ?? view?.limit ?? SLOTS_MIN;
  $: last = view ? lastLine(view.measure.last, now) : null;
  $: warns = view ? [view.bench.noRealtime ? $t('adminConv.noRealtime') : '', view.bench.stale && (view.bench.jellyfin || view.bench.livetv) ? $t('adminConv.stale') : ''].filter(Boolean) : [];
</script>

<AdminCard title={$t('adminConv.title')} description={$t('adminConv.intro')}>
  <svelte:fragment slot="actions">
    {#if link}<Button variant="secondary" href={link}>{$t('adminConv.details')}</Button>{/if}
    {#if !readOnly && !unsupported}
      <Button icon="refresh" pending={measuring} disabled={!view || (Boolean(reason) && !measuring)} aria-describedby={ids.note} on:click={measure}>{$t('adminConv.remeasure')}</Button>
    {/if}
  </svelte:fragment>

  {#if !view && !loadErr}
    <Skeleton lines={3} h="1.1rem" />
  {:else if !view}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminConv.err.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else}
    <p class="big" data-testid="conv-used">{$t('adminConv.used', { u: fmtNumber(view.used), l: fmtNumber(view.limit) })}</p>

    <div class="bar" role="img" aria-label={barLabel}>
      {#each segs as s, i (i)}
        <span class="seg-cell {s.kind}" class:over={s.over}>
          {#if s.over}<Icon name="alert" size={18} />{:else if ICON[s.kind]}<Icon name={ICON[s.kind]} size={18} />{/if}
          <span class="lbl">{kindText(s.kind)}</span>
          {#if s.over}<span class="lbl sub">{$t('adminConv.over')}</span>{/if}
        </span>
      {/each}
    </div>

    <p class="line meas" data-testid="conv-measured">{measuredLine(view, now)}</p>
    <div class="line warns" data-testid="conv-warn">
      {#each warns as w (w)}<p class="warn"><Icon name="alert" size={16} /><span>{w}</span></p>{/each}
    </div>
    {#if !readOnly}
      <p class="line note" id={ids.note} role="status">
        {#if view.measure.running}{$t('adminConv.measuring')}{:else if reason}{$t(reason)}{/if}
      </p>
      <p class="line lastl" class:okl={last?.tone === 'ok'} data-testid="conv-last">
        {#if last}<Icon name={last.tone === 'ok' ? 'check' : last.tone === 'warn' ? 'alert' : 'info'} size={16} /><span>{last.text}</span>{/if}
      </p>

      <div class="ctl" role="group" aria-labelledby={ids.slots}>
        <h3 id={ids.slots}>{$t('adminConv.slots.label')}</h3>
        <div class="row">
          <div class="seg" role="radiogroup" aria-labelledby={ids.slots}>
            <button type="button" role="radio" aria-checked={!isCustom} tabindex={isCustom ? -1 : 0} class:on={!isCustom} bind:this={modeBtns[0]}
              on:click={() => setSlots(null)} on:keydown={(e) => arrows(e, 0, 2, modeBtns, (j) => (j === 0 ? setSlots(null) : setSlots(clampSlots(view?.limit ?? SLOTS_MIN))))}>{$t('adminConv.auto', { n: fmtNumber(view.auto) })}</button>
            <button type="button" role="radio" aria-checked={isCustom} tabindex={isCustom ? 0 : -1} class:on={isCustom} bind:this={modeBtns[1]}
              on:click={() => { if (!isCustom) setSlots(clampSlots(view?.limit ?? SLOTS_MIN)); }} on:keydown={(e) => arrows(e, 1, 2, modeBtns, (j) => (j === 0 ? setSlots(null) : setSlots(clampSlots(view?.limit ?? SLOTS_MIN))))}>{$t('adminConv.custom')}</button>
          </div>
          <div class="step" class:off={!isCustom} role="group" aria-label={$t('adminConv.slots.value')} aria-hidden={isCustom ? undefined : 'true'}>
            <button type="button" class="sb" aria-label={$t('adminConv.slots.less')} disabled={!isCustom || customValue <= SLOTS_MIN} on:click={() => step(-1)}><span aria-hidden="true">−</span></button>
            <span class="val" role="spinbutton" tabindex={isCustom ? 0 : -1} aria-label={$t('adminConv.slots.value')} aria-valuemin={SLOTS_MIN} aria-valuemax={SLOTS_MAX} aria-valuenow={customValue} on:keydown={stepKey}>{customValue}</span>
            <button type="button" class="sb" aria-label={$t('adminConv.slots.more')} disabled={!isCustom || customValue >= SLOTS_MAX} on:click={() => step(1)}><Icon name="plus" size={18} /></button>
          </div>
        </div>
      </div>

      <div class="ctl" role="group" aria-labelledby={ids.prio}>
        <h3 id={ids.prio}>{$t('adminConv.priority.label')}</h3>
        <div class="seg wrap" role="radiogroup" aria-labelledby={ids.prio}>
          {#each PRIORITIES as p, i (p)}
            <button type="button" role="radio" aria-checked={view.priority === p} tabindex={view.priority === p ? 0 : -1} class:on={view.priority === p} bind:this={prioBtns[i]}
              on:click={() => setPriority(p)} on:keydown={(e) => arrows(e, i, PRIORITIES.length, prioBtns, (j) => setPriority(PRIORITIES[j] ?? p))}>{prioName(p)}</button>
          {/each}
        </div>
        <div class="hints">
          {#each PRIORITIES as p (p)}
            <p class="hint" class:on={view.priority === p}>{$t(priorityHint(p))}</p>
          {/each}
        </div>
      </div>
    {/if}

    <h3 class="rh">{$t('adminConv.running.title')}</h3>
    {#if view.running.length}
      <ul class="runs" aria-label={$t('adminConv.running.title')}>
        {#each view.running as r, i (i)}
          <li>
            <Icon name={ICON[segOf(r.kind)]} size={18} />
            <span class="what"><b>{r.label ?? kindText(r.kind)}</b><span class="kind">{kindText(r.kind)}</span></span>
            <span class="meta">{runningSince(r.since, now)}</span>
            <span class="meta dev">{r.device ?? '–'}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted none">{$t('adminConv.running.none')}</p>
    {/if}
  {/if}
</AdminCard>

<style>
  .big { font-size: 1.7rem; font-weight: 800; margin: 0 0 .7rem; font-variant-numeric: tabular-nums; }
  .muted { color: var(--mut); }
  .none { margin: .3rem 0 0; min-height: 1.45em; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 1.2rem 1rem; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }

  /* the slot bar: one cell per slot, icon + word in each (never colour alone) */
  .bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(5.4rem, 1fr)); gap: .4rem; }
  .seg-cell { min-width: 0; min-height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .1rem; padding: .35rem .3rem; border-radius: 10px; border: 1px solid var(--line); background: rgba(255, 255, 255, .12); font-size: .85rem; text-align: center; }
  .seg-cell .lbl { overflow-wrap: anywhere; }
  .seg-cell .sub { font-size: .75rem; }
  .seg-cell.free { background: transparent; border-style: dashed; color: var(--mut); }
  .seg-cell.over { border: 2px solid var(--err); }
  .seg-cell.over :global(svg) { color: var(--err); }

  .rh { font-size: .95rem; margin: 1.3rem 0 .2rem; }
  .runs { list-style: none; margin: .3rem 0 0; padding: 0; display: grid; gap: .3rem; }
  .runs li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: .2rem .7rem; min-height: 44px; padding: .2rem .1rem; border-bottom: 1px solid rgba(255, 255, 255, .06); }
  .what { display: flex; flex-direction: column; min-width: 0; }
  .what b { overflow-wrap: anywhere; }
  .kind, .meta { color: var(--mut); font-size: .85rem; }
  .dev { overflow-wrap: anywhere; text-align: end; max-width: 12rem; }
  @media (max-width: 560px) {
    .runs li { grid-template-columns: auto minmax(0, 1fr); }
    .runs .meta { grid-column: 2; text-align: start; max-width: none; }
  }

  /* reserved lines: nothing below moves when a line appears or goes */
  .line { margin: .5rem 0 0; min-height: 1.45em; font-size: .9rem; }
  .meas { color: var(--mut); overflow-wrap: anywhere; }
  .warns { display: grid; gap: .2rem; }
  .warn { display: flex; gap: .4rem; align-items: flex-start; margin: 0; }
  .warn :global(svg) { color: var(--err); flex: none; margin-top: .15rem; }
  .note { color: var(--fg); }
  .lastl { display: flex; gap: .4rem; align-items: flex-start; color: var(--mut); }
  .lastl :global(svg) { flex: none; margin-top: .15rem; }
  .lastl.okl :global(svg) { color: var(--ok); }
  @media (max-width: 560px) { .meas, .warns, .lastl { min-height: 2.9em; } }

  .ctl { margin-top: 1.1rem; }
  .ctl h3 { font-size: .95rem; margin: 0 0 .5rem; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1rem; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 3px; gap: 3px; max-width: 100%; }
  .seg.wrap { flex-wrap: wrap; border-radius: 22px; }
  .seg button { min-height: 44px; min-width: 44px; padding: .3rem 1.1rem; border-radius: 999px; background: transparent; border: 0; color: var(--mut); font-weight: 600; }
  .seg button.on { background: var(--fg); color: var(--bg, #101418); }
  .seg button:not(.on):hover:not(:disabled) { color: var(--fg); background: rgba(255, 255, 255, .07); }

  /* the stepper keeps its place while it is off (opacity, then visibility) */
  .step { display: inline-flex; align-items: center; gap: .4rem; opacity: 1; transition: opacity var(--t-fast); }
  .step.off { opacity: 0; visibility: hidden; transition: opacity var(--t-fast), visibility 0s linear var(--t-fast); }
  .sb { min-width: 44px; min-height: 44px; padding: 0; border-radius: 999px; background: transparent; border: 1px solid var(--line); color: var(--fg); font-size: 1.3rem; line-height: 1; }
  .sb:disabled { opacity: .4; cursor: not-allowed; }
  .val { min-width: 3rem; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; font-size: 1.2rem; font-weight: 700; font-variant-numeric: tabular-nums; border-radius: 8px; }

  /* the hint of each option sits in the same grid cell: the line is as tall as the longest, the selected one is shown */
  .hints { display: grid; margin-top: .6rem; }
  .hint { grid-area: 1 / 1; margin: 0; color: var(--mut); font-size: .9rem; opacity: 0; visibility: hidden; transition: opacity var(--t-fast), visibility 0s linear var(--t-fast); }
  .hint.on { opacity: 1; visibility: visible; transition: opacity var(--t-fast); }
  :global(html.m-still) .step, :global(html.m-still) .step.off, :global(html.m-still) .hint, :global(html.m-still) .hint.on { transition: none; }
  :global(html.tv) .seg button, :global(html.tv) .sb { min-height: 48px; }
</style>
