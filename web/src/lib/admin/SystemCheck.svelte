<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The Systemcheck section of Admin → Status (#systemcheck): the time of the check, the counts, "Jetzt prüfen", then the six groups in
   * fixed order with every catalogue line. Self-loading (cached answer on mount and every 30 s while visible); "Jetzt prüfen" asks for a
   * fresh run (6 per minute: a 429 keeps the last list and says so) and reloads the warning banner. The skeleton has the final row count.
   * The four checks only the browser can run (syscheckBrowser.ts) start once there is an answer to read Live TV from (on mount, and again
   * after Jetzt prüfen); their lines read "wird geprüft…" until they are back and then replace their placeholders.
   * The last answer of this tab is shown at once and revalidated (stale-while-revalidate); `ready` turns true as soon as there is an
   * answer to show (remembered, loaded or failed), so the page can hold what sits below until the list has its final height.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { apiCode } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr, type TKey } from '#lib/i18n';
  import { poll } from '#lib/adminContent/poll';
  import { errorText } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import { refreshBanner } from './banner';
  import CheckLine from './CheckLine.svelte';
  import { runBrowserChecks, uploadNotSetUp } from './syscheckBrowser';
  import {
    CHECK_GROUPS, CHECK_IDS, cachedSystemcheck, checkedAtText, countLines, isNewer, loadSystemcheck, mergeLines, statusIcon, statusTone, summaryOf,
    type CheckGroup, type CheckId, type CheckLine as Line, type CheckStatus, type SystemcheckResult,
  } from './syscheck';

  /** the browser checks' results, and whether they are running ("wird geprüft…" on their lines) */
  let browserLines: Line[] = [];
  let browserRunning = false;
  let browserRun = 0;
  /** bindable: there is something to show (the list has its final rows); false only during a cold first load */
  export let ready = false;
  const dispatch = createEventDispatcher<{ checked: void }>();

  let result: SystemcheckResult | null = cachedSystemcheck();
  if (result) ready = true;
  let failed = false, checking = false, retrying = false;
  /** a reload failed while an older answer is shown: the time reads "Stand von …" until one succeeds */
  let stale = false;
  // $t as an argument: the time follows a language switch
  const atText = (at: string, old: boolean, _tr: unknown) => checkedAtText(at, old);
  /** what the polite status region says: loading, then the summary after the first answer and after Jetzt prüfen (never on a silent poll) */
  let announce = result ? '' : tr('ui.table.loading');

  /** Live TV from the server's livetv.container line: installed, not (not set up, or down), or not known (no answer yet, not checked) */
  function livetvOf(r: SystemcheckResult | null): boolean | null {
    const l = r?.lines.find((x) => x?.id === 'livetv.container');
    if (!l || l.status === 'unknown') return null;
    return l.status !== 'not_set_up' && l.status !== 'problem';
  }
  /** the browser checks (on mount once an answer is there, and after Jetzt prüfen); a newer run's answer wins */
  async function runBrowser() {
    const mine = ++browserRun;
    browserRunning = true;
    const lines = await runBrowserChecks({ livetvInstalled: livetvOf(result) }).catch(() => [] as Line[]);
    if (mine !== browserRun) return;
    browserLines = lines;
    browserRunning = false;
  }
  let browserStarted = false;
  function startBrowser() {
    if (browserStarted) return;
    browserStarted = true;
    void runBrowser();
  }

  /** the cached answer; it never replaces a newer one (a poll that started before Jetzt prüfen and answers after it) */
  async function load() {
    const first = result === null;
    try {
      const r = await loadSystemcheck();
      if (!checking && isNewer(r, result)) result = r;
      failed = false;
      stale = false;
      if (first && result) announce = summaryOf(result.counts).text;
    } catch {
      failed = result === null;
      stale = result !== null;
      if (failed) announce = tr('syscheck.loadFailed');
    }
    ready = true;
    startBrowser();
  }
  async function retry() { retrying = true; await load(); retrying = false; }
  /** "Jetzt prüfen": a fresh run on the server (it waits for the slow inputs, bounded there) */
  async function checkNow() {
    if (checking) return;
    checking = true;
    try {
      result = await loadSystemcheck(true);
      failed = false;
      stale = false;
      announce = summaryOf(result.counts).text;
      toast.success(tr('adminContent.health.checked'));
      void refreshBanner(); // the banner shows the new state now, not after its next 60 s poll
      dispatch('checked');
      void runBrowser(); // with the fresh Live-TV state
    } catch (e) {
      toast.error(apiCode(e) === 'rate_limited' ? tr('syscheck.rateLimited') : errorText(e));
    }
    checking = false;
  }
  onMount(() => {
    if (result) startBrowser(); // the remembered answer says enough about Live TV
    void load();
    return poll(load, 30_000);
  });

  const GROUP_ICON: Record<CheckGroup, string> = { core: 'hard-drive', signin: 'key', media: 'film', livetv: 'tv', updates: 'refresh', proxy: 'globe' };
  const IDS_OF = Object.fromEntries(CHECK_GROUPS.map((g) => [g, CHECK_IDS.filter((id) => id.startsWith(`${g}.`))])) as Record<CheckGroup, CheckId[]>;
  /** problems first: the order the counts are read in (all five always, so nothing shifts; a zero is neutral, never red) */
  const COUNT_ORDER: CheckStatus[] = ['problem', 'warning', 'ok', 'not_set_up', 'unknown'];

  // a failed first load still shows every line ("nicht geprüft"), so the page keeps its shape
  // without Live TV the upload line is decided with the server's answer (nothing is sent), so it never changes height later
  $: uploadOff = livetvOf(result) === false ? [uploadNotSetUp()] : [];
  $: merged = result || failed ? mergeLines(result?.lines ?? [], [...uploadOff, ...browserLines]) : null;
  $: lines = merged ? new Map(merged.map((l) => [l.id, l])) : null;
  // the pills count what the list shows: the server's lines, the browser lines and the lines without a result yet ("nicht geprüft");
  // the overview summary reads the server counts only
  $: counts = result && merged ? countLines(merged.map((l) => (l.placeholder ? { ...l, placeholder: undefined } : l))) : null;
