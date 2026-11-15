<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Einstellungen*: the settings of the registry group `livetv` (LIVETV_ENCODER, LIVETV_SRT_HOST, LIVETV_DVR_MINUTES,
   * LIVETV_MAX_BITRATE), edited and saved through the same settings API, rows and texts as Admin → Einstellungen (no second store). A save
   * sends only the changed keys; a refusal that needs a recent sign-in asks in place (lib/account/reauth.ts) and repeats the save once.
   * Below them the SRT ports read-only (`GET /livetv/ingest`; the bind address is not known to the web) and where they are set.
   * A deep link `?setting=<KEY>` (the Systemcheck's "Zur Einstellung", the settings search) highlights that row once it is loaded, then
   * the address reads the plain tab again.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { pageStore } from '#lib/page';
  import { highlightSetting } from '#lib/admin/settings/highlight';
  import Icon from '#lib/Icon.svelte';
  import { isReauthError, reauthenticate } from '#lib/account/reauth';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import { fieldErrors, importEnv, loadSettings, saveSettings, type SettingView } from '#lib/admin/settings/api';
  import { LIVETV_GROUP, changedValues, errorText, moveHint, type Draft } from '#lib/admin/settings/form';
  import SettingRow from '#lib/admin/settings/SettingRow.svelte';
  import { ingestView, type IngestView } from './api';

  let items: SettingView[] | null = null, failed = false;
  let edits: Record<string, Draft> = {};
  let errors: Record<string, string> = {};
  let moved = new Set<string>();
  let ingest: IngestView | null = null, ingestDone = false;
  let saved = false, savedTimer: ReturnType<typeof setTimeout> | undefined;

  $: changes = items ? changedValues(items, edits) : {};
  $: dirty = Object.keys(changes).length > 0;
  const page$ = pageStore();
  $: linkKey = $page$.url.searchParams.get('setting');
  $: if (items && linkKey) void follow(linkKey);
  let following = false;
  async function follow(key: string) {
    if (following) return;
    following = true;
    try {
      await goto('/admin/livetv?tab=settings', { replace: true, reset: false });
      if (items?.some((i) => i.key === key)) await highlightSetting(key);
    } finally { following = false; }
  }

  $: range = ingest?.ports ? (ingest.ports.from === ingest.ports.to ? String(ingest.ports.from) : `${ingest.ports.from}–${ingest.ports.to}`) : '';

  async function load() {
    failed = false;
    // the recording settings (LIVETV_RECORD_*) live on the *Aufnahmen* tab (Phase 3 Task 11)
    try { items = ((await loadSettings()).groups.find((g) => g.id === LIVETV_GROUP)?.items ?? []).filter((i) => !i.key.startsWith('LIVETV_RECORD_')); } catch { if (!items) failed = true; }
  }
  onMount(() => {
    void load();
    ingestView().then((v) => (ingest = v)).catch(() => {}).finally(() => (ingestDone = true));
    return () => clearTimeout(savedTimer);
  });

  function edit(key: string, d: Draft | undefined) {
    if (d === undefined) delete edits[key]; else edits[key] = d;
    edits = edits;
    if (errors[key]) { delete errors[key]; errors = errors; }
  }

  async function save(again = false): Promise<void> {
    const values = changes;
    if (!Object.keys(values).length) return;
    const res = await runAction({ key: 'ltv:settings:save', run: () => saveSettings(values), success: tr('settings.saved'), error: false });
    if (res.ok) {
      saved = true; clearTimeout(savedTimer); savedTimer = setTimeout(() => (saved = false), 2200);
      for (const k of Object.keys(values)) delete edits[k];
      edits = edits;
      await load();
      return;
    }
    if (isReauthError(res.error) && !again) { if (await reauthenticate('/admin/livetv?tab=settings')) return save(true); return; }
    const fe = fieldErrors(res.error);
    if (fe) errors = { ...errors, ...fe };
    else toast.error(tr('settings.saveFailed'));
  }

  async function move(key: string) {
    const res = await runAction({
      key: `ltv:settings:move:${key}`, run: () => importEnv([key]), error: tr('settings.moveFailed'),
      success: (r) => (r?.moved.length ? tr('settings.moved', { n: r.moved.length }) : tr('settings.movedNone')),
    });
    if (res.ok && res.value) { moved = new Set([...moved, ...res.value.moved]); await load(); }
  }
</script>

<div class="stack">
  <AdminCard title={$t('settings.groups.livetv')}>
    {#if failed}
      <p class="err" role="alert"><Icon name="alert" size={18} /><span>{$t('adminLive.settingsTab.loadFailed')}</span><Button variant="secondary" size="sm" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></p>
    {:else if !items}
      <div class="sk" aria-hidden="true"><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /></div>
      <p class="sr-only" role="status">{$t('ui.table.loading')}</p>
    {:else}
      <form novalidate on:submit|preventDefault={() => save()}>
        {#each items as item (item.key)}
          <SettingRow {item} draft={edits[item.key]} error={errors[item.key] ? errorText(errors[item.key]!, item.key) : ''}
            movedHint={moved.has(item.key) ? moveHint(item.envNames) : ''} moving={$busyKeys.has(`ltv:settings:move:${item.key}`)}
            on:edit={(e) => edit(item.key, e.detail)} on:move={() => move(item.key)} />
        {/each}
        <div class="foot">
          {#if dirty}<StatusPill tone="warn" icon="clock" label={$t('settings.unsaved')} />{/if}
          <Button type="submit" icon="check" pending={$busyKeys.has('ltv:settings:save')} disabled={!dirty && !saved} done={saved && !dirty}>{$t('settings.save')}</Button>
        </div>
      </form>
    {/if}
  </AdminCard>

  <AdminCard title={$t('adminLive.settingsTab.ports')}>
    <div class="ports" aria-live="polite">
      {#if !ingestDone}<Skeleton w="12rem" h="1.4rem" />
      {:else if range}<p data-srt-ports><code>{$t('adminLive.settingsTab.portsValue', { range })}</code></p>{/if}
    </div>
    <p class="hint muted">{$t('adminLive.settingsTab.hint')}</p>
  </AdminCard>
</div>

<style>
  .stack { display: grid; gap: 1rem; max-width: 760px; }
  form { display: grid; gap: .25rem; }
  .foot { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: .6rem; padding-top: .8rem; border-top: 1px solid var(--line); }
  .sk { display: grid; gap: .8rem; min-height: 12rem; }
  .err { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem; margin: 0; }
  .err span { flex: 1 1 14rem; }
  .ports { min-height: 1.6rem; display: flex; align-items: center; }
  .ports p { margin: 0; }
  .hint { margin: .6rem 0 0; }
  code { overflow-wrap: anywhere; }
</style>
