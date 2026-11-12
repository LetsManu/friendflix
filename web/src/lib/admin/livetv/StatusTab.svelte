<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Live-Status* (spec §9.5): the budget card (read-only, link to the full card), the system tiles (*Laufende Sender*,
   * *Zuschauer*, *CPU*, *GPU* or "–", *DVR-Speicher*), the *Laufende Sender* table (menu *Stoppen* with a confirmation, *Neu starten*),
   * *Ereignisse* (icon + word + the sentence of the code), *Gesendete Streams* (only when push feeds exist), then the card of the
   * installed Live TV itself: version, what the updater says, the GPU advice, the speed measurement's outcome, a running job and
   * "Live-TV ausschalten …" (the dialog belongs to the page; this tab only says which button opened it). Asks the status every 5 s while
   * the tab is visible; a failed poll keeps what is shown. The tiles, the tables and the lines reserve their height before the first
   * answer, so nothing moves when it arrives. Never a URL: the answer carries names and numbers only.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtNumber, t, tr } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import { poll } from '#lib/adminContent/poll';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import type { MoreAction } from '#lib/MoreActions.svelte';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import StatTile from '#lib/ui/StatTile.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import ConversionsCard from '../ConversionsCard.svelte';
  import JobSteps from '../JobSteps.svelte';
  import { listSources } from './api';
  import { whenText } from './sources';
  import { STATUS_POLL_MS, bitrateText, cacheLine, eventText, inputText, levelWord, loadStatus, modeText, stopChannel, type EventLevel, type InputState, type LiveEvent, type LiveStatus, type StatusFeed, type StatusStream } from './status';
  import UpdaterNotes from './UpdaterNotes.svelte';
  import { errorKey, gpuKey, jobRunning, livetvJob, livetvRunning, livetvSteps, otherJobRunning, type LivetvAdminState } from './state';
  import type { Column } from '#lib/ui/table';

  export let s: LivetvAdminState;
  /** the dialog grows out of the button that was pressed */
  const dispatch = createEventDispatcher<{ off: HTMLElement | null }>();

  let st: LiveStatus | null = null, failed = false, gone = false, now = new Date();
  let sourceNames = new Map<string, string>();

  async function load() {
    try {
      const v = await loadStatus();
      if (gone) return;
      st = v; failed = false; now = new Date();
    } catch { if (!st) failed = true; }
  }
  let stopPoll = () => {};
  onMount(() => {
    void load();
    // the names of the sources, for "Quelle {name}: …" in the events (a failure only leaves the word "unbekannt")
    void listSources().then((l) => { if (!gone) sourceNames = new Map(l.map((x) => [x.id, x.name])); }).catch(() => undefined);
    stopPoll = poll(load, STATUS_POLL_MS);
  });
  onDestroy(() => { gone = true; stopPoll(); });

  // ---- the tiles
  const pct = (n: number) => `${fmtNumber(Math.round(n))} %`;
  $: viewers = st ? st.streams.reduce((a, x) => a + x.viewers, 0) : 0;

  // ---- Laufende Sender
  const INPUT_TONE: Record<InputState, Tone> = { ok: 'ok', reconnecting: 'warn', failed: 'err' };
  const LEVEL_TONE: Record<EventLevel, Tone> = { info: 'info', warn: 'warn', error: 'err' };
  $: streamCols = [
    { key: 'name', label: $t('adminLive.status.colChannel'), value: (r) => r.name, primary: true },
    { key: 'mode', label: $t('adminLive.status.colMode'), value: (r) => modeText(r.mode), width: '9rem' },
    { key: 'viewers', label: $t('adminLive.status.viewers'), value: (r) => r.viewers, align: 'end', width: '7rem' },
    { key: 'since', label: $t('adminLive.status.colSince'), value: (r) => new Date(r.since), width: '9rem' },
    { key: 'bitrate', label: $t('adminLive.status.colBitrate'), value: (r) => r.bitrate ?? -1, width: '8rem' },
    { key: 'input', label: $t('adminLive.status.colInput'), value: (r) => inputText(r.input, r.reconnects), width: '13rem' },
  ] as Column<StatusStream>[];

  function menu(r: StatusStream): MoreAction[] {
    return [
      { id: 'stop', label: $t('adminLive.status.stop'), icon: 'stop', danger: true, run: () => stop(r) },
      { id: 'restart', label: $t('adminLive.status.restart'), icon: 'refresh', run: () => stop(r, true) },
    ];
  }
  /** *Stoppen* asks first; *Neu starten* does not (the viewers' players ask for the channel again, which starts it) */
  async function stop(r: StatusStream, restart = false) {
    if (!restart && !(await confirm({ title: tr('adminLive.status.stopTitle', { name: r.name }), body: tr('adminLive.status.stopBody'), danger: true, confirmLabel: tr('adminLive.status.stopConfirm') }))) return;
    const res = await runAction({ key: `ltv-stop:${r.channelId}`, run: () => stopChannel(r.channelId), error: false });
    if (res.skipped || gone) return;
    if (!res.ok) { toast.error(tr('adminLive.status.stopFailed')); return; }
    toast.success(tr(restart ? 'adminLive.status.restarted' : 'adminLive.status.stopped', { name: r.name }));
    await load();
  }

  // ---- Gesendete Streams
  $: feedCols = [
    { key: 'name', label: $t('adminLive.status.colFeed'), value: (r) => r.name, primary: true },
    { key: 'port', label: $t('adminLive.status.colPort'), value: (r) => r.port, width: '6rem' },
    { key: 'state', label: $t('adminLive.status.colState'), value: (r) => (r.state === 'receiving' ? 0 : 1), width: '15rem' },
    { key: 'bitrate', label: $t('adminLive.status.colBitrate'), value: (r) => r.bitrate ?? -1, width: '8rem' },
    { key: 'rejected', label: $t('adminLive.status.colRejected'), value: (r) => r.rejected1h, align: 'end', width: '9rem' },
  ] as Column<StatusFeed>[];

  // ---- Ereignisse
  type Row = LiveEvent & { id: string };
  $: names = new Map<string, string>([...(st?.streams ?? []), ...(st?.ingest ?? [])].map((x) => [x.channelId, x.name]));
  $: rows = st ? st.events.map((e, i): Row => ({ ...e, id: `${i}` })) : null;
  $: eventCols = [
    { key: 'at', label: $t('adminLive.status.colTime'), value: (r) => new Date(r.at), width: '10rem', sortable: false },
    { key: 'level', label: $t('adminLive.status.colLevel'), value: (r) => levelWord(r.level), width: '10rem', sortable: false },
    { key: 'channel', label: $t('adminLive.status.colChannel'), value: (r) => (r.channelId ? names.get(r.channelId) ?? '–' : '–'), width: '12rem', sortable: false },
    { key: 'text', label: $t('adminLive.status.colText'), value: (r) => eventText(r, { source: r.sourceId ? sourceNames.get(r.sourceId) : undefined }), primary: true, sortable: false },
  ] as Column<Row>[];

  // ---- the installed Live TV (what the first version of this tab showed)
  $: job = livetvJob(s);
  $: running = livetvRunning(s);
  $: busy = jobRunning(s);
  $: other = otherJobRunning(s);
  $: gpu = gpuKey(s.gpu.advice);
  $: gpuIcon = s.gpu.advice?.level === 'warn' ? 'alert' : s.gpu.advice?.level === 'ok' ? 'check' : 'info';
  $: failedJob = job && job.state !== 'running' && job.state !== 'succeeded' ? job : null;
  $: bench = s.benchmark;