</script>

<section id="systemcheck" class="sc" aria-labelledby="sc-title">
  <div class="sh">
    <h2 id="sc-title">{$t('syscheck.title')}</h2>
    <!-- both texts take the same cell (the longer one sets its width), so switching to "Stand von …" never moves the header -->
    <span class="at muted small">{#if result}<span class:off={stale}>{atText(result.at, false, $t)}</span><span class="stale" class:off={!stale}><Icon name="clock" size={13} />{atText(result.at, true, $t)}</span>{:else}<Skeleton w="7.5rem" h=".85rem" inline />{/if}</span>
    <span class="sp"></span>
    <Button variant="secondary" icon="refresh" pending={checking} on:click={checkNow}>{$t('syscheck.checkNow')}</Button>
  </div>
  <p class="intro muted small">{$t('syscheck.intro')}</p>

  <ul class="counts">
    {#each COUNT_ORDER as s (s)}
      <li>{#if counts}<StatusPill tone={counts[s] ? statusTone(s) : 'muted'} icon={statusIcon(s)} label={$t(`syscheck.count.${s}` as TKey, { n: counts[s] })} />{:else}<Skeleton w="7rem" h="1.4rem" radius="99px" />{/if}</li>
    {/each}
  </ul>

  {#if failed && !result}
    <div class="state" role="alert"><Icon name="alert" size={20} /><p>{$t('syscheck.loadFailed')}</p><Button variant="secondary" icon="refresh" pending={retrying} on:click={retry}>{$t('ui.retry')}</Button></div>
  {/if}

  <div class="groups">
    {#each CHECK_GROUPS as g (g)}
      <div class="grp frost-flat" role="group" aria-labelledby="sc-g-{g}">
        <h3 id="sc-g-{g}"><span class="gi" aria-hidden="true"><Icon name={GROUP_ICON[g]} size={16} /></span>{$t(`syscheck.group.${g}`)}</h3>
        <ul class="lines" aria-hidden={lines ? undefined : 'true'}>
          {#each IDS_OF[g] as id (id)}
            {@const l = lines?.get(id) ?? null}
            <li data-id={id} data-status={l && !l.placeholder ? l.status : undefined}><CheckLine line={l} {id} {browserRunning} on:refresh={checkNow} /></li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
  <p class="sr-only" role="status">{announce}</p>
</section>

<style>
  .sc { margin-bottom: 1.4rem; scroll-margin-top: 5rem; }
  h2 { font-size: 1.05rem; font-weight: 700; margin: 0; }
  .sh { display: flex; align-items: center; gap: .5rem 1rem; flex-wrap: wrap; margin-bottom: .3rem; }
  .sp { flex: 1; }
  .small { font-size: .85rem; }
  .at { font-variant-numeric: tabular-nums; min-width: 7.5rem; display: inline-grid; }
  .at > :global(*) { grid-area: 1 / 1; }
  .at > .off { visibility: hidden; }
  .stale { display: inline-flex; align-items: center; gap: .3rem; color: var(--warn); }
  .intro { margin: 0 0 .7rem; }
  /* a fixed column grid: the pills and their skeletons take the same rows at every width */
  .counts { list-style: none; margin: 0 0 .9rem; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: .4rem .6rem; }
  .counts li { display: flex; min-width: 0; min-height: 1.6rem; align-items: center; }
  .state { display: flex; align-items: center; gap: .6rem 1rem; flex-wrap: wrap; padding: .8rem 1rem; margin-bottom: .9rem; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); }
  .state p { margin: 0; flex: 1; min-width: 12rem; }
  .state :global(svg) { color: var(--err); }
  .groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: .8rem; align-items: start; }
  .grp { padding: .7rem 1rem .3rem; border-radius: 16px; min-width: 0; }
  h3 { display: flex; align-items: center; gap: .5rem; font-size: .95rem; font-weight: 700; margin: 0 0 .2rem; }
  .gi { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,.08); flex: none; }
  .lines { list-style: none; margin: 0; padding: 0; }
  .lines li + li { border-top: 1px solid rgba(255,255,255,.06); }
</style>
