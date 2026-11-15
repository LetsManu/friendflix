<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Update: version card, update channel (stable / nightly / fixed version, the .env line to switch), check, update with
   * confirm + progress steps (Portainer redeploy), changelog. Without the updater (compose.no-updater.yaml) the channel switch only saves
   * UPDATE_CHANNEL (the images follow FF_TAG); with it (GET /api/admin/updater answers present) the updater card replaces the
   * Portainer card and installs the selected channel itself (UpdaterCard.svelte). The backend never touches Docker.
   * Without an updater the redeploy is followed from the backend's record (GET /api/admin/updater `redeploy`, backend redeploy.ts),
   * the same one the updater card follows: no page-only state, so a reload mid-update resumes it, and it ends as the backend
   * judged it (done, unchanged, failed with the step, timeout after 15 minutes).
   */
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, hasKey, t, tr, trDynamic } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import { saveSettings } from '#lib/admin/settings/api';
  import { CHANNELS, VERSION_RE, pullCommand, envLineFor, isUpToDate, showSnippet, snippetReason, stepChannel, switching, updateTarget, type ChannelInfo, type SelectedChannel } from '#lib/admin/updateChannel';
  import { mergeView, portainerMissing, redeployRunning, statusOf, type UpdaterView } from '#lib/admin/updater';
  import UpdaterCard from '#lib/admin/UpdaterCard.svelte';
  import Halo from '#lib/admin/Halo.svelte';
  import StepList from '#lib/admin/StepList.svelte';
  import { redeployFlow } from '#lib/admin/steps';
  import { watcher } from '#lib/admin/watch';
  import Field from '#lib/ui/Field.svelte';
  import CopyField from '#lib/ui/CopyField.svelte';
  import { toast } from '#lib/ui/toast';
  import { confirm } from '#lib/ui/confirm';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import type { Column } from '#lib/ui/table';
  import VersionEgg from '#lib/version/VersionEgg.svelte';
  import { parseNotes } from '#lib/version/notes';
  import { serverKind } from '#lib/capabilities';

  interface Commit { sha: string; url: string; message: string; author: string; date: string }
  interface Release { version: string; codename: string | null; tag: string; name: string; url: string; publishedAt: string | null; notes: string }
  interface Info {
    current: { sha: string; builtAt?: string | null; version?: string; codename?: string };
    /** newest GitHub release (primary comparison); null before the first release */
    release?: Release | null;
    updateAvailable?: boolean | null;
    latest?: { sha: string; date?: string | null; runUrl?: string } | null;
    behind?: number | null;
    error?: string;
    /** missing: the Portainer API settings still missing when it is set up only in part (older backends send none) */
    portainer: { configured: boolean; missing?: string[] };
    commits: Commit[];
    /** older backends send no channel */
    channel?: ChannelInfo;
  }

  /** hint for a network error code / name of the failed Portainer step (undefined when unknown) */
  const hint = (code: string) => (hasKey(`admin.update.hint.${code}`) ? trDynamic(`admin.update.hint.${code}`) : undefined);
  const step = (s: string) => (hasKey(`admin.update.step.${s}`) ? trDynamic(`admin.update.step.${s}`) : s);
  /** error text for a failed update request */
  function updateError(e: any): string {
    if (e?.status === 429) return tr('admin.update.tooSoon');
    if (e?.body?.error === 'busy') return tr('admin.update.updater.error.busy'); // a redeploy is already running
    if (e?.status === 409) return tr('admin.update.notConfigured');
    if (e?.body?.error === 'webhook_gone') return tr('admin.update.webhookGone'); // a stale webhook address (404): never the URL
    if (e?.body?.error === 'portainer_unreachable') {
      const code = e.body?.code, h = code ? hint(code) : undefined;
      return tr('admin.update.unreachable', { detail: code ? ` (${code}${h ? `: ${h}` : ''})` : '' });
    }
    if (e?.status && e.status < 500 && e.status !== 502) return errorText(e);
    return tr('admin.update.portainerError', { detail: (e?.body?.status ? tr('admin.update.httpDetail', { status: String(e.body.status) }) : '') + (e?.body?.step ? tr('admin.update.atStep', { step: step(e.body.step) }) : '') });
  }

  let u: Info | null = null, loadErr = false;
  let force = false;
  let now = Date.now();
  const sha7 = (s: string) => s.slice(0, 7);
  const dt = (d?: string | null) => (d ? fmtDateTime(d) : tr('admin.update.unknown'));
  /** release-based when a release exists, else the commit comparison with main (older backends send no release fields) */
  $: byRelease = u?.updateAvailable === true || u?.updateAvailable === false;
  $: upToDate = u ? isUpToDate(u) : false;
  $: sel = u?.channel?.selected ?? 'stable';
  $: nightly = sel === 'nightly';
  $: notes = u?.release?.notes && !nightly ? parseNotes(u.release.notes) : [];
  /** the updater answers: it installs the channel itself, no .env line needed */
  let up: UpdaterView | null = null;
  $: updater = statusOf(up) !== null;
  $: snippet = u && !updater ? showSnippet(u) : false;
  /** the fixed-version form: open while "Fixed version" is selected, or picked without a saved version yet */
  let pinOpen = false, pinDraft = '', pinErr = '';
  $: pinShown = sel === 'pinned' || pinOpen;
  /** a save in flight ignores further picks; the buttons stay enabled so arrow-key focus is never lost */
  let savingChannel = false;
  let segBtns: Record<string, HTMLButtonElement> = {};
  const channelName = (c: SelectedChannel) => tr(c === 'nightly' ? 'admin.update.channel.nightly' : c === 'pinned' ? 'admin.update.channel.pinned' : 'admin.update.channel.stable');
  const channelHint = (c: SelectedChannel) => tr(c === 'nightly' ? 'admin.update.channel.nightlyHint' : c === 'pinned' ? 'admin.update.channel.pinnedHint' : 'admin.update.channel.stableHint');
  function runningText(ch: ChannelInfo, cur: Info['current']): string {
    if (ch.build === 'dev') return tr('admin.update.channel.runningDev');
    if (ch.running === 'stable') return tr('admin.update.channel.runningStable', { version: cur.version ?? '' });
    if (ch.running === 'nightly') return tr('admin.update.channel.runningNightly', { sha: sha7(cur.sha) });
    return tr('admin.update.channel.runningUnknown');
  }
  /** saves UPDATE_CHANNEL (same store, audit and environment lock as Admin → Settings), then re-reads the comparison */
  async function pick(c: SelectedChannel, version?: string) {
    if (!u?.channel || u.channel.locked || savingChannel) return;
    if (c === u.channel.selected && (c !== 'pinned' || !version || version === u.channel.version)) return;
    pinOpen = c === 'pinned';
    // a fixed version needs its number first: the form opens, nothing is saved yet
    const v = c === 'pinned' ? (version ?? u.channel.version ?? null) : null;
    if (c === 'pinned' && !v) { pinDraft ||= u.current.version ?? ''; return; }
    const before = u.channel;
    savingChannel = true;
    try {
      await saveSettings(c === 'pinned' ? { UPDATE_CHANNEL: c, UPDATE_VERSION: v } : { UPDATE_CHANNEL: c });
      u = { ...u, channel: { ...before, selected: c, version: v, envLine: envLineFor(c, v) } };
      toast.success(tr('admin.update.channel.saved', { channel: c === 'pinned' ? `${channelName(c)} ${v}` : channelName(c) }));
      try { u = await api<Info>('/api/admin/update'); } catch { /* the saved selection stays shown */ }
      // the backend hands the channel to the updater: show its new target
      if (up?.present) setTimeout(() => { void loadUpdater(); }, 600);
    } catch (e) {
      toast.error(errorText(e));
    }
    savingChannel = false;
  }
  function savePin() {
    pinErr = '';
    const v = pinDraft.trim();
    if (!VERSION_RE.test(v)) { pinErr = tr('admin.update.channel.versionInvalid'); return; }
    void pick('pinned', v);
  }
  async function loadUpdater(): Promise<boolean> {
    try {
      const next = await api<UpdaterView>('/api/admin/updater');
      up = up ? mergeView(up, next).view : next;
      return true;
    } catch { up = up ?? { present: false }; return false; }
  }
  /** the page's own follow (no updater card): a failed poll is the backend restarting, "reconnecting"; the end reloads the version */
  const w = watcher({
    poll: loadUpdater,
    busy: () => Boolean(up && !up.present && redeployRunning(up)),
    tick: (ok) => { now = Date.now(); reconnecting = !ok; },
    done: () => { reconnecting = false; void load(); },
    timeout: () => { reconnecting = false; watchTimeout = true; },
  });
  function follow() { watchTimeout = false; if (up && !up.present && redeployRunning(up)) w.start(); }
  function segKey(e: KeyboardEvent) {
    const next = stepChannel(sel, e.key);
    if (!next) return;
    e.preventDefault();
    segBtns[next]?.focus();
    void pick(next);
  }
  const verLabel = (v: string, c?: string | null) => (c ? `${v} · ${c}` : v);
  $: busy = $busyKeys.has('update:check') || $busyKeys.has('update:start');
  /** without an updater: the last redeploy from the backend's record, followed while it runs */
  $: redeploy = up && !up.present ? (up.redeploy ?? null) : null;
  $: running = Boolean(redeploy?.running);
  let reconnecting = false, watchTimeout = false;
  $: flow = redeploy ? (void $t, redeployFlow(redeploy, { reconnecting, now })) : null;

  async function load() {
    loadErr = false;
    const upd = loadUpdater();
    try { u = await api<Info>('/api/admin/update'); } catch { loadErr = true; }
    await upd;
    pinDraft = u?.channel?.version ?? pinDraft;
    // a redeploy found running (a reload mid-update): followed without a click
    if (!w.running) follow();
  }
  function check() {
    void runAction({
      key: 'update:check', run: () => api<Info>('/api/admin/update?refresh=1'),
      success: (r) => (r?.updateAvailable ? (r.channel?.selected === 'nightly' && r.behind ? tr('admin.update.behind', { n: r.behind }) : tr('admin.update.updateAvailable'))
        : r?.updateAvailable === false || r?.behind === 0 ? tr('adminContent.update.checkedUpToDate')
          : r?.behind ? tr('admin.update.behind', { n: r.behind }) : tr('adminContent.update.checked')),
    }).then((res) => { if (res.ok && res.value) u = res.value; });
  }

  async function start() {
    if (!u || !(await confirm({ title: tr('admin.update.confirm'), body: tr('adminContent.update.confirmBody', { sha: updateTarget(u) }), danger: true, confirmLabel: tr('admin.update.updateNow') }))) return;
    const res = await runAction({
      key: 'update:start', run: () => api('/api/admin/update', { method: 'POST' }), error: updateError,
    });
    // started, or refused by Portainer (recorded too, with the step): the backend's record says which
    if (res.ok || (res.error as { status?: number } | undefined)?.status === 502) {
      await loadUpdater();
      follow();
    }
  }
  onMount(() => {
    void load();
  });
  onDestroy(w.stop);
  const clock = setInterval(() => { if (w.running) now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(clock));

  $: commitCols = [
    { key: 'message', label: $t('adminContent.update.commit'), value: (c) => c.message, primary: true, sortable: false },
    { key: 'author', label: $t('adminContent.update.author'), value: (c) => c.author, sortable: false },
    { key: 'date', label: $t('adminContent.update.date'), value: (c) => c.date, sortable: false },
  ] as Column<Commit>[];
</script>

<p class="intro muted">{$t('admin.update.intro')}</p>

{#if loadErr}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.update.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
{:else if !u}
  <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="40%" h="1.3rem" /><Skeleton w="60%" h="1rem" /><Skeleton w="10rem" h="2.6rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
{:else}
  <AdminCard title={$t('adminContent.update.versionTitle')}>
    <svelte:fragment slot="actions">
      <Button variant="secondary" icon="refresh" pending={$busyKeys.has('update:check')} disabled={running || $busyKeys.has('update:start')} on:click={check}>{$t('admin.update.check')}</Button>
    </svelte:fragment>
    <dl class="ver">
      <div><dt>{$t('admin.update.installed')}</dt><dd>
        {#if u.current.version}<span class="v"><VersionEgg version={u.current.version} codename={u.current.codename ?? ''} label={u.channel?.build === 'nightly' ? u.channel.label : verLabel(u.current.version, u.current.codename)} /></span>
          <span class="muted">{$t('admin.update.buildSha', { sha: sha7(u.current.sha) })}</span>
        {:else}<code>{sha7(u.current.sha)}</code>{/if}
        <span class="muted">{$t('admin.update.builtAt', { date: dt(u.current.builtAt) })}</span></dd></div>
      {#if u.release}
        <div><dt>{$t('admin.update.latestRelease')}</dt><dd><span class="v">{verLabel(u.release.version, u.release.codename)}</span>{#if u.release.publishedAt} <span class="muted">{$t('admin.update.builtAt', { date: dt(u.release.publishedAt) })}</span>{/if}{#if u.release.url}<span aria-hidden="true"> · </span><a href={u.release.url} target="_blank" rel="noopener">{$t('admin.update.releaseLink')}</a>{/if}</dd></div>
      {/if}
      {#if u.latest}
        <div><dt>{$t('admin.update.latest')}</dt><dd>{#if nightly}<span class="v">{$t('admin.update.channel.nightlyBuild', { sha: sha7(u.latest.sha) })}</span>{:else}<code>{sha7(u.latest.sha)}</code>{/if} <span class="muted">{$t('admin.update.builtAt', { date: dt(u.latest.date) })}</span>{#if u.latest.runUrl}<span aria-hidden="true"> · </span><a href={u.latest.runUrl} target="_blank" rel="noopener">{$t('admin.update.ciRun')}</a>{/if}</dd></div>
      {/if}
      <div><dt>{$t('adminContent.update.state')}</dt><dd>
        {#if u.updateAvailable && nightly && u.behind}<StatusPill tone="warn" icon="download" label={$t('admin.update.behind', { n: u.behind })} />
        {:else if u.updateAvailable}<StatusPill tone="warn" icon="download" label={$t('admin.update.updateAvailable')} />
        {:else if u.updateAvailable === false}<StatusPill tone="ok" label={$t('admin.update.upToDate')} />
        {:else if !u.latest}<StatusPill tone="muted" label={$t('admin.update.unknownState')} />
        {:else if upToDate}<StatusPill tone="ok" label={$t('admin.update.upToDate')} />
        {:else if u.behind}<StatusPill tone="warn" icon="download" label={$t('admin.update.behind', { n: u.behind })} />
        {:else}<StatusPill tone="muted" label={$t('admin.update.unknownState')} />{/if}
      </dd></div>
    </dl>
    {#if byRelease && u.behind && !nightly}<p class="muted small">{$t('admin.update.mainAhead', { n: u.behind })}</p>{/if}
    {#if !u.release && !u.error && u.latest}<p class="muted small">{$t('admin.update.noRelease')}</p>{/if}
    {#if !u.latest && !u.release}<p class="err small" role="alert">{$t('admin.update.latestFailed', { error: u.error ?? $t('admin.update.unknown') })}</p>{/if}
    {#if u.release && notes.length}
      <details class="notes">
        <summary>{$t('admin.update.whatsNew', { version: verLabel(u.release.version, u.release.codename) })}</summary>
        <div class="md">
          {#each notes as b, i (i)}
            {#if b.kind === 'h'}<h3>{b.text}</h3>
            {:else if b.kind === 'ul'}<ul>{#each b.items as it, j (j)}<li>{it}</li>{/each}</ul>
            {:else}<p>{b.text}</p>{/if}
          {/each}
        </div>
      </details>
    {/if}
    {#if u.current.sha === 'dev'}<p class="muted small">{$t('admin.update.devBuild')}</p>{/if}
  </AdminCard>

  {#if u.channel}
    <AdminCard title={$t('admin.update.channel.title')}>
      <dl class="ver">
        <div><dt>{$t('admin.update.channel.running')}</dt><dd data-running={u.channel.running ?? u.channel.build ?? 'unknown'}>{runningText(u.channel, u.current)}</dd></div>
      </dl>
      <div class="seg" role="radiogroup" aria-label={$t('admin.update.channel.label')}>
        {#each CHANNELS as c (c)}
          <button type="button" role="radio" bind:this={segBtns[c]} aria-checked={sel === c} tabindex={sel === c ? 0 : -1} class:on={sel === c}
            disabled={u.channel.locked} aria-busy={savingChannel && sel !== c ? 'true' : undefined} on:click={() => pick(c)} on:keydown={segKey}>{channelName(c)}</button>
        {/each}
      </div>
      <p class="muted small">{channelHint(pinOpen ? 'pinned' : sel)}</p>
      {#if pinShown && !u.channel.locked}
        <form class="pin" on:submit|preventDefault={savePin}>
          <Field label={$t('admin.update.channel.versionLabel')} bind:value={pinDraft} placeholder="1.2.3" maxlength={14} width="9rem" error={pinErr} />
          <Button type="submit" variant="secondary" pending={savingChannel}>{$t('admin.update.channel.versionSave')}</Button>
        </form>
      {/if}
      {#if u.channel.locked}<p class="muted small" role="note">{$t('admin.update.channel.locked')}</p>{/if}
      {#if updater}<p class="muted small" role="note" data-updater-note>{$t('admin.update.channel.updaterNote', { tag: u.channel.envLine.slice('FF_TAG='.length) })}</p>{/if}
      {#if updater && u.channel.selected !== 'pinned' && u.channel.running && switching(u)}<p class="small pending" role="status" data-pending-switch>{$t('admin.update.channel.pendingSwitch', { channel: channelName(u.channel.selected), running: channelName(u.channel.running) })}</p>{/if}
      {#if snippet}
        <div class="snippet" data-snippet>
          <p class="lead">{snippetReason(u) === 'switch' ? $t('admin.update.channel.switchLead', { channel: channelName(sel) }) : $t('admin.update.channel.updateLead')}</p>
          <CopyField label={$t('admin.update.channel.envLabel')} value={u.channel.envLine} />
          <CopyField label={$t('admin.update.channel.cmdLabel')} value={pullCommand($serverKind)} />
          <p class="muted small">{$t('admin.update.channel.note')}</p>
        </div>
      {/if}
    </AdminCard>
  {/if}

  {#if up?.present}
    <UpdaterCard view={up} on:finished={() => { void load(); }} />
  {:else}
  <AdminCard title={$t('adminContent.update.applyTitle')}>
    {#if !u.portainer.configured}
      {#if u.portainer.missing?.length}<p class="err small" role="alert" data-portainer-missing>{(void $t, portainerMissing(u.portainer))}</p>{/if}
      <p class="muted"><Rich text={$t('admin.update.setup')} /></p>
    {:else}
      <div class="apply">
        <Halo live={running}><Button icon="download" pending={$busyKeys.has('update:start') || running} disabled={running || busy || (upToDate && !force)} on:click={start}>{$t('admin.update.updateNow')}</Button></Halo>
        {#if upToDate}<Toggle label={$t('admin.update.force')} bind:checked={force} disabled={running} />{/if}
      </div>
    {/if}

    {#if flow && redeploy}
      <div class="prog" data-redeploy={redeploy.phase}>
        {#key redeploy.id}<StepList {flow} title={$t('admin.update.updater.redeploy.title')} on:retry={start} />{/key}
        {#if watchTimeout}<p class="err small" role="alert">{$t('admin.update.updater.watchTimeout')}</p>{/if}
      </div>
    {/if}
  </AdminCard>
  {/if}

  {#if u.commits.length}
    <AdminCard title={$t('admin.update.changes')}>
      <DataTable caption={$t('admin.update.changes')} rows={u.commits} columns={commitCols} key={(c) => c.sha} pageSize={10}>
        <svelte:fragment slot="cell" let:row let:col>
          {#if col.key === 'message'}<a href={row.url} target="_blank" rel="noopener">{row.message}</a>
          {:else if col.key === 'date'}<time datetime={row.date} title={fmtDateTime(row.date)}>{fmtRelative(row.date)}</time>
          {:else}{col.value?.(row) ?? ''}{/if}
        </svelte:fragment>
      </DataTable>
    </AdminCard>
  {/if}
{/if}

<style>
  .intro { margin: 0 0 1rem; max-width: 70ch; }
  .ver { margin: 0; display: grid; gap: .7rem; }
  .ver > div { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: .6rem; align-items: center; }
  dt { color: var(--mut); font-size: .9rem; } dd { margin: 0; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,.07); padding: .05rem .4rem; border-radius: 4px; }
  dd a, :global(td) a { color: var(--info); } dd a:hover, :global(td) a:hover { text-decoration: underline; }
  .small { font-size: .88rem; margin: .8rem 0 0; }
  .pending { color: var(--warn, #f5b942); }
  .apply { display: flex; align-items: center; gap: 1.2rem; flex-wrap: wrap; }
  .prog { margin-top: 1.2rem; display: grid; gap: .8rem; max-width: 40rem; min-width: 0; }
  .err { color: var(--err); }
  .sk { display: grid; gap: .8rem; }
  .v { font-weight: 600; }
  .notes { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: .8rem; }
  .notes summary { cursor: pointer; font-weight: 600; min-height: 44px; display: flex; align-items: center; }
  .md { max-width: 70ch; } .md h3 { font-size: 1rem; margin: 1rem 0 .3rem; } .md ul { margin: 0; padding-left: 1.2rem; } .md li { margin: .25rem 0; } .md p { margin: .4rem 0; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
  time { color: var(--mut); white-space: nowrap; font-size: .9rem; }
  .seg { display: inline-flex; margin-top: 1rem; border: 1px solid var(--line); border-radius: 999px; padding: 3px; gap: 3px; max-width: 100%; }
  .seg button { min-height: 44px; min-width: 0; padding: .3rem 1.1rem; border-radius: 999px; background: transparent; border: 0; color: var(--mut); font-weight: 600; }
  .seg button.on { background: var(--fg); color: var(--bg, #101418); }
  .seg button:not(.on):hover:not(:disabled) { color: var(--fg); background: rgba(255,255,255,.07); }
  .seg button:disabled { cursor: not-allowed; opacity: .7; }
  .snippet { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: .9rem; display: grid; gap: .8rem; min-width: 0; max-width: 40rem; }
  .snippet .lead { margin: 0; }
  .snippet .small { margin: 0; }
  .pin { display: flex; flex-wrap: wrap; gap: .8rem; align-items: flex-end; margin-top: .8rem; }
  @media (max-width: 560px) { .ver > div { grid-template-columns: minmax(0, 1fr); gap: .2rem; } }
</style>