</script>

<div class="stack">
  <ConversionsCard readOnly link="/admin/playback" />

  {#if failed}
    <AdminCard><div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminLive.status.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div></AdminCard>
  {/if}

  <div class="tiles" role="group" aria-label={$t('adminLive.status.overview')}>
    <StatTile icon="tv" label={$t('adminLive.status.running')} value={st ? fmtNumber(st.streams.length) : null} />
    <StatTile icon="users" label={$t('adminLive.status.viewers')} value={st ? fmtNumber(viewers) : null} />
    <StatTile icon="gauge" label={$t('adminLive.status.cpu')} value={st ? pct(st.system.cpuPct) : null} />
    <StatTile icon="monitor" label={$t('adminLive.status.gpu')} value={st ? (st.system.gpuPct === null ? '–' : pct(st.system.gpuPct)) : null} />
    <StatTile icon="hard-drive" label={$t('adminLive.status.cache')} value={st ? cacheLine(st.system.cache) : null} />
  </div>

  <AdminCard title={$t('adminLive.status.running')}>
    <div class="reserve table-a" data-streams>
      <DataTable rows={st ? st.streams : null} columns={streamCols} key={(r) => r.channelId} caption={$t('adminLive.status.running')} pageSize={0} skeletonRows={3}
        emptyText={$t('adminLive.status.emptyStreams')} actions={menu} rowLabel={(r) => r.name} busyKey={(r) => `ltv-stop:${r.channelId}`}>
        <svelte:fragment slot="cell" let:row let:col>
          {#if col.key === 'name'}
            <span class="who"><span class="logo" aria-hidden="true">{#if row.logoHash}<img src="/api/livetv/logos/{encodeURIComponent(row.logoHash)}" alt="" width="28" height="28" loading="lazy" decoding="async" />{/if}</span><span class="nm">{row.name}</span></span>
          {:else if col.key === 'mode'}
            <StatusPill tone="info" icon="" label={modeText(row.mode)} />
          {:else if col.key === 'viewers'}
            {fmtNumber(row.viewers)}
          {:else if col.key === 'since'}
            {whenText(new Date(row.since), now)}
          {:else if col.key === 'bitrate'}
            {bitrateText(row.bitrate)}
          {:else if col.key === 'input'}
            <span data-input={row.input}><StatusPill tone={INPUT_TONE[row.input]} label={inputText(row.input, row.reconnects)} /></span>
          {/if}
        </svelte:fragment>
      </DataTable>
    </div>
    <p class="hintline">{$t('adminLive.status.viewersNote')}</p>
  </AdminCard>

  <AdminCard title={$t('adminLive.status.events')} description={$t('adminLive.status.eventsHint')}>
    <div class="reserve table-b" data-events>
      <DataTable {rows} columns={eventCols} key={(r) => r.id} caption={$t('adminLive.status.events')} pageSize={10} skeletonRows={3} emptyText={$t('adminLive.status.emptyEvents')}>
        <svelte:fragment slot="cell" let:row let:col>
          {#if col.key === 'at'}
            {whenText(new Date(row.at), now)}
          {:else if col.key === 'level'}
            <span data-level={row.level}><StatusPill tone={LEVEL_TONE[row.level]} label={levelWord(row.level)} /></span>
          {:else if col.key === 'channel'}
            {row.channelId ? names.get(row.channelId) ?? '–' : '–'}
          {:else if col.key === 'text'}
            <span data-code={row.code}>{eventText(row, { source: row.sourceId ? sourceNames.get(row.sourceId) : undefined })}</span>
          {/if}
        </svelte:fragment>
      </DataTable>
    </div>
  </AdminCard>

  {#if st && st.ingest.length}
    <AdminCard title={$t('adminLive.status.pushTitle')}>
      <div data-feeds>
        <DataTable rows={st.ingest} columns={feedCols} key={(r) => r.channelId} caption={$t('adminLive.status.pushTitle')} pageSize={0}>
          <svelte:fragment slot="cell" let:row let:col>
            {#if col.key === 'name'}
              {row.name}
            {:else if col.key === 'port'}
              {row.port}
            {:else if col.key === 'state'}
              <span data-feed={row.state}>
                {#if row.state === 'receiving'}<StatusPill tone="ok" label={$t('adminLive.status.feedOn', { when: row.since === null ? '–' : whenText(new Date(row.since), now) })} />
                {:else}<StatusPill tone="muted" icon="clock" label={$t('adminLive.status.feedIdle')} />{/if}
              </span>
            {:else if col.key === 'bitrate'}
              {bitrateText(row.bitrate)}
            {:else if col.key === 'rejected'}
              {fmtNumber(row.rejected1h)}
            {/if}
          </svelte:fragment>
        </DataTable>
      </div>
    </AdminCard>
  {/if}

  <AdminCard title={$t('adminLive.mini.title')}>
    <p class="ok" role="status"><Icon name="check" size={18} />{$t('adminLive.mini.running')}</p>
    <dl class="ver"><div><dt>{$t('adminLive.mini.version')}</dt><dd><code>{s.version ?? st?.version ?? '–'}</code></dd></div></dl>

    <UpdaterNotes {s} />

    {#if gpu}
      <p class="note" data-gpu={s.gpu.advice?.key} data-level={s.gpu.advice?.level}>
        <Icon name={gpuIcon} size={18} /><span><Rich key={`adminLive.gpu.${gpu}` as 'adminLive.gpu.both'} params={{ driver: s.gpu.advice?.driver }} /></span>
      </p>
    {/if}

    {#if bench}
      <p class="note" data-bench={bench}>
        <Icon name={bench === 'started' ? 'check' : 'info'} size={18} />
        <span>{$t(`adminLive.bench.${bench}` as 'adminLive.bench.started')}{#if bench !== 'started'} {$t('adminLive.bench.later')} <a href="/admin/playback">{$t('adminLive.bench.link')}</a>{/if}</span>
      </p>
    {/if}

    {#if running && job}
      <div class="prog" aria-live="polite">
        <Progress value={null} label={$t('adminLive.mini.working')} />
        <JobSteps {job} steps={livetvSteps(job)} />
      </div>
    {/if}
    <div class="slot">
      {#if failedJob}<p class="note err" role="alert" data-result={failedJob.state}><Icon name="alert" size={18} /><span>{$t(`adminLive.err.${errorKey(failedJob.error)}` as 'adminLive.err.generic')}</span></p>{/if}
    </div>

    <div class="row">
      <Button variant="secondary" icon="x" disabled={busy} on:click={(e) => dispatch('off', e.currentTarget instanceof HTMLElement ? e.currentTarget : null)}>{$t('adminLive.status.off')}</Button>
      {#if other}<span class="muted small" role="status" data-other-job><Icon name="clock" size={16} /> {$t('adminLive.err.updaterBusy')}</span>{/if}
    </div>
  </AdminCard>
</div>

<style>
  .stack { display: grid; gap: 1rem; min-width: 0; }
  .stack > :global(*) { min-width: 0; }
  .state { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; min-height: 3rem; }
  .state p { margin: 0; flex: 1 1 14rem; }
  /* two columns on a phone, three from 900 px; the *DVR-Speicher* tile ("3,1 von 6 GB") always has two columns of room, so its figure
     never wraps. The figure's line keeps its height while the tile still shows the skeleton (1.6rem × 1.15 line height). */
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  .tiles > :global(:nth-child(5)) { grid-column: 1 / -1; }
  .tiles :global(.val) { min-height: calc(1.6rem * 1.15); }
  @media (min-width: 900px) {
    .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .tiles > :global(:nth-child(5)) { grid-column: span 2; }
  }
  /* the tables keep room for their rows before the answer arrives (header + three rows; the empty text fits too) */
  .reserve { min-width: 0; }
  .table-a { min-height: 11.5rem; }
  .table-b { min-height: 13rem; }
  .who { display: inline-flex; align-items: center; gap: .6rem; min-width: 0; }
  .logo { flex: none; width: 28px; height: 28px; border-radius: 6px; background: rgba(255,255,255,.06); display: grid; place-items: center; overflow: hidden; }
  .logo img { width: 28px; height: 28px; object-fit: contain; display: block; }
  .nm { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
  .hintline { margin: .6rem 0 0; color: var(--mut); font-size: .88rem; }
  .muted { color: var(--mut); }
  .small { font-size: .88rem; }

  .ok { display: flex; gap: .5rem; align-items: center; margin: 0 0 .8rem; font-weight: 600; }
  .ok :global(svg) { color: var(--ok); }
  .ver { margin: 0 0 .8rem; }
  .ver > div { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: .6rem; align-items: center; }
  dt { color: var(--mut); font-size: .9rem; } dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,.07); padding: .05rem .4rem; border-radius: 4px; }
  .note { display: flex; gap: .5rem; align-items: flex-start; margin: 0 0 .8rem; padding: .6rem .8rem; border-radius: 8px; background: rgba(255,255,255,.05); overflow-wrap: anywhere; min-width: 0; }
  .note :global(svg) { flex: none; margin-top: .1rem; }
  .note.err :global(svg) { color: var(--err); }
  .note :global(kbd) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .prog { display: grid; gap: .8rem; max-width: 36rem; min-width: 0; margin: 0 0 .8rem; }
  .slot { min-height: 0; }
  .row { display: flex; flex-wrap: wrap; gap: .8rem; align-items: center; }
  @media (max-width: 560px) { .ver > div { grid-template-columns: minmax(0, 1fr); gap: .2rem; } }
</style>
