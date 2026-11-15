<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Einstellungen (spec Part I): the settings store by group, the read-only server values, env import, restart banner, live
   * tests. A save sends only the fields that changed (a shown value may be redacted). An action that needs a recent sign-in asks for
   * it in place (lib/account/reauth.ts: the in-app dialog) and then runs exactly that action once more, with everything still typed.
   * For the redirect (no in-app sign-in, or the dialog's passkey / classic link) the change without secrets and the action (save or
   * test, with "Save anyway") are stashed first (form.ts); /auth/reauth comes back with ?resume=1: the change is restored and, when
   * nothing had to be left out, that action runs once more. A repeated action that still needs a sign-in shows an error instead of
   * another round. An edited URL that still carries the backend's redaction
   * marker is refused before anything is sent (it would replace the real token).
   * Tabs (`?tab=`, tabs.ts; *Allgemein* has no parameter): only the active tab's cards render, the drafts are page-level, so a tab
   * switch keeps every unsaved edit and a tab holding one shows a dot. A deep link `?setting=<KEY>` opens the key's tab and highlights
   * its row (highlight.ts), a Live-TV key goes to Admin → Live-TV → Einstellungen, an unknown one opens *Allgemein*; the old
   * `#settings-<group>` links open the group's tab at its card. Either way the address then reads the plain tab.
   * The search above the tabs (search.ts) covers every setting, Live TV's too: while a query is typed its results take the tab panel's
   * place; choosing one clears the query and opens `?setting=<KEY>`; Esc clears. Nothing is edited in the result list.
   * Leaving the page (a Live-TV result or link, the menu) with unsaved drafts asks first; a tab switch or a deep link on this page does not.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { pageStore } from '#lib/page';
  import { leaveGuard, leavesRoute } from '#lib/admin/leaveGuard';
  import Icon from '#lib/Icon.svelte';
  import { isReauthError, reauthenticate } from '#lib/account/reauth';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { fmtList, t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import { refreshSummary } from '#lib/admin/summary';
  import SettingRow from '#lib/admin/settings/SettingRow.svelte';
  import { highlightSetting } from '#lib/admin/settings/highlight';
  import { SEARCH_MIN, searchSettings, type SettingHit } from '#lib/admin/settings/search';
  import { SETTINGS_TABS, TAB_GROUPS, dirtyTabs, tabHref, tabOf, tabOfGroup, tabOfKey, type SettingsTab } from '#lib/admin/settings/tabs';
  import { settingHref } from '#lib/admin/syscheck';
  import {
    fieldErrors, generate, importEnv, loadSettings, PROBE_GROUPS, probeFailure, saveSettings, SOFT_PROBE_CODES, testGroup,
    type ProbeResult, type SettingGroup, type SettingsGroupView, type SettingsView, type SettingView,
  } from '#lib/admin/settings/api';
  import {
    changedValues, clearPending, errorText, groupHelp, keyLabel, livetvLinkShown, moveHint, pageGroups, probeText, redactedKeys, stashPending, takePending, type Draft, type PendingAction,
  } from '#lib/admin/settings/form';

  /** where the classic sign-in comes back to: the group's tab, with the stashed action to repeat */
  const resumeHref = (group: SettingGroup): string => {
    const t = tabOfGroup(group);
    const base = tabHref(t === 'livetv' ? 'general' : t);
    return `${base}${base.includes('?') ? '&' : '?'}resume=1`;
  };

  let view: SettingsView | null = null, loadFailed = false;
  let edits: Record<string, Draft> = {};
  /** per key: the error code of the last save */
  let errors: Record<string, string> = {};
  /** per group: the last probe answer (a refused save or a Test) */
  let probes: Partial<Record<SettingGroup, { result: ProbeResult; save: boolean }>> = {};
  /** keys moved into the settings on this visit (env still wins until it is removed) */
  let moved = new Set<string>();
  /** a generated webhook secret, shown once (in memory only) */
  let generated: Record<string, string> = {};
  let resumeNotice: 'resumed' | 'dropped' | 'failed' | null = null;
  /** the action repeated after a re-authentication runs: another reauth_required is an error, not a new round trip */
  let resuming = false;

  // the livetv group moved to Admin → Live-TV → Einstellungen; the backend lists it only while Live TV is installed, so its presence says that
  $: livetvInstalled = livetvLinkShown(view?.groups ?? []);
  $: groups = pageGroups(view?.groups ?? []) as Array<SettingsGroupView & { id: SettingGroup }>;
  $: server = view?.groups.find((g) => g.id === 'server') ?? null;
  $: envRows = groups.flatMap((g) => g.items).filter((i) => i.source === 'env' && !moved.has(i.key));
  $: changes = Object.fromEntries(groups.map((g) => [g.id, changedValues(g.items, edits)])) as Record<SettingGroup, Record<string, unknown>>;
  $: restartKeys = view?.pendingRestart ?? [];

  const page$ = pageStore();
  $: url = $page$.url;
  /** a deep link still to follow: `?setting=<KEY>`, or an old `#settings-<group>` */
  $: linkKey = url.searchParams.get('setting');
  $: linkGroup = url.hash.startsWith('#settings-') ? url.hash.slice('#settings-'.length) : '';
  /** the tab a deep link opens (shown at once, before the address is tidied up) */
  const linkTab = (v: SettingsView, key: string | null, group: string): SettingsTab => {
    const where = key ? tabOfKey(key, v.groups) : v.groups.some((g) => g.id === group && g.id !== 'server') ? tabOfGroup(group as SettingGroup) : null;
    return where && where !== 'livetv' ? where : 'general';
  };
  $: tab = view && (linkKey || linkGroup) ? linkTab(view, linkKey, linkGroup) : tabOf(url.searchParams.get('tab'));
  $: tabGroups = TAB_GROUPS[tab].flatMap((id) => groups.filter((g) => g.id === id));
  $: dirty = dirtyTabs(changes);
  leaveGuard((nav) => leavesRoute(nav) && dirty.size > 0, () => ({
    title: tr('settings.leave.title'), body: tr('settings.leave.body'), danger: true, confirmLabel: tr('settings.leave.confirm'),
  }));

  const select = (to: SettingsTab) => { q = ''; return goto(tabHref(to), { replace: true, reset: false }); };

  /** the search: its results replace the tab panel while a query is typed ($t as an argument: the texts follow a language switch) */
  let q: string | number | null = '';
  $: query = String(q ?? '');
  $: searching = !!view && query.trim().length >= SEARCH_MIN;
  const find = (text: string, v: SettingsView, _tr: unknown) => searchSettings(text, v.groups);
  $: hits = searching && view ? find(query, view, $t) : [];
  const hitHref = (h: SettingHit) => settingHref(h.key, h.tab === 'livetv' ? 'livetv' : undefined);
  const hitTab = (h: SettingHit) => (h.tab === 'livetv' ? $t('settings.groups.livetv') : $t(`settings.tabs.${h.tab}`));
  /** choosing a result: the query goes, the link opens the setting */
  const chosen = () => { q = ''; };
  const resultLinks = () => Array.from(document.querySelectorAll<HTMLElement>('#set-results a'));
  /** in the field: Esc clears, Enter opens the first result, ↓ goes to the results */
  function searchKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && query) { e.preventDefault(); q = ''; }
    else if (e.key === 'Enter' && hits[0]) { e.preventDefault(); const to = hitHref(hits[0]); q = ''; void goto(to); }
    else if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); resultLinks()[0]?.focus(); }
  }
  /** in the results: ↑/↓ move, Esc clears and goes back to the field */
  function resultKey(e: KeyboardEvent) {
    const links = resultLinks(), i = links.indexOf(e.currentTarget as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (n < 0) document.getElementById('set-search')?.focus(); else links[Math.min(n, links.length - 1)]?.focus();
    } else if (e.key === 'Escape') { e.preventDefault(); q = ''; document.getElementById('set-search')?.focus(); }
  }
  /** the tablist's keys, as in Live-TV: arrows, Home/End; the focus follows the selected tab (roving tabindex) */
  function tabKey(e: KeyboardEvent) {
    const i = SETTINGS_TABS.indexOf(tab), last = SETTINGS_TABS.length - 1;
    const n = e.key === 'ArrowRight' ? (i + 1) % SETTINGS_TABS.length : e.key === 'ArrowLeft' ? (i + last) % SETTINGS_TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (n < 0) return;
    e.preventDefault(); void select(SETTINGS_TABS[n]!);
    queueMicrotask(() => { const el = document.getElementById(`set-tab-${SETTINGS_TABS[n]!}`); el?.focus(); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  }

  /** follows a deep link once the settings are there: the address becomes the plain tab, then the row (or card) is shown */
  let following = false;
  $: if (view && (linkKey || linkGroup)) void follow(view, linkKey, linkGroup);
  async function follow(v: SettingsView, key: string | null, group: string) {
    if (following) return;
    following = true;
    try {
      if (key) {
        const where = tabOfKey(key, v.groups);
        if (where === 'livetv') { await goto(settingHref(key, 'livetv'), { replace: true }); return; }
        await goto(tabHref(where ?? 'general'), { replace: true, reset: false });
        if (where) await highlightSetting(key);
        return;
      }
      if (group === 'livetv') { await goto('/admin/livetv?tab=settings', { replace: true }); return; }
      await goto(tabHref(linkTab(v, null, group)), { replace: true, reset: false });
      await tick();
      document.getElementById(`settings-${group}`)?.scrollIntoView({ block: 'start' });
    } finally { following = false; }
  }

  async function load(): Promise<boolean> {
    loadFailed = false;
    try { view = await loadSettings(); return true; } catch { if (!view) loadFailed = true; return false; }
  }
  // read from view (not the reactive `groups`): callers run right after load() or an edit, before the next tick
  const itemsOf = (group: SettingGroup): SettingView[] => view?.groups.find((g) => g.id === group)?.items ?? [];
  const changesOf = (group: SettingGroup) => changedValues(itemsOf(group), edits);

  onMount(async () => {
    const u = new URL(location.href);
    const resume = u.searchParams.get('resume') === '1';
    if (resume) {
      u.searchParams.delete('resume');
      void goto(u.pathname + u.search + u.hash, { shallow: true, replace: true });
    }
    const loaded = await load();
    if (!loaded || !resume) return;
    // back from the sign-in: restore what could be kept; repeat exactly the interrupted action, once, when nothing had to be left out
    const p = takePending();
    if (!p) return;
    edits = { ...p.edits };
    resumeNotice = p.dropped ? 'dropped' : 'resumed';
    if (p.dropped) return;
    resuming = true;
    try {
      if (p.action === 'test') await test(p.group);
      else if (Object.keys(changesOf(p.group)).length) await save(p.group, p.force);
    } finally { resuming = false; }
  });

  function edit(key: string, d: Draft | undefined) {
    if (d === undefined) delete edits[key]; else edits[key] = d;
    edits = edits;
    if (errors[key]) { delete errors[key]; errors = errors; }
  }

  /**
   * A refused action that needs a recent sign-in: sign in again in place, then `retry` (the same action) once. The group's change
   * (without secrets) and the action are stashed for the redirect paths and dropped again when the dialog answers.
   */
  async function reauth(target: { action: PendingAction; group: SettingGroup; force?: boolean } | null, retry: () => Promise<unknown>) {
    if (resuming) {
      // the sign-in just happened and the backend still refuses: no second round
      clearPending();
      resumeNotice = 'failed';
      return;
    }
    if (target) stashPending(target.action, target.group, itemsOf(target.group), edits, { force: target.force });
    const ok = await reauthenticate(target ? resumeHref(target.group) : tabHref(tab));
    if (target) clearPending();
    if (!ok) return;
    resuming = true;
    try { await retry(); } finally { resuming = false; }
  }
  /** refuses edited URLs that still carry the redaction marker; true when something was refused */
  function refuseRedacted(group: SettingGroup): boolean {
    const keys = redactedKeys(itemsOf(group), edits);
    if (!keys.length) return false;
    errors = { ...errors, ...Object.fromEntries(keys.map((k) => [k, 'redacted'])) };
    return true;
  }

  /** the group whose save just went through: its button draws the checkmark for 2.2 s (glass spec §8.8) */
  let savedGroup: SettingGroup | null = null, savedTimer: ReturnType<typeof setTimeout> | undefined;
  function markSaved(group: SettingGroup) {
    clearTimeout(savedTimer);
    savedGroup = group;
    savedTimer = setTimeout(() => (savedGroup = null), 2200);
  }
  onDestroy(() => clearTimeout(savedTimer));

  async function save(group: SettingGroup, force = false): Promise<void> {
    const values = changesOf(group);
    if (!Object.keys(values).length || refuseRedacted(group)) return;
    probes = { ...probes, [group]: undefined };
    // a Plex media save runs the check first (a save answers no warning) so "token is not the owner's" is shown after it
    let note: ProbeResult | null = null;
    if (group === 'media' && !force && Object.keys(values).some((k) => k.startsWith('PLEX_'))) {
      const t = await runAction({ key: `set:test:${group}`, run: () => testGroup(group, values), error: false });
      if (t.ok && t.value?.ok && t.value.code === 'warning') note = t.value;
    }
    const res = await runAction({ key: `set:save:${group}`, run: () => saveSettings(values, force), success: tr('settings.saved'), error: false });
    if (res.ok) {
      markSaved(group);
      // the admin menu shows the optional Live-TV entry by this switch: no waiting for the next summary refresh
      if ('LIVETV_OFFER_HIDDEN' in values) void refreshSummary();
      for (const k of Object.keys(values)) delete edits[k];
      edits = edits;
      resumeNotice = null;
      await load();
      if (note) probes = { ...probes, [group]: { result: note, save: false } };
      return;
    }
    if (isReauthError(res.error)) return reauth({ action: 'save', group, force }, () => save(group, force));
    const fe = fieldErrors(res.error);
    const pf = probeFailure(res.error);
    if (fe) errors = { ...errors, ...fe };
    if (pf) probes = { ...probes, [group]: { result: pf, save: true } };
    else toast.error(tr('settings.saveFailed'));
  }

  async function test(group: SettingGroup): Promise<void> {
    probes = { ...probes, [group]: undefined };
    if (refuseRedacted(group)) return;
    const values = changesOf(group);
    const res = await runAction({ key: `set:test:${group}`, run: () => testGroup(group, values), error: false });
    if (res.ok && res.value) { probes = { ...probes, [group]: { result: res.value, save: false } }; return; }
    if (isReauthError(res.error)) return reauth({ action: 'test', group }, () => test(group));
    const fe = fieldErrors(res.error);
    if (fe) errors = { ...errors, ...fe };
    toast.error(tr('settings.testFailed'));
  }

  async function move(keys: string[] | 'all') {
    const res = await runAction({
      key: keys === 'all' ? 'set:move:all' : `set:move:${keys[0]}`, run: () => importEnv(keys), error: tr('settings.moveFailed'),
      success: (r) => (r?.moved.length ? tr('settings.moved', { n: r.moved.length }) : tr('settings.movedNone')),
    });
    if (res.ok && res.value) { moved = new Set([...moved, ...res.value.moved]); await load(); }
  }

  async function regenerate(item: SettingView) {
    const what = item.generate!;
    const ok = await confirm({
      title: tr(what === 'webhookSecret' ? 'settings.generate.webhookConfirm' : 'settings.generate.vapidConfirm'),
      body: tr(what === 'webhookSecret' ? 'settings.generate.webhookBody' : 'settings.generate.vapidBody'),
      danger: true, confirmLabel: tr(`settings.generate.${what}`),
    });
    if (!ok) return;
    await runGenerate(item);
  }
  async function runGenerate(item: SettingView): Promise<void> {
    const what = item.generate!;
    const res = await runAction({
      key: `set:gen:${item.key}`, run: (): Promise<{ secret: string } | { publicKey: string }> => (what === 'webhookSecret' ? generate('webhookSecret') : generate('vapidPair')),
      success: what === 'webhookSecret' ? undefined : tr('settings.generate.done'), error: false,
    });
    if (res.ok && res.value) {
      if ('secret' in res.value) generated = { ...generated, [item.key]: res.value.secret };
      await load();
      return;
    }
    if (isReauthError(res.error)) return reauth(null, () => runGenerate(item));
    toast.error(tr('settings.generate.failed'));
  }
</script>

<div class="wrap">
  <p class="intro muted">{$t('settings.intro')}</p>
  <div class="search" role="search">
    <Field id="set-search" label={$t('settings.search.label')} hideLabel type="search" placeholder={$t('settings.search.placeholder')} maxlength={100} autocomplete="off"
      bind:value={q} on:keydown={searchKey} />
  </div>
  <div class="tabbar">
    <div class="tabs" role="tablist" aria-label={$t('settings.tabs.label')}>
      {#each SETTINGS_TABS as k (k)}
        <!-- the dot's place is always kept: a tab never changes width when it gets unsaved edits -->
        <button type="button" role="tab" id="set-tab-{k}" class="tab" class:on={tab === k} aria-selected={tab === k} aria-controls="set-panel" tabindex={tab === k ? 0 : -1}
          on:click={() => select(k)} on:keydown={tabKey}>{$t(`settings.tabs.${k}`)}<span class="dot" class:on={dirty.has(k)} aria-hidden="true"></span>{#if dirty.has(k)}<span class="sr-only"> ({$t('settings.tabs.unsaved')})</span>{/if}</button>
      {/each}
    </div>
    {#if livetvInstalled}<a class="ltv" href="/admin/livetv?tab=settings">{$t('settings.livetvMoved')}</a>{/if}
  </div>
  {#if searching}
    <div id="set-results" class="results">
      <p class="count" role="status">{hits.length ? $t('settings.search.results', { n: hits.length }) : $t('settings.search.none', { q: query.trim() })}</p>
      {#if hits.length}
        <ul>
          {#each hits as h (h.key)}
            <li><a href={hitHref(h)} on:click={chosen} on:keydown={resultKey}><span class="rl">{h.label}</span><code class="rk">{h.key}</code><span class="rt">{hitTab(h)}</span></a></li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  <!-- the panel stays while searching (hidden): what was typed into a card is kept as it is -->
  <div id="set-panel" role="tabpanel" aria-labelledby="set-tab-{tab}" tabindex="-1" hidden={searching}>
  {#if loadFailed}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('settings.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else if !view}
    <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="12rem" h="2rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
  {:else}
    {#if resumeNotice === 'dropped'}<p class="banner warn" role="alert"><Icon name="key" size={18} />{$t('settings.reauth.dropped')}</p>
    {:else if resumeNotice === 'failed'}<p class="banner warn" role="alert"><Icon name="alert" size={18} />{$t('settings.reauth.failed')}</p>
    {:else if resumeNotice === 'resumed'}<p class="banner" role="status"><Icon name="check" size={18} />{$t('settings.reauth.resumed')}</p>{/if}
    {#if restartKeys.length}
      <div class="banner warn" role="status">
        <Icon name="refresh" size={18} />
        <div>
          <p>{$t('settings.restartBanner', { keys: fmtList(restartKeys.map(keyLabel)) })}</p>
          <p>{$t('settings.restartCommand')} <code>docker compose restart backend</code></p>
        </div>
      </div>
    {/if}
    {#if envRows.length}
      <div class="banner">
        <Icon name="lock" size={18} />
        <p>{$t('settings.moveAllHint', { n: envRows.length })}</p>
        <Button variant="secondary" size="sm" icon="download" pending={$busyKeys.has('set:move:all')} on:click={() => move('all')}>{$t('settings.moveAll')}</Button>
      </div>
    {/if}

    {#each tabGroups as g (g.id)}
      {@const dirty = Object.keys(changes[g.id] ?? {}).length > 0}
      {@const probe = probes[g.id]}
      <AdminCard id="settings-{g.id}" title={$t(`settings.groups.${g.id}`)} description={groupHelp(g.id)}>
        <svelte:fragment slot="actions">
          {#if PROBE_GROUPS.has(g.id)}
            <Button variant="secondary" size="sm" icon="activity" pending={$busyKeys.has(`set:test:${g.id}`)} on:click={() => test(g.id)}>{$t('settings.test')}</Button>
          {/if}
        </svelte:fragment>
        <form novalidate on:submit|preventDefault={() => save(g.id)}>
          {#each g.items as item (item.key)}
            <!-- errorText(code, item.key): a key's own error text (settings.keyErrors, PLEX_URL invalid_url) -->
            <SettingRow {item} draft={edits[item.key]} error={errors[item.key] ? errorText(errors[item.key], item.key) : ''}
              movedHint={moved.has(item.key) ? moveHint(item.envNames) : ''} moving={$busyKeys.has(`set:move:${item.key}`)}
              generating={$busyKeys.has(`set:gen:${item.key}`)} generated={generated[item.key] ?? ''}
              on:edit={(e) => edit(item.key, e.detail)} on:move={() => move([item.key])} on:generate={() => regenerate(item)} />
          {/each}
          {#if probe}
            {#if probe.result.ok}
              <p class="probe ok" role="status">{probeText(probe.result)}</p>
            {:else}
              <div class="probe err" role="alert">
                <p>{probe.save ? $t('settings.probeFailed', { reason: probeText(probe.result) }) : probeText(probe.result)}</p>
                {#if probe.save && SOFT_PROBE_CODES.has(probe.result.code)}
                  <p class="muted">{$t('settings.probeSoft')}</p>
                  <Button variant="secondary" size="sm" pending={$busyKeys.has(`set:save:${g.id}`)} on:click={() => save(g.id, true)}>{$t('settings.saveAnyway')}</Button>
                {/if}
              </div>
            {/if}
          {/if}
          <div class="foot">
            {#if dirty}<StatusPill tone="warn" icon="clock" label={$t('settings.unsaved')} />{/if}
            <Button type="submit" icon="check" pending={$busyKeys.has(`set:save:${g.id}`)} disabled={!dirty && savedGroup !== g.id} done={savedGroup === g.id && !dirty}>{$t('settings.save')}</Button>
          </div>
        </form>
      </AdminCard>
    {/each}

    {#if server && tab === 'general'}
      <AdminCard title={$t('settings.groups.server')} description={$t('settings.serverHelp')}>
        <dl class="server">
          {#each server.items as s (s.key)}
            <div>
              <dt><code>{s.key}</code></dt>
              <dd>
                <StatusPill tone={s.source === 'env' || s.source === 'bootstrap' ? 'info' : 'muted'} label={$t(`settings.source.${s.source}`)} />
                {#if s.kind !== 'secret' && s.value !== null && s.value !== undefined}<code class="val">{String(s.value)}</code>
                {:else if s.kind === 'secret'}<span class="muted small">{s.set ? $t('settings.secret.set') : $t('settings.secret.unset')}</span>{/if}
              </dd>
            </div>
          {/each}
        </dl>
        {#if server.items.some((s) => s.key === 'ROLE_TEMPLATES')}<p class="muted small note">{$t('settings.roleTemplatesNote')}</p>{/if}
      </AdminCard>
    {/if}
  {/if}
  </div>
</div>

<style>
  .wrap { max-width: 760px; }
  .intro { margin: 0 0 1rem; }
  /* the tabs as in Live-TV: underlined labels; on a phone a scrolling row of chips. The Live-TV link sits beside them (below on a phone). */
  .tabbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .tabs { display: flex; gap: .4rem; overflow-x: auto; scrollbar-width: none; min-width: 0; max-width: 100%; }
  .tabs::-webkit-scrollbar { display: none; }
  /* positioned: the screen-reader text of the dot stays inside the scrolling row (it would widen the page) */
  .tab { position: relative; flex: none; display: inline-flex; align-items: center; gap: .35rem; min-height: 44px; padding: 0 .9rem; background: transparent; color: var(--mut); border: 0; border-bottom: 2px solid transparent; border-radius: 0; font-weight: 600; white-space: nowrap; }
  .tab:hover:not(:disabled) { color: var(--fg); background: rgba(255,255,255,.04); }
  .tab.on { color: var(--fg); border-bottom-color: var(--accent, #fff); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); opacity: 0; transition: opacity .2s ease; }
  .dot.on { opacity: 1; }
  .ltv { display: inline-flex; align-items: center; min-height: 44px; margin-left: auto; text-decoration: underline; }
  #set-panel { outline: none; min-width: 0; }
  .search { margin-bottom: .8rem; max-width: 28rem; }
  .results { min-width: 0; }
  .count { margin: 0 0 .5rem; color: var(--mut); font-size: .9rem; }
  .results ul { list-style: none; margin: 0; padding: 0; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); overflow: hidden; }
  .results li + li { border-top: 1px solid var(--line); }
  .results a { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'l t' 'k t'; align-items: center; column-gap: .8rem; min-height: 44px; padding: .55rem .9rem; color: inherit; text-decoration: none; }
  .results a:hover, .results a:focus-visible { background: rgba(255,255,255,.06); }
  .rl { grid-area: l; font-weight: 600; overflow-wrap: anywhere; }
  .rk { grid-area: k; font-size: .78rem; color: var(--mut); overflow-wrap: anywhere; }
  .rt { grid-area: t; font-size: .82rem; color: var(--mut); white-space: nowrap; }
  @media (max-width: 720px) {
    .tabbar { border-bottom: 0; }
    .tabs { gap: .5rem; padding-bottom: 2px; }
    .tab { border: 1px solid var(--fr-line, rgba(255,255,255,.2)); border-radius: 999px; padding: 0 1rem; background: rgba(255,255,255,.06); color: rgba(255,255,255,.85); }
    .tab.on { background: #fff; color: #101418; border-color: #fff; }
    .ltv { margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) { .dot { transition: none; } }
  /* a deep-linked group (#settings-<group>) does not end up under the sticky admin header */
  .wrap :global(h2[id^='settings-']) { scroll-margin-top: 5rem; }
  form { display: grid; gap: .25rem; }
  .foot { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: .6rem; padding-top: .8rem; border-top: 1px solid var(--line); }
  .banner { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem .8rem; margin: 0 0 1rem; padding: .75rem .9rem; border-radius: 8px; background: var(--tone-info); border: 1px solid var(--line); }
  .banner.warn { background: var(--tone-warn); }
  .banner p { margin: 0; flex: 1 1 14rem; min-width: 0; }
  .banner > div { flex: 1 1 14rem; display: grid; gap: .3rem; min-width: 0; }
  .banner :global(svg) { flex: none; }
  code { overflow-wrap: anywhere; }
  .note { margin: .8rem 0 0; }
  .probe { margin: .4rem 0 0; padding: .6rem .8rem; border-radius: 6px; display: grid; gap: .4rem; justify-items: start; }
  .probe p { margin: 0; }
  .probe.ok { background: var(--wash-ok); color: var(--ok); } /* tone washes over the dark fill: AA on the glass card */
  .probe.err { background: var(--wash-err); color: var(--fg); }
  .server { margin: 0; display: grid; gap: .5rem; }
  .server div { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .3rem .8rem; padding: .35rem 0; border-top: 1px solid var(--line); }
  .server div:first-child { border-top: 0; }
  .server dt, .server dd { margin: 0; min-width: 0; }
  .server dd { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .val { font-size: .85rem; color: var(--mut); }
  .small { font-size: .85rem; }
  .sk { display: grid; gap: 1rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
