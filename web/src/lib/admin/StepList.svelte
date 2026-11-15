<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The one animated step list of Admin -> Update (owner-approved motion mock-up): an updater job, a Portainer redeploy and the
   * page's own redeploy follow all look and move the same; Live TV's job steps use it too (JobSteps.svelte, rows only). Driven
   * only by real state (lib/admin/steps.ts StepFlow): rows rise in once (60 ms stagger), the running row is highlighted with a
   * sweep and a spinning ring, a done step pops a green dot with a check and fills the wire to the next one, a failed one pops red
   * and shakes once, the badge cross-fades in a cell as wide as its widest word, the bar grows by scaleX (a glint while it runs,
   * green / red at the end), the result note slides into a box reserved from the start. Only transform and opacity move; rows
   * keep their height; reduced motion and calm mode (html.m-still) show every state at once.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { stateLabel, type RowState, type StepFlow, type StepRow } from './steps';

  export let flow: Pick<StepFlow, 'rows'> & Partial<StepFlow>;
  /** a heading above the list (h3) */
  export let title = '';
  /** the bar with its two labels (off for Live TV's compact list: its card has its own) */
  export let bar = true;
  /** the reserved box for the result note (off: no note, no box) */
  export let note = true;
  /** announce the running step (off where the card around it has its own live region: Live TV) */
  export let live = true;
  const dispatch = createEventDispatcher<{ retry: void }>();
  const STATES: readonly RowState[] = ['waiting', 'running', 'ok', 'failed', 'skipped'];

  $: outcome = flow.outcome ?? 'running';
  $: current = flow.rows.find((r) => r.state === 'running') ?? null;
  // $t: re-read on a language switch
  $: announced = (void $t, current ? `${flow.count ?? ''} ${current.label}: ${stateLabel('running')}` : '');
  /** a failure is an alert only when it was seen happening; an old outcome on page load is a status */
  let seenRunning = false;
  $: if (outcome === 'running') seenRunning = true;
  /** "What to do?": a disclosure next to the retry button (it stays where it is), its text below, outside the alert */
  let adviceOpen = false;
  const adviceId = `step-advice-${Math.random().toString(36).slice(2, 10)}`;
  const sub = (r: StepRow) => r.sub ?? '';
</script>

