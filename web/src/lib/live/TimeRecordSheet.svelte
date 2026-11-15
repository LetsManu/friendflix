<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { fmtDate, t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { errorText } from '#lib/ui/action';
  import Field from '#lib/ui/Field.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { toast } from '#lib/ui/toast';
  import { channelHead } from './progress';
  import { conflictText, createRule, hhmm, schedule, type Forecast } from './recordings';

  /**
   * *Neue Aufnahme* (spec §15.1 time-based, plan Phase 3 Task 8): channel, date, start, duration and the weekday chips, for own feeds
   * without a programme guide. Without a weekday it plans one recording (`POST /api/livetv/recordings` with `end` + `title`); with
   * weekdays it is a weekly time rule in the browser's time zone (`POST /api/livetv/rules`). A conflict shows the §20 line in a slot
   * that is reserved from the start, with *Trotzdem planen*. The UI kit's modal frame (focus trap, Escape, focus back to the trigger).
   */
  export let channels: Array<{ id: string; number: number | null; name: string }>;
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ close: void; saved: void }>();
  const two = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  // the next full five minutes
  const first = new Date(Math.ceil(now.getTime() / 300_000) * 300_000);
  let channelId = channels[0]?.id ?? '';
  let date = `${first.getFullYear()}-${two(first.getMonth() + 1)}-${two(first.getDate())}`;
  let start = hhmm(first);
  let duration: string | number = 60;
  let title = '';
  let titleTouched = false;
  let days: number[] = [];
  let busy = false;
  let conflict: Forecast | null = null;

  $: options = channels.map((c) => ({ value: c.id, label: channelHead(c) }));
  $: chName = channels.find((c) => c.id === channelId)?.name ?? '';
  $: if (!titleTouched) title = chName;
  /** 1 = Monday … 7 = Sunday, named in the person's language (2026-11-09 is a Monday) */
  const WEEK = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ d, label: fmtDate(new Date(2026, 10, 8 + d), { weekday: 'short' }).replace(/\.$/, '') }));
  const toggleDay = (d: number) => { days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b); };
  $: minutes = Math.round(Number(duration));
  $: valid = Boolean(channelId) && /^\d\d:\d\d$/.test(start) && minutes >= 1 && minutes <= 1440 && title.trim().length > 0 && (days.length > 0 || /^\d{4}-\d\d-\d\d$/.test(date));

  async function save(force = false): Promise<void> {
    if (!valid || busy) return;
    busy = true;
    try {
      if (days.length) {
        const r = await createRule({ kind: 'time', channelId, weekdays: days, startTime: start, durationMin: minutes, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, title: title.trim() });
        toast.success($t('live.time.savedRule'));
        if (r.forecast?.conflict) toast.info(conflictText(r.forecast));
      } else {
        const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
        const [h, mi] = start.split(':').map(Number) as [number, number];
        const from = new Date(y, mo - 1, d, h, mi);
        const r = await schedule({ channelId, start: from.toISOString(), end: new Date(from.getTime() + minutes * 60_000).toISOString(), title: title.trim(), ...(force ? { force: true } : {}) });
        if (!r.ok) { conflict = r.forecast; return; }
        toast.success($t('live.rec.planned'));
      }
      dispatch('saved');
      dispatch('close');
    } catch (e) {
      toast.error(errorText(e));
    } finally { busy = false; }
  }
</script>

<ModalShell labelledby="ltr-title" focus="select" {trigger} locked={busy} on:close={() => dispatch('close')}>
  <form class="trs" on:submit|preventDefault={() => save(false)}>
    <header>
      <h2 id="ltr-title">{$t('live.time.title')}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} on:click={() => dispatch('close')}><Icon name="x" size={22} /></button>
    </header>
    <Select label={$t('live.time.channel')} bind:value={channelId} {options} />
    <div class="two">
      <Field label={$t('live.time.date')} type="date" bind:value={date} disabled={days.length > 0} />
      <Field label={$t('live.time.start')} type="time" bind:value={start} />
    </div>
    <Field label={$t('live.time.duration')} type="number" min={1} max={1440} step={1} bind:value={duration} />
    <fieldset class="days">
      <legend>{$t('live.time.weekdays')}</legend>
      <div class="chips">
        {#each WEEK as w (w.d)}
          <button type="button" class="chip" aria-pressed={days.includes(w.d)} on:click={() => toggleDay(w.d)}>{w.label}</button>
        {/each}
      </div>
      <p class="hint">{$t('live.time.weekdaysHint')}</p>
    </fieldset>
    <Field label={$t('live.time.name')} bind:value={title} maxlength={200} on:input={() => (titleTouched = true)} />
    <!-- reserved: the conflict line and Trotzdem planen -->
    <div class="cslot" aria-live="polite">
      {#if conflict}
        <p class="cline"><Icon name="alert" size={18} /><span>{conflictText(conflict)}</span></p>
        <button type="button" class="frost-btn force" on:click={() => save(true)}>{$t('live.rec.planAnyway')}</button>
      {/if}
    </div>
    <div class="row">
      <button type="button" class="frost-btn" on:click={() => dispatch('close')}>{$t('common.cancel')}</button>
      <button type="submit" class="primary" disabled={!valid} aria-busy={busy}>{$t('live.time.save')}</button>
    </div>
  </form>
</ModalShell>

<style>
  .trs { display: grid; gap: 12px; width: 100%; max-height: calc(100vh - 7rem); max-height: calc(100dvh - 7rem); overflow-y: auto; box-sizing: border-box; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { margin: 0; font-size: 1.2rem; }
  .x { width: 44px; height: 44px; padding: 0; border-radius: 50%; background: transparent; color: #fff; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .days { margin: 0; padding: 0; border: 0; }
  legend { margin-bottom: 6px; font-size: .95rem; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip, .chip:hover:not(:disabled), .chip:active:not(:disabled) { min-width: 44px; min-height: 44px; padding: 0 10px; border: 0; border-radius: 999px; background: rgba(255, 255, 255, .1); color: #fff; font: inherit; font-weight: 600; transform: none; }
  .chip[aria-pressed='true'] { background: var(--acc-fill); }
  .hint { margin: 6px 0 0; font-size: .85rem; color: var(--hint, rgba(255, 255, 255, .66)); }
  .cslot { min-height: calc(3 * 1.35em + 44px + 8px); }
  .cline { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 8px; line-height: 1.35; color: #f7b344; }
  .cline :global(svg) { flex: none; margin-top: 1px; }
  .force { width: 100%; }
  .row { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
  .row button { min-height: 44px; }
  @media (max-width: 420px) { .two { grid-template-columns: 1fr; } }
</style>
