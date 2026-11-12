<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The casting section of /diagnose (spec §6): the test video, one card for Chromecast and one for AirPlay, the on-device event
   * log and the copyable report. Self-contained (it reads `castSession` / `castState` and the stores on this device, nothing else
   * of the page), so it can sit above any other Diagnose section. Nothing here is uploaded; the report holds no token, URL, id
   * or address and anonymises every TV name (castLog.ts).
   */
  import { onMount } from 'svelte';
  import { api, cachedItem } from '#lib/api';
  import { serverCaps } from '#lib/capabilities';
  import { castCapableBrowser, castConfigEnabled, castCustomReceiver, castState, castTestClip, initCast, requestCastSession, whenCastReady } from '#lib/cast';
  import Icon from '#lib/Icon.svelte';
  import { perms } from '#lib/perms';
  import { fmtTime, t } from '#lib/i18n';
  import { airLogStart, formatAirLog, readAirLog } from '#lib/player/airplayLog';
  import { castLogDevices, castReport, clearCastLog, eventsText, readCastLog, type CastLogEntry } from './castLog';
  import { airplayRows, chromecastRows, lastAirSession, reportRows, resultLine, type DiagRow } from './diagnose';
  import { CAST_LOCK, castSession } from './engine';
  import { lastDevice, readHint, type CastLookup } from './resume';

  const CLIP = '/cast-test/clip.mp4';

  let capable = false, enabled = false, custom = false, ready = false, airAvailable = false;
  let otherTab = false;
  let now = Date.now();
  let entries: CastLogEntry[] = [];
  let lookup: CastLookup | null = null;
  let busy = false;
  let result: { ok: boolean; text: string } | null = null;
  let note = '', eventsNote = '';
  // one always-mounted live region: running, then the result, then "copied" (a region that mounts with its text is not announced)
  $: status = busy ? { ok: null as boolean | null, text: $t('diagnose.cast.testRunning') } : note ? { ok: null, text: note } : result ?? { ok: null, text: '' };
  let eventsEl: HTMLElement;

  const store = (): Storage | null => { try { return localStorage; } catch { return null; } };

  // the token-free lookup of the live session (pass validity, refused fetches); one request per castId
  let looked = '';
  $: void lookFor($castSession?.castId ?? '');
  async function lookFor(id: string) {
    if (id === looked) return;
    looked = id;
    lookup = null;
    if (!/^[0-9a-f]{32}$/.test(id)) return;
    try {
      const l = await api<CastLookup>(`/api/cast/session/${id}`);
      if (looked === id) lookup = l;
    } catch { /* not ours (any more) or offline: the rows show a dash */ }
  }

  const read = () => { entries = readCastLog(store()); now = Date.now(); };
  /** another tab of this browser holds the cast lock: it controls the cast, this tab shows nothing of it */
  async function checkLock() {
    try {
      const q = await navigator.locks?.query();
      otherTab = (q?.held ?? []).some((l) => l.name === CAST_LOCK);
    } catch { otherTab = false; }
  }

  onMount(() => {
    capable = castCapableBrowser();
    airAvailable = typeof HTMLMediaElement !== 'undefined' && typeof (HTMLMediaElement.prototype as { webkitShowPlaybackTargetPicker?: unknown }).webkitShowPlaybackTargetPicker === 'function';
    read();
    void checkLock();
    mounted = true;
    const id = setInterval(() => { read(); void checkLock(); }, 2000);
    return () => clearInterval(id);
  });

  // the Chromecast check starts once the cast right is there (it may arrive after mount: a stale boot hint denied it)
  let mounted = false, checked = false;
  $: if (mounted && capable && $perms.cast && !checked) {
    checked = true;
    void castConfigEnabled().then((on) => { enabled = on; custom = castCustomReceiver(); if (on) { void initCast(); whenCastReady(() => { ready = true; }); } }).catch(() => undefined);
  }

  $: air = lastAirSession(entries);
  // receiver errors of this session: after the last entry that started, resumed or adopted one
  $: errors = entries.slice(entries.findLastIndex((e) => e.tag === 'session' && /^session (started|resumed|adopted|found)/.test(e.text)) + 1).filter((e) => e.tag === 'receiver' && e.level === 'error').length;
  $: cc = chromecastRows({
    capable, allowed: $perms.cast, enabled, custom, state: $castState, session: $castSession,
    lookup: $castSession?.kind === 'chromecast' ? lookup : null, errors, now, tf: $t, otherTab: otherTab && !$castSession, item: $castSession ? cachedItem($castSession.itemId) : null,
  });
  $: ap = airplayRows({ available: airAvailable, continuous: null, allowed: $perms.cast, subsInStream: $serverCaps.castHlsSubtitles, last: air, lookup: $castSession?.kind === 'airplay' ? lookup : null, pinned: lookup?.pinFamily, tf: $t });

  $: castBusy = $castSession !== null || otherTab;
  $: canTest = capable && enabled && ready && !busy && !castBusy;

  async function sendTest() {
    if (!canTest) return;
    busy = true;
    result = null;
    note = '';
    try {
      const had = $castState.connected;
      if (!had && !(await requestCastSession())) return; // the picker was dismissed
      const device = $castState.deviceName;
      const r = await castTestClip(CLIP, 'FriendFlix test', { endAfter: !had });
      result = resultLine(r, device, $t);
    } finally {
      busy = false;
      read();
    }
  }

  const anonymised = () => {
    const s = store();
    const names = [$castState.deviceName, $castSession?.device ?? '', readHint(s, Date.now())?.device ?? '', lastDevice(s) ?? '', ...castLogDevices(s)];
    return names.filter(Boolean);
  };
  const withCard = (card: string, rows: DiagRow[]): Array<[string, string]> => reportRows(rows).map(([k, v]) => [`${card} · ${k}`, v]);
  async function copyText(text: string, set: (s: string) => void, el: HTMLElement | undefined) {
    try {
      await navigator.clipboard.writeText(text);
      set($t('diagnose.copied'));
    } catch {
      if (el) {
        const sel = window.getSelection(), range = document.createRange();
        range.selectNodeContents(el);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      set($t('diagnose.copyFailed'));
    }
  }
  function copyReport() {
    read();
    return copyText(castReport({ rows: [...withCard('Chromecast', cc), ...withCard('AirPlay', ap)], entries, air: formatAirLog(readAirLog(), airLogStart()), devices: anonymised() }), (s) => (note = s), eventsEl);
  }
  const copyEvents = () => copyText(eventsText(entries, anonymised()), (s) => (eventsNote = s), eventsEl);
  function clearEvents() { clearCastLog(store()); read(); eventsNote = ''; }

  // explicit table roles: on a phone the rows are laid out as flex boxes, which drops the native table semantics in WebKit
  const ROLE = { table: { role: 'table' }, group: { role: 'rowgroup' }, row: { role: 'row' }, cell: { role: 'cell' }, head: { role: 'columnheader' } } as const;
  const icon = (tone: DiagRow['tone']) => (tone === 'ok' ? 'check' : tone === 'warn' ? 'alert' : tone === 'error' ? 'x' : '');
  const levelIcon = { info: 'info', warn: 'alert', error: 'x' } as const;
</script>

<section class="cast" aria-labelledby="dc-h" data-testid="diagnose-cast">
  <div class="head">
    <h2 id="dc-h">{$t('diagnose.cast.title')}</h2>
    <div class="acts">
      <button type="button" class="frost-btn" disabled={!canTest} aria-describedby={castBusy ? 'dc-busy' : undefined} on:click={sendTest}>
        <Icon name="tv" size={20} />{$t('diagnose.cast.sendTest')}
      </button>
      <button type="button" class="light" on:click={copyReport}>{$t('diagnose.cast.copyReport')}</button>
    </div>
  </div>
  {#if castBusy}<p class="hint" id="dc-busy">{$t('diagnose.cast.testBusy')}</p>{/if}
  <p class="line" class:okl={status.ok === true} class:errl={status.ok === false} role="status" aria-live="polite" data-testid="cast-status">
    {#if status.text}<Icon name={status.ok === true ? 'check' : status.ok === false ? 'x' : 'info'} size={18} /><span data-testid={result && status.text === result.text ? 'cast-test-result' : undefined}>{status.text}</span>{/if}
  </p>

  <div class="cards">
    {#each [{ id: 'cc', name: 'Chromecast', rows: cc }, { id: 'ap', name: 'AirPlay', rows: ap }] as card (card.id)}
      <div class="panel card" role="group" aria-labelledby="dc-{card.id}">
        <h3 id="dc-{card.id}">{card.name}</h3>
        <dl data-testid="diagnose-cast-{card.id}">
          {#each card.rows as r (r.label)}
            <div class="r">
              <dt>{r.label}</dt>
              <dd class:okv={r.tone === 'ok'} class:warnv={r.tone === 'warn'} class:errv={r.tone === 'error'}>
                {#if icon(r.tone)}<Icon name={icon(r.tone)} size={16} />{/if}<span>{r.value}</span>
              </dd>
            </div>
          {/each}
        </dl>
      </div>
    {/each}
  </div>

  <div class="panel events">
    <div class="head sub">
      <div>
        <h3 id="dc-ev">{$t('diagnose.cast.events')}</h3>
        <p class="hint">{$t('diagnose.cast.eventsHint')}</p>
      </div>
      <div class="acts">
        <button type="button" class="light" aria-label={$t('diagnose.cast.copyEvents')} on:click={copyEvents} disabled={!entries.length}>{$t('diagnose.airplayCopy')}</button>
        <button type="button" class="sec" aria-label={$t('diagnose.cast.clearEvents')} on:click={clearEvents} disabled={!entries.length}>{$t('diagnose.airplayClear')}</button>
        <span class="note" role="status" aria-live="polite">{eventsNote}</span>
      </div>
    </div>
    {#if entries.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable by keyboard) -->
      <div class="evwrap" bind:this={eventsEl} role="region" aria-labelledby="dc-ev" tabindex="0">
        <table data-testid="cast-events" {...ROLE.table}>
          <thead {...ROLE.group}><tr {...ROLE.row}><th scope="col" {...ROLE.head}>{$t('diagnose.cast.colTime')}</th><th scope="col" {...ROLE.head}>{$t('diagnose.cast.colLevel')}</th><th scope="col" {...ROLE.head}>{$t('diagnose.cast.colTag')}</th><th scope="col" {...ROLE.head}>{$t('diagnose.cast.colText')}</th></tr></thead>
          <tbody {...ROLE.group}>
            {#each [...entries].reverse() as e, i (entries.length - i)}
              <tr {...ROLE.row}>
                <td class="tm" {...ROLE.cell}>{fmtTime(e.at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                <td class="lv {e.level}" {...ROLE.cell}><Icon name={levelIcon[e.level]} size={16} /><span>{$t(`diagnose.cast.${e.level}`)}</span></td>
                <td class="tg" {...ROLE.cell}><span class="tag">{e.tag}</span></td>
                <td class="tx" {...ROLE.cell}>{e.text}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}<p class="hint" data-testid="cast-events-empty">{$t('diagnose.cast.eventsEmpty')}</p>{/if}
  </div>
</section>

<style>
  .cast { margin-bottom: 2.4rem; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: .8rem 1.2rem; flex-wrap: wrap; }
  .head h2 { margin: 0; }
  .acts { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .hint { color: var(--mut); margin: .4rem 0 0; }
  .line { display: flex; align-items: center; gap: .5rem; margin: .8rem 0 0; }
  .okl { color: var(--ok); }
  .errl { color: var(--err); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 1rem; margin-top: 1rem; }
  .card, .events { margin-bottom: 0; }
  .events { margin-top: 1rem; }
  h3 { margin: 0 0 .6rem; font-size: 1.05rem; }
  dl { margin: 0; }
  .r { display: grid; grid-template-columns: minmax(7rem, 38%) 1fr; gap: .2rem .8rem; padding: .55rem 0; border-top: 1px solid rgba(255, 255, 255, .14); }
  .r:first-child { border-top: 0; }
  dt { color: var(--mut); }
  dd { margin: 0; display: flex; gap: .4rem; align-items: flex-start; word-break: break-word; }
  dd :global(svg) { margin-top: 3px; }
  .okv { color: var(--ok); }
  .warnv { color: var(--warn); }
  .errv { color: var(--err); }
  .head.sub { align-items: flex-start; }
  .head.sub h3 { margin-bottom: 0; }
  .note { margin-left: .4rem; }
  .evwrap { margin-top: 1rem; max-height: 420px; overflow: auto; border-radius: 8px; }
  .evwrap:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-weight: 600; color: var(--mut); padding: .35rem .5rem; position: sticky; top: 0; background: rgba(18, 16, 24, .92); }
  td { padding: .4rem .5rem; border-top: 1px solid rgba(255, 255, 255, .12); vertical-align: top; }
  .tm { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .lv { white-space: nowrap; }
  .lv :global(svg) { display: inline-block; vertical-align: -3px; margin-right: .3rem; }
  .lv.warn { color: var(--warn); }
  .lv.error { color: var(--err); }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; background: rgba(255, 255, 255, .12); color: #fff; font-size: 13px; }
  .tx { word-break: break-word; }
  @media (max-width: 640px) {
    .acts { width: 100%; }
    .acts > button { flex: 1 1 auto; }
    .r { grid-template-columns: 1fr; }
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    tr { display: flex; flex-wrap: wrap; gap: 0 .7rem; border-top: 1px solid rgba(255, 255, 255, .12); padding: .35rem 0; }
    td { border-top: 0; padding: .1rem 0; }
    .tx { flex-basis: 100%; }
  }
</style>