<div class="flow f-{outcome}" data-flow={outcome}>
  {#if title}<h3>{title}</h3>{/if}
  {#if bar}
    <div class="top">
      <span class="lbl" class:recon={flow.reconnecting} data-reconnecting={flow.reconnecting ? '' : undefined}>
        {#if flow.reconnecting}<Icon name="refresh" size={14} />{/if}<span title={flow.label ?? ''}>{flow.label ?? ''}</span>
      </span>
      <span class="cnt">{flow.count ?? ''}</span>
    </div>
    <div class="bar bar-{outcome}" role="progressbar" aria-label={$t('admin.update.updater.flow.label')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((flow.progress ?? 0) * 100)}>
      <i class="fill" style="transform: scaleX({flow.progress ?? 0})"></i><i class="glint"></i>
    </div>
  {/if}
  <!-- the state for screen readers: the running step (polite); a failure is the note's alert -->
  {#if live}<p class="sr-only" aria-live="polite">{announced}</p>{/if}
  <ol class="steps">
    {#each flow.rows as r, i (r.key)}
      <li class="row st-{r.state}" style="--i: {i}" data-step={r.key} data-state={r.state} aria-current={r.state === 'running' ? 'step' : undefined}>
        <span class="hl" aria-hidden="true"></span>
        <span class="sheen" aria-hidden="true"></span>
        {#if i < flow.rows.length - 1}<span class="wire" aria-hidden="true"><i></i></span>{/if}
        <span class="dot" aria-hidden="true">
          <span class="d-ring"></span><span class="spin"></span><span class="fillc"></span>
          <span class="ic ic-ok"><Icon name="check" size={16} /></span><span class="ic ic-bad"><Icon name="x" size={14} /></span>
        </span>
        <span class="name">{r.label}{#if r.sub !== undefined}<span class="sub" data-count>{sub(r)}</span>{/if}{#if r.took}<span class="sub took">{r.took}</span>{/if}</span>
        <span class="state">
          {#each STATES as s (s)}<span class="b b-{s}" class:on={r.state === s} aria-hidden={r.state === s ? undefined : 'true'}>{#if s === 'ok'}<Icon name="check" size={13} />{/if}{stateLabel(s)}</span>{/each}
        </span>
      </li>
    {/each}
  </ol>
  {#each Array(flow.reserve ?? 0) as _, k (k)}<div class="slot" aria-hidden="true"></div>{/each}
  {#if note}
    <div class="result">
      {#if flow.note}
        {@const n = flow.note}
        <!-- the headline alone is the live region (alert when the failure was seen happening); "What to do?" keeps its place
             next to the retry button and its text opens below, outside the alert: nothing above it moves -->
        <div class="note n-{n.tone}" data-result={n.result}>
          <Icon name={n.tone === 'ok' ? 'check' : n.tone === 'neutral' ? 'info' : 'alert'} size={22} />
          <div class="body">
            <p class="head" role={n.tone === 'bad' && seenRunning ? 'alert' : 'status'} data-headline><b>{n.text}</b>{#if n.detail}{' '}<span class="muted">{n.detail}</span>{/if}</p>
            {#if n.retry || n.advice}
              <div class="acts">
                {#if n.retry}<Button variant="secondary" icon="refresh" on:click={() => dispatch('retry')}>{$t('admin.update.updater.flow.retry')}</Button>{/if}
                {#if n.advice}<button type="button" class="adv-t" aria-expanded={adviceOpen} aria-controls={adviceId} on:click={() => (adviceOpen = !adviceOpen)}>{$t('admin.update.updater.flow.advice')}</button>{/if}
              </div>
              {#if n.advice}<p class="adv" id={adviceId} hidden={!adviceOpen} data-advice>{n.advice}</p>{/if}
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .flow { display: grid; gap: 12px; min-width: 0; max-width: 40rem; }
  h3 { margin: 0; font-size: 1rem; }
  /* one line whatever the label says (running, reconnecting, the end time): the list below never moves */
  .top { display: flex; justify-content: space-between; gap: .8rem; font-size: .85rem; line-height: 1.5; color: var(--mut); min-width: 0; }
  .lbl { display: inline-flex; align-items: center; gap: .3rem; min-width: 0; }
  .lbl > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lbl.recon { color: var(--fg); }
  .cnt { font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
  /* the bar: one fill scaled from the left (transform only), a glint while it runs */
  .bar { position: relative; height: 6px; border-radius: var(--fr-r-pill); background: var(--tone-muted); overflow: hidden; }
  .bar i { position: absolute; inset: 0; }
  .fill { background: var(--acc); transform-origin: 0 50%; transition: transform 640ms var(--fr-out); }
  .bar.bar-ok .fill { background: var(--ok); } .bar.bar-failed .fill { background: var(--err); } .bar.bar-neutral .fill { background: var(--info); }
  .glint { background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .55), transparent); transform: translateX(-100%); opacity: 0; }
  .bar.bar-running .glint { opacity: 1; animation: ff-glint 1.6s cubic-bezier(.4, 0, .2, 1) infinite; }
  @keyframes ff-glint { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  /* every row keeps one height whatever its state (room for the sub line from the start) */
  .row { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; grid-template-areas: 'dot name state'; align-items: center; column-gap: 14px; min-height: 56px;
    padding: 6px 12px 6px 6px; border-radius: var(--fr-r-tile); opacity: 0; transform: translateY(8px); animation: ff-rise 420ms var(--fr-out) forwards; animation-delay: calc(var(--i) * 60ms); }
  @keyframes ff-rise { to { opacity: 1; transform: none; } }
  .hl, .sheen { position: absolute; inset: 0; border-radius: inherit; opacity: 0; pointer-events: none; transition: opacity var(--m-d-m) var(--fr-out); }
  .hl { background: color-mix(in srgb, var(--acc) 9%, transparent); border: 1px solid color-mix(in srgb, var(--acc) 28%, transparent); }
  .row.st-running .hl { opacity: 1; }
  .row.st-failed .hl { opacity: 1; background: color-mix(in srgb, var(--err) 8%, transparent); border-color: color-mix(in srgb, var(--err) 35%, transparent); }
  .sheen { overflow: hidden; }
  .sheen::before { content: ''; position: absolute; top: 0; bottom: 0; width: 40%; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .07), transparent); transform: translateX(-120%); }
  .row.st-running .sheen { opacity: 1; }
  .row.st-running .sheen::before { animation: ff-sweep 1.8s cubic-bezier(.4, 0, .2, 1) infinite; }
  @keyframes ff-sweep { to { transform: translateX(300%); } }

  .dot { grid-area: dot; position: relative; width: 32px; height: 32px; margin-left: 4px; display: grid; place-items: center; }
  .dot > span { position: absolute; inset: 0; border-radius: 50%; }
  .d-ring { border: 2px solid var(--surface-2); }
  .spin { border: 2px solid transparent; border-top-color: var(--acc); border-right-color: var(--acc); opacity: 0; transition: opacity var(--m-d-s); }
  .row.st-running .spin { opacity: 1; animation: ff-spin .9s linear infinite; }
  .fillc { background: var(--ok); transform: scale(.4); opacity: 0; }
  .row.st-failed .fillc { background: var(--err); }
  .row.st-ok .fillc, .row.st-failed .fillc { animation: ff-pop 420ms var(--fr-spring) forwards; }
  .dot .ic { display: grid; place-items: center; color: var(--bg); opacity: 0; transform: scale(.5); }
  .row.st-ok .ic.ic-ok, .row.st-failed .ic.ic-bad { animation: ff-pop 360ms 120ms var(--fr-spring) forwards; }
  @keyframes ff-pop { 0% { transform: scale(.4); opacity: 0; } 60% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
  .row.st-failed .dot { animation: ff-shake 420ms 80ms cubic-bezier(.36, .07, .19, .97); }
  @keyframes ff-shake { 20% { transform: translateX(-4px); } 40% { transform: translateX(4px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(2px); } }
  .row.st-skipped .d-ring { border-style: dashed; }
  /* the wire from this dot to the next (rows of one height: from below the dot to the next dot's top, over the 6 px gap) */
  .wire { position: absolute; left: 25px; top: calc(50% + 18px); height: calc(100% - 30px); width: 2px; border-radius: 2px; background: var(--line); overflow: hidden; }
  .wire i { position: absolute; inset: 0; background: var(--ok); transform: scaleY(0); transform-origin: 50% 0; transition: transform var(--m-d-l) var(--fr-out); }
  .row.st-ok .wire i { transform: scaleY(1); }

  .name { grid-area: name; position: relative; min-width: 0; overflow-wrap: anywhere; font-weight: 500; line-height: 1.3; }
  .row.st-running .name { font-weight: 600; }
  .row.st-skipped .name { color: var(--mut); }
  .sub { display: block; min-height: 1.3em; margin-top: 2px; font-size: .82rem; font-weight: 400; color: var(--mut); font-variant-numeric: tabular-nums; }
  /* the five badges stacked in one cell: as wide as the widest word, only opacity / transform change */
  .state { grid-area: state; position: relative; display: grid; justify-items: end; }
  .b { grid-area: 1 / 1; display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 12px; border-radius: var(--fr-r-pill); font-size: .8rem; font-weight: 600;
    white-space: nowrap; opacity: 0; transform: translateY(4px); transition: opacity 240ms, transform 240ms var(--fr-out); }
  .b.on { opacity: 1; transform: none; }
  .b.b-waiting, .b.b-skipped { background: var(--wash-muted); color: var(--mut); }
  .b.b-running { background: linear-gradient(color-mix(in srgb, var(--acc) 14%, transparent), color-mix(in srgb, var(--acc) 14%, transparent)), rgba(var(--fr-scrim-rgb), .35); color: var(--acc-light); }
  .b.b-ok { background: var(--wash-ok); color: var(--ok); }
  .b.b-failed { background: var(--wash-err); color: var(--err-mark); }

  /* the note's box is there from the start: the outcome slides into it, nothing below moves */
  /* reserved for a closed note: the longest of the 7 locales measured at 1280 px (132 px) plus ~10 % (phones below) */
  .result { min-height: 9.25rem; display: grid; align-content: start; }
  .note { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px 14px; padding: 14px 18px; border-radius: var(--fr-r-tile); opacity: 0; transform: translateY(8px);
    animation: ff-note 420ms var(--m-emph-out) forwards; min-width: 0; }
  @keyframes ff-note { to { opacity: 1; transform: none; } }
  .body { display: grid; gap: 10px; min-width: 0; }
  .note p { margin: 0; min-width: 0; overflow-wrap: break-word; }
  /* the retry button under the text at every width; "What to do?" beside it, its text opens below the row */
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
  .adv-t { min-height: 44px; padding: 0 4px; background: transparent; color: var(--fg); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
  .adv-t:hover:not(:disabled) { background: var(--tone-muted); }
  .adv { color: var(--mut); }
  /* the room of an update's rollback row (row height + list gap, minus the flow gap this slot adds): nothing moves when it shows */
  .slot { height: 62px; margin-top: -12px; }
  .note b { font-weight: 600; }
  .note > :global(svg) { flex: none; }
  .note.n-ok { background: var(--wash-ok); border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent); } .note.n-ok > :global(svg) { color: var(--ok); }
  .note.n-bad { background: var(--wash-err); border: 1px solid color-mix(in srgb, var(--err) 32%, transparent); } .note.n-bad > :global(svg) { color: var(--err-mark); }
  .note.n-neutral { background: var(--wash-muted); border: 1px dashed var(--fr-line); } .note.n-neutral > :global(svg) { color: var(--info); }

  @media (max-width: 560px) {
    /* phones: the badge goes under the name, rows stay one height */
    .row { grid-template-columns: 40px minmax(0, 1fr); grid-template-areas: 'dot name' 'dot state'; row-gap: 4px; min-height: 84px; }
    .state { justify-items: start; }
    /* phones: the label on up to two lines, the count on its own: room for three lines from the start */
    .top { flex-direction: column; justify-content: flex-start; gap: 0; min-height: 5em; }
    .lbl > span { white-space: normal; overflow-wrap: anywhere; }
    /* phones: the text takes the whole width (the tone stays in the colour and the words), the box fits a closed note */
    /* the longest closed note of the 7 locales at 320 px (pl, a rolled-back job: 280 px) plus ~10 % */
    .result { min-height: 19.5rem; }
    .slot { height: 90px; }
    .note { grid-template-columns: minmax(0, 1fr); padding: 14px 16px; }
    .note > :global(svg) { display: none; }
  }
  /* reduced motion and calm mode: every state at once, nothing moves */
  @media (prefers-reduced-motion: reduce) {
    .row, .row *, .row *::before, .note, .bar i, .fill { animation: none !important; transition-duration: 1ms !important; }
    .row, .note { opacity: 1; transform: none; }
    .row.st-ok .fillc, .row.st-failed .fillc, .row.st-ok .ic.ic-ok, .row.st-failed .ic.ic-bad { opacity: 1; transform: none; }
    .row.st-running .spin { border-color: var(--acc); }
  }
  :global(html.m-still) .row, :global(html.m-still) .row *, :global(html.m-still) .note, :global(html.m-still) .bar i { animation: none !important; transition-duration: 1ms !important; }
  :global(html.m-still) .row, :global(html.m-still) .note { opacity: 1; transform: none; }
  :global(html.m-still) .row.st-ok .fillc, :global(html.m-still) .row.st-failed .fillc, :global(html.m-still) .row.st-ok .ic.ic-ok, :global(html.m-still) .row.st-failed .ic.ic-bad { opacity: 1; transform: none; }
  :global(html.m-still) .row.st-running .spin { border-color: var(--acc); }
</style>
