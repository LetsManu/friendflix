<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The move from the existing Jellyfin to the managed Ferrofin (spec "The move", "Web"), opened from *Von Jellyfin umziehen*: the
   * base folder first when none is confirmed; the Jellyfin containers (POST …/move/scan), a picker when more than one can be the
   * source (the one FriendFlix uses chosen, another server's disabled); the chosen one's sized scan, which runs in the background
   * (the card polls the view while `move.scan` runs); a refusal with its container paths (`source_outside_base`: *Basisordner
   * ändern* opens the base folder's form in place); the summary of the spec's sketch (folders, copy with the trickplay switch, the
   * plugins left behind, the downtime as an upper bound, the request service when one is set up, the old Jellyfin, the way back) and *Umziehen* (re-authentication through
   * the card's `call`); then the step list (model.ts moveSteps) with *Umzug abbrechen* until the switch, and the outcome line.
   * Closing the sheet never stops a move: the card shows it and opens the sheet again (`follow`). The panel has one height for every
   * stage (its middle scrolls): the scan line, the summary and the steps take the same room, the buttons never move.
   */
  import { createEventDispatcher } from 'svelte';
  import { ApiError, apiCode } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtList, t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { confirm } from '#lib/ui/confirm';
  import { fmtBytes } from '#lib/ui/format';
  import type { UpdaterJob } from '../updater';
  import type { MediaApi, MediaView, MoveCandidate, MoveScanRecord } from './api';
  import BaseFolder from './BaseFolder.svelte';
  import { autoCandidate, candidateSelectable, mediaErrorText, moveAbortable, moveActive, moveResult, moveSteps, moveSummary, scanFresh } from './model';

  export let api: MediaApi;
  export let call: <T>(fn: () => Promise<T>) => Promise<T>;
  export let view: MediaView;
  /** opened to watch a move under way (the card's *Fortschritt ansehen*): the steps stay after it ended */
  export let follow = false;
  export let trigger: HTMLElement | null = null;
  const dispatch = createEventDispatcher<{ close: void; changed: void; started: UpdaterJob | null }>();
  let shell: ModalShell;

  /** a refusal and the container paths it names (outside the base, refused, nested: never a host path) */
  type Refusal = { code: string; paths: string[] };
  const list_ = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  const pathsOf = (b: { outside?: unknown; refused?: unknown; nested?: unknown } | null | undefined): string[] =>
    [...new Set([...list_(b?.outside), ...list_(b?.refused), ...list_(b?.nested)])].slice(0, 20);
  const paths = (e: unknown): string[] => pathsOf(e instanceof ApiError ? (e.body as Record<string, unknown> | null) : null);
  /** a container's state in the words of *Status* */
  const STATES = ['running', 'exited', 'created', 'restarting', 'paused', 'dead'] as const;
  const stateKey = (s: string): (typeof STATES)[number] | 'unknown' => (STATES.find((x) => x === s) ?? 'unknown');

  /** null until listed */
  let candidates: MoveCandidate[] | null = null;
  /** a scan still running when the sheet opens (closed and opened again meanwhile): it is followed, no second one is asked for (busy) */
  const running0 = view.move?.scan?.state === 'running' ? view.move.scan : null;
  /** the picker's choice, and the candidate scanned (or being scanned) */
  let chosen: string | null = null, source: string | null = running0?.source ?? null;
  /** the scan this sheet started or follows (the view's record counts once it is this one or newer) */
  let pending: MoveScanRecord | null = running0;
  let refusal: Refusal | null = null, error = '', busy: '' | 'list' | 'scan' | 'move' | 'abort' = '';
  let trickplay = false, editBase = false, needList = running0 === null;
  /** the job of the move started here: its state is followed to the end */
  let ranJob: string | null = null;

  $: base = view.status?.base ?? { set: false, path: null, pending: false, expiresAt: null };
  $: st = view.move?.state ?? null;
  $: rec = view.move?.scan ?? null;
  $: scanRec = source && rec?.source === source && (!pending || rec.at >= pending.at) ? rec : source && pending?.source === source ? pending : null;
  $: progress = moveActive(view) || Boolean(st && (follow || (ranJob !== null && (st.jobId === ranJob || ranJob === ''))));
  $: scanRefusal = scanRec?.state === 'failed' ? { code: scanRec.error ?? 'updater_error', paths: pathsOf(scanRec) } : null;
  $: shown = refusal ?? scanRefusal;
  $: stage = progress ? 'progress'
    : !base.set || editBase ? 'base'
      : shown ? 'refused'
        : source ? (scanRec?.state === 'done' && scanRec.result ? 'summary' : 'scanning')
          : candidates === null ? 'searching' : 'pick';
  $: if (needList && base.set && !editBase && !progress) void list();

  // the container's name once known; it stays in the title through the steps (the scan record goes once the move switched)
  let name = '';
  $: {
    const n = scanRec?.result?.source.name ?? view.status?.move?.source.name ?? view.move?.migratedFrom?.name ?? candidates?.find((c) => c.id === source)?.name;
    if (n) name = n;
  }
  $: title = name && (stage === 'summary' || stage === 'progress') ? $t('mediaserver.move.titleFrom', { name }) : $t('mediaserver.move.title');

  async function list() {
    needList = false; busy = 'list'; refusal = null; error = '';
    try {
      const r = await call(() => api.moveScan());
      const cs = r.candidates ?? [];
      candidates = cs;
      const auto = autoCandidate(cs);
      chosen = (cs.find((c) => c.matches === true) ?? auto ?? cs.find(candidateSelectable))?.id ?? null;
      if (!cs.some(candidateSelectable)) refusal = { code: 'source_missing', paths: [] };
      else if (auto) await scan(auto.id);
    } catch (e) {
      candidates = [];
      refusal = { code: apiCode(e) ?? 'unknown', paths: paths(e) };
    } finally { if (busy === 'list') busy = ''; }
  }

  /** a fresh done scan of the same container is reused; otherwise its sized scan starts (the card follows the view while it runs) */
  async function scan(id: string) {
    source = id; refusal = null; error = '';
    if (scanFresh(view.move?.scan, id, Date.now())) { pending = null; return; }
    busy = 'scan';
    try {
      const r = await call(() => api.moveScan(id));
      pending = r.scan ?? { source: id, state: 'running', at: new Date().toISOString() };
      dispatch('changed');
    } catch (e) {
      refusal = { code: apiCode(e) ?? 'unknown', paths: paths(e) };
    } finally { busy = ''; }
  }
  const rescan = () => { if (source) void scan(source); else { candidates = null; needList = true; } };

  function baseChanged() {
    editBase = false; candidates = null; source = null; pending = null; refusal = null; needList = true;
    dispatch('changed');
  }

  async function start() {
    if (!source || busy) return;
    const src = source;
    busy = 'move'; error = '';
    try {
      const r = await call(() => api.move({ source: src, trickplay }));
      ranJob = r.job?.id ?? '';
      dispatch('started', r.job ?? null);
    } catch (e) {
      const c = apiCode(e);
      // the scan expired or belongs to another container: scan it again (the summary comes back)
      if (c === 'scan_required') { busy = ''; await scan(src); return; }
      error = mediaErrorText(c);
    } finally { if (busy === 'move') busy = ''; }
  }

  async function abort() {
    const ok = await confirm({ title: tr('mediaserver.move.abortTitle'), body: tr('mediaserver.move.abortBody'), danger: true, confirmLabel: tr('mediaserver.move.abort'), cancelLabel: tr('mediaserver.move.abortKeep') });
    if (!ok) return;
    busy = 'abort'; error = '';
    try {
      await call(() => api.moveAbort());
      dispatch('changed');
    } catch (e) {
      error = mediaErrorText(apiCode(e));
    } finally { busy = ''; }
  }

  $: summary = stage === 'summary' && scanRec?.result ? moveSummary(scanRec.result, trickplay) : null;
  $: tpBytes = scanRec?.result?.trickplayBytes ?? 0;
  $: quote = (n: string) => $t('mediaserver.move.quoted', { name: n });
  $: rows = moveSteps(view);
  $: result = progress ? moveResult(st) : null;
  $: ended = Boolean(result);
  $: abortable = progress && moveAbortable(view);
  $: aborting = progress && !ended && st?.abort === true;
</script>

<ModalShell bind:this={shell} labelledby="mv-t" width={600} {trigger} on:close={() => dispatch('close')}>
  <form class="mv" novalidate on:submit|preventDefault={() => (stage === 'summary' ? start() : undefined)}>
    <h2 id="mv-t" class="dlg-title">{title}</h2>
    <div class="dlg-main">
      <div class="stage" data-testid="move-stage" data-stage={stage}>
        {#if stage === 'base'}
          <p class="lead">{$t('mediaserver.move.baseFirst')}</p>
          <BaseFolder {api} {call} {base} startEditing={editBase} on:changed={baseChanged} />
        {:else if stage === 'searching'}
          <p class="wait" role="status"><span class="spin" aria-hidden="true"></span>{$t('mediaserver.move.searching')}</p>
        {:else if stage === 'pick' && candidates}
          <p class="lead" id="mv-pick-h">{$t('mediaserver.move.pickHint')}</p>
          <div class="pick" role="radiogroup" aria-label={$t('mediaserver.move.pick')} aria-describedby="mv-pick-h">
            {#each candidates as c (c.id)}
              {@const ok = candidateSelectable(c)}
              <label class="cand" class:off={!ok} data-candidate={c.name}>
                <input type="radio" name="mv-cand" value={c.id} bind:group={chosen} disabled={!ok} />
                <span class="cn"><strong>{c.name}</strong>
                  <span class="muted">{[c.image, $t(`mediaserver.status.states.${stateKey(c.state)}`)].join(' · ')}</span>
                  {#if c.matches !== null}<span class:match={c.matches}>{c.matches ? $t('mediaserver.move.match') : $t('mediaserver.move.otherServer')}</span>{/if}</span>
              </label>
            {/each}
          </div>
        {:else if stage === 'scanning'}
          <p class="wait" role="status"><span class="spin" aria-hidden="true"></span>{$t('mediaserver.move.scanning', { name: name || '…' })}</p>
          <p class="muted small">{$t('mediaserver.move.scanHint')}</p>
        {:else if stage === 'refused' && shown}
          <p class="bad" role="alert"><Icon name="alert" size={18} />{mediaErrorText(shown.code)}</p>
          {#if shown.paths.length}<ul class="paths">{#each shown.paths as p (p)}<li><code>{p}</code></li>{/each}</ul>{/if}
          <div class="acts">
            {#if shown.code === 'source_outside_base' || shown.code === 'no_base'}
              <Button variant="secondary" icon="hard-drive" on:click={() => (editBase = true)}>{$t('mediaserver.move.changeBase')}</Button>
            {/if}
            <Button variant="ghost" icon="refresh" pending={busy === 'scan' || busy === 'list'} on:click={rescan}>{$t('mediaserver.move.rescan')}</Button>
          </div>
        {:else if stage === 'summary' && summary}
          <dl class="sum" data-testid="move-summary">
            <div><dt>{$t('mediaserver.move.row.folders')}</dt><dd>{$t('mediaserver.move.folders', { list: summary.folders.join(', ') })}</dd></div>
            <div><dt>{$t('mediaserver.move.row.copy')}</dt><dd>
              <span class="copy">{$t(trickplay ? 'mediaserver.move.copyWith' : 'mediaserver.move.copy', { size: fmtBytes(summary.bytes) })}</span>
              {#if tpBytes > 0}<Toggle label={$t('mediaserver.move.trickplay', { size: fmtBytes(tpBytes) })} bind:checked={trickplay} disabled={busy !== ''} />{/if}
            </dd></div>
            <div><dt>{$t('mediaserver.move.row.skipped')}</dt><dd>{summary.plugins.length ? $t('mediaserver.move.plugins', { list: fmtList(summary.plugins.map(quote)) }) : $t('mediaserver.move.noPlugins')}</dd></div>
            <div><dt>{$t('mediaserver.move.row.downtime')}</dt><dd>{$t('mediaserver.move.downtime', { n: summary.downtimeMin })}</dd></div>
            {#if view.move?.requests}<div><dt>{$t('mediaserver.move.row.requests')}</dt><dd>{$t('mediaserver.move.requests')}</dd></div>{/if}
            <div><dt>{$t('mediaserver.move.row.old')}</dt><dd>{$t('mediaserver.move.old')}</dd></div>
            <div><dt>{$t('mediaserver.move.row.back')}</dt><dd>{$t('mediaserver.move.back')}</dd></div>
          </dl>
        {:else if stage === 'progress'}
          <h3 class="sr-only">{$t('mediaserver.move.steps')}</h3>
          <ol class="steps" data-testid="move-steps" data-phase={st?.phase ?? ''}>
            {#each rows as r (r.step)}
              <li class="st-{r.state}" data-step={r.step} data-state={r.state} aria-current={r.state === 'running' ? 'step' : undefined}>
                <span class="dot" aria-hidden="true"><span class="ic ok"><Icon name="check" size={14} /></span><span class="ic no"><Icon name="x" size={14} /></span><span class="spinr"></span></span>
                <span class="name">{$t(`mediaserver.move.step.${r.step}`)}</span>
                <span class="state">{$t(`mediaserver.setup.state.${r.state}`)}</span>
              </li>
            {/each}
          </ol>
          <!-- reserved: the outcome line has its room from the first step -->
          <p class="res" class:bad={result && !result.ok} role={result && !result.ok ? 'alert' : 'status'} data-testid="move-result">{result?.text ?? (aborting ? $t('mediaserver.move.aborting') : '')}</p>
        {/if}
      </div>
    </div>
    <p class="dlg-err" role={error ? 'alert' : undefined}>{error}</p>
    <div class="dlg-acts" data-testid="move-actions">
      {#if stage === 'progress'}
        {#if !ended}<Button variant="danger" pending={busy === 'abort'} disabled={!abortable || busy !== ''} on:click={abort}>{$t('mediaserver.move.abort')}</Button>{/if}
        <Button variant={ended ? 'primary' : 'glass'} on:click={() => shell.dismiss()}>{$t('common.close')}</Button>
      {:else}
        <Button variant="glass" on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
        {#if stage === 'pick'}
          <Button pending={busy === 'scan'} disabled={!chosen} on:click={() => chosen && scan(chosen)}>{$t('mediaserver.move.check')}</Button>
        {:else if stage === 'summary'}
          <Button type="submit" pending={busy === 'move' || (ranJob !== null && !progress)}>{$t('mediaserver.move.start')}</Button>
        {/if}
      {/if}
    </div>
  </form>
</ModalShell>

<style>
  /* one height for every stage (the middle scrolls): nothing below the title moves while the sheet goes from scan to steps */
  .mv { height: min(44rem, calc(100dvh - 7rem)); }
  .mv > .dlg-main { flex: 1 1 auto; }
  .stage { display: grid; align-content: start; gap: .7rem; }
  .lead { margin: 0; }
  .small { margin: 0; font-size: .88rem; }
  .wait { display: flex; align-items: center; gap: .6rem; margin: .4rem 0 0; min-height: 44px; }
  .spin { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--acc); animation: mv-spin 1s linear infinite; }
  @keyframes mv-spin { to { transform: rotate(360deg); } }
  .pick { display: grid; gap: .4rem; }
  .cand { display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: .6rem; min-height: 44px; padding: .45rem .7rem; border-radius: var(--fr-r-card);
    border: 1px solid var(--line); cursor: pointer; }
  .cand input { width: 20px; height: 20px; margin: 0; accent-color: var(--acc); }
  .cand.off { opacity: .55; cursor: not-allowed; }
  .cn { display: grid; gap: .1rem; min-width: 0; }
  .cn strong, .cn span { overflow-wrap: anywhere; }
  .cn span { font-size: .85rem; }
  .cn .match { color: var(--ok); }
  .bad { display: flex; align-items: flex-start; gap: .45rem; margin: 0; }
  .bad :global(svg) { flex: none; margin-top: .1rem; color: var(--err-mark); }
  .paths { margin: 0; padding-left: 1.2rem; display: grid; gap: .2rem; }
  .paths code { overflow-wrap: anywhere; }
  .acts { display: flex; flex-wrap: wrap; gap: .5rem; }
  .sum { margin: 0; display: grid; }
  .sum div { display: grid; grid-template-columns: 10rem minmax(0, 1fr); gap: .2rem .8rem; padding: .5rem 0; border-top: 1px solid var(--line); }
  .sum div:first-child { border-top: 0; }
  .sum dt { color: var(--mut); }
  .sum dt, .sum dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .sum dd { display: grid; gap: .3rem; }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .steps li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: .6rem; min-height: 36px; padding: 0 .4rem; border-radius: var(--fr-r-card); }
  .steps li.st-running { background: rgba(var(--acc-rgb), .1); }
  .name { min-width: 0; overflow-wrap: anywhere; }
  .state { color: var(--mut); font-size: .85rem; }
  .dot { position: relative; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line); display: grid; place-items: center; }
  .ic, .spinr { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; transition: opacity .2s ease; }
  .st-done .dot { border-color: var(--ok); background: var(--ok); color: #101418; }
  .st-done .ok, .st-failed .no { opacity: 1; }
  .st-failed .dot { border-color: var(--err); background: var(--err); color: #fff; }
  .st-running .dot { border-color: var(--acc); }
  .st-running .spinr { opacity: 1; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--acc); margin: -2px; animation: mv-spin 1s linear infinite; }
  .res { margin: 0; min-height: 3.9em; font-size: .92rem; color: var(--mut); }
  .res.bad { color: var(--fg); }
  /* a phone: the buttons stacked at full width in a room for two, whatever the stage shows (one or two): the row never moves */
  @media (max-width: 520px) {
    .sum div { grid-template-columns: minmax(0, 1fr); }
    .dlg-acts { display: grid; grid-template-columns: minmax(0, 1fr); align-content: end; min-height: calc(2 * 44px + 10px); }
  }
  @media (prefers-reduced-motion: reduce) { .spin, .st-running .spinr { animation: none; } .ic, .spinr { transition: none; } }
  :global(html.m-still) .spin, :global(html.m-still) .st-running .spinr { animation: none; }
</style>
