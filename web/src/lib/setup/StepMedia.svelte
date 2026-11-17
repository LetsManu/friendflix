<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 3: the media server, rendered from GET /api/setup/state (spec Part H): `media.keys` are the manual fields (labels
   * settings.keys.<KEY>, the key itself without a text), `media.auto` the fields of "Create API key automatically" (null = manual only).
   * The administrator's password is sent once and the field is emptied afterwards; a typed API key is emptied after the save.
   *
   * The managed media server (spec "Admin and wizard", wizard step 3): where the backend offers it (GET /api/setup/mediaserver, read
   * once on the way in, never on Plex), the step shows the card's three choices with the default managed kind preselected
   * (api.ts initialChoice); the existing server by address keeps the fields below unchanged. A managed kind runs *Basisordner* →
   * *Ordner* → *Grafikkarte* (+ *Metadaten aus dem Internet*) → *Einrichten* with the Admin card's sections bound to setupMediaApi()
   * (setup session, no re-authentication; what the wizard has no route for, those sections hide), then follows the first run every
   * 2 s and goes on once it is done. Nothing above the progress moves while it runs. Not offered: today's fields with the reason line.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { apiCode } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { setupMediaApi, type FolderInput, type Gpu, type MediaView } from '#lib/admin/mediaserver/api';
  import BaseFolder from '#lib/admin/mediaserver/BaseFolder.svelte';
  import FolderPicker from '#lib/admin/mediaserver/FolderPicker.svelte';
  import GpuSection from '#lib/admin/mediaserver/GpuSection.svelte';
  import SetupProgress from '#lib/admin/mediaserver/SetupProgress.svelte';
  import {
    CHOICES, DEFAULT_MANAGED, DOCS_HREF, TRIAL_KINDS, choiceDisabled, folderRowsError, initialRows, keptLibraries, mediaErrorText, nameTakenRow, reasonText, setupActive,
    type Choice,
  } from '#lib/admin/mediaserver/model';
  import { errorText as fieldText, keyHelp, keyLabel } from '#lib/admin/settings/form';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { initialChoice, mediaAuto, saveSetup, testSetup, type AutoField, type SetupState } from './api';
  import { failure, filled, isSecretKey, otherFieldErrors, probeText, type Handle, type Message } from './messages';
  import Notice from './Notice.svelte';

  export let state: SetupState;
  export let handle: Handle;
  const dispatch = createEventDispatcher<{ done: void }>();

  $: autoFields = state.media.auto ?? [];
  let mode: 'auto' | 'manual' = state.media.auto?.length ? 'auto' : 'manual';
  let auto: Record<AutoField, string> = { url: '', username: '', password: '' };
  let manual: Record<string, string> = Object.fromEntries(state.media.keys.map((k) => [k, '']));
  let busy: 'auto' | 'save' | 'test' | 'force' | null = null;
  let msg: Message | null = null;
  let ok = '';
  // a saved Plex token that works but is not the owner's (probe warning not_admin) is saved, and the note stays until "Next"
  let held = false;
  $: plex = state.mediaKind === 'plex';

  const AUTO_LABEL = { url: 'setup.media.url', username: 'setup.media.username', password: 'setup.media.password' } as const;
  $: autoReady = autoFields.every((f) => auto[f].trim() || f === 'password');
  $: manualValues = filled(manual);
  $: others = otherFieldErrors(msg?.fields, mode === 'manual' ? state.media.keys : []);
  $: fieldErr = (key: string) => (msg?.fields?.[key] ? fieldText(msg.fields[key]!, key) : ''); // + key (PLEX_URL's own invalid_url text)

  function setMode(m: 'auto' | 'manual') { mode = m; msg = null; ok = ''; }

  async function createKey() {
    if (busy) return;
    busy = 'auto'; msg = null; ok = '';
    try {
      const r = await mediaAuto({ url: auto.url.trim(), username: auto.username.trim(), password: auto.password });
      if (r.ok) { ok = $t('setup.media.created'); dispatch('done'); }
      else msg = { kind: 'message', text: probeText(r), probe: r };
    } catch (e) {
      msg = handle(e);
    } finally {
      auto.password = ''; // used once
      busy = null;
    }
  }

  async function test() {
    if (busy) return;
    busy = 'test'; msg = null; ok = '';
    try {
      const r = await testSetup('media', manualValues);
      if (r.ok) ok = probeText(r);
      else msg = { kind: 'message', text: probeText(r), probe: r };
    } catch (e) { msg = handle(e); } finally { busy = null; }
  }

  async function save(force = false) {
    if (busy) return;
    busy = force ? 'force' : 'save'; msg = null; ok = ''; held = false;
    try {
      // on Plex Test runs before Save (a save answers no warning), so a token that is not the owner's is shown; a refusal of
      // the check itself is left to the save, which probes the same way (and has the "Save anyway" for an unreachable server)
      let note = '';
      if (plex && !force) {
        const r = await testSetup('media', manualValues).catch(() => null);
        if (r?.ok && r.code === 'warning') note = probeText(r);
      }
      await saveSetup(manualValues, force);
      // the key is saved: it never stays in the page
      manual = Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, isSecretKey(k) ? '' : v]));
      if (note) { ok = note; held = true; } else dispatch('done');
    } catch (e) { msg = handle(e); } finally { busy = null; }
  }

  // ------------------------------------------------------------------ the managed media server
  const media = setupMediaApi();
  /** the backend's view; null until read, on Plex, or when it could not be read (then today's step) */
  let view: MediaView | null = null;
  /** the first read is over (Plex reads nothing: today's step at once) */
  let loaded = state.mediaKind === 'plex';
  let choice: Choice = 'external';

  /** the sections' requests: a setup session that is gone (or a setup someone finished) goes to the page, the section still says why */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (failure(e).kind !== 'message') handle(e);
      throw e;
    }
  }

  async function load(): Promise<void> {
    try {
      const v = await call(() => media.view());
      const was = view?.mode === 'managed' ? view.managed.setup : null;
      view = v;
      if (hdrWait && ((v.status?.hdr?.at ?? null) !== hdrBefore || ++hdrPolls >= HDR_POLLS)) hdrWait = false;
      if (!loaded) {
        state.mediaserver = { offer: v.offer, kinds: v.kinds };
        loaded = true;
        pick(v.mode === 'managed' && v.managed.kind ? v.managed.kind : initialChoice(state));
      } else if (was !== null && was !== 'done' && v.mode === 'managed' && v.managed.setup === 'done') {
        // the first run this step followed is done: on to the sign-in (the step stays as it is while the page moves on)
        leaving = true;
        dispatch('done');
      }
    } catch {
      loaded = true;
    }
  }

  $: offered = Boolean(view && !plex && (view.offer.managed || view.mode === 'managed'));
  /** why the managed server is not offered (a view that was read; Plex never shows it) */
  $: offReason = view && !plex && !offered ? choiceDisabled(view, DEFAULT_MANAGED) : null;
  $: active = Boolean(view && view.mode === 'managed' && setupActive(view.managed));
  // the HDR test's job is not followed here (the wizard has no job view): its result arrives with the view, or the wait ends
  const HDR_POLLS = 60;
  let hdrWait = false, hdrPolls = 0, hdrBefore: string | null = null;
  $: following = active || hdrWait;
  let timer: ReturnType<typeof setTimeout> | undefined, gone = false;
  function schedule() {
    clearTimeout(timer);
    if (gone || !following) return;
    timer = setTimeout(async () => { await load(); schedule(); }, 2000);
  }
  $: if (following) schedule();
  onMount(() => { if (!loaded) void load(); });
  onDestroy(() => { gone = true; clearTimeout(timer); });

  // the form of a managed kind; user and media group stay what runs (else 1000:1000), they are set later in Admin
  let rows: FolderInput[] = [], gpu: Gpu = 'off', egress = true, preselectGpu = true;
  let ids: { uid: number; gid: number; mediaGid: number | null } = { uid: 1000, gid: 1000, mediaGid: null };
  let rowErrors: Record<string, string> = {}, error = '', applying = false, acting: '' | 'retry' | 'hdr-test' = '', leaving = false;
  function pick(c: Choice) {
    choice = c; error = ''; rowErrors = {};
    if (c === 'external' || !view) return;
    const same = view.managed.kind === c;
    const d = same ? view.status?.desired : null;
    rows = same ? initialRows(view) : [];
    ids = { uid: d?.uid ?? 1000, gid: d?.gid ?? 1000, mediaGid: d?.mediaGid ?? null };
    gpu = d?.gpu ?? 'off'; preselectGpu = !d; egress = d?.egress ?? true;
  }
  let segBtns: HTMLButtonElement[] = [];
  /** a disabled choice, unless it is the one the server is on */
  const segOff = (v: MediaView, c: Choice) => c !== (v.mode === 'managed' && v.managed.kind ? v.managed.kind : 'external') && Boolean(choiceDisabled(v, c));
  function segKey(e: KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d || !view) return;
    e.preventDefault();
    for (let k = 1; k <= CHOICES.length; k++) {
      const j = (i + d * k + CHOICES.length * 3) % CHOICES.length;
      if (!segOff(view, CHOICES[j]!)) { pick(CHOICES[j]!); segBtns[j]?.focus(); return; }
    }
  }
  $: reasons = view ? [...new Set((['ferrofin', 'jellyfin'] as const).map((k) => choiceDisabled(view!, k)).filter((r): r is NonNullable<typeof r> => r !== null))] : [];

  $: managedKind = choice === 'external' ? null : choice;
  $: isCurrent = Boolean(view && managedKind && view.mode === 'managed' && view.managed.kind === managedKind);
  $: locked = !view?.status?.available || Boolean(view && managedKind && !isCurrent && choiceDisabled(view, managedKind));
  $: base = view?.status?.base ?? { set: false, path: null, pending: false, expiresAt: null };
  $: kept = view && isCurrent ? keptLibraries(view) : [];
  $: working = applying || acting !== '' || active || hdrWait;
  /** set up before this step was opened: *Übernehmen* for changes and *Weiter* */
  $: finished = isCurrent && view?.managed.setup === 'done' && !leaving;
  const edited = () => { rowErrors = {}; error = ''; };

  async function apply() {
    if (!view || !managedKind || working) return;
    edited();
    if (!base.set) { error = tr('mediaserver.apply.needBase'); return; }
    const bad = folderRowsError(rows);
    if (bad) { error = tr(`mediaserver.folders.error.${bad}`); return; }
    applying = true;
    try {
      await call(() => media.apply({ kind: managedKind!, folders: rows.map((r) => ({ ...r, name: r.name.trim() })), ...ids, gpu, egress }));
      await load();
    } catch (e) {
      const code = apiCode(e);
      error = mediaErrorText(code);
      const i = code === 'library_name_taken' ? nameTakenRow(rows, kept) : -1;
      if (i >= 0) rowErrors = { [rows[i]!.rel]: tr('mediaserver.folders.nameTaken') };
    } finally { applying = false; }
  }
  /** *Nochmal* (the failed first-run step) and *HDR-Test*: the two actions the setup routes have */
  async function act(op: 'retry' | 'hdr-test') {
    if (!managedKind) return;
    acting = op; error = '';
    try {
      hdrBefore = view?.status?.hdr?.at ?? null;
      await call(() => media.action(op === 'retry' ? { op } : { op, kind: managedKind! }));
      if (op === 'hdr-test') { hdrWait = true; hdrPolls = 0; }
      await load();
    } catch (e) {
      error = mediaErrorText(apiCode(e));
    } finally { acting = ''; }
  }
</script>

<h2 id="setup-step-h">{$t('setup.media.title')}</h2>
{#if !loaded}
  <div class="sk" aria-hidden="true"><Skeleton h="1.2rem" lines={2} /><Skeleton h="3rem" /></div>
  <p class="sr-only" role="status">{$t('ui.table.loading')}</p>
{:else if offered && view}
  <p>{$t('setup.media.textChoice')}</p>
  {#if state.steps.media === 'done'}<p class="muted">{$t('setup.doneText')}</p>{/if}
  <div class="choice" role="radiogroup" aria-label={$t('mediaserver.choice.label')} data-testid="media-choice">
    {#each CHOICES as c, i (c)}
      {@const off = segOff(view, c)}
      <button type="button" role="radio" aria-checked={choice === c} tabindex={choice === c ? 0 : -1} class:on={choice === c} disabled={off} data-choice={c}
        aria-describedby={off ? 'sm-reasons' : undefined} bind:this={segBtns[i]} on:click={() => pick(c)} on:keydown={(e) => segKey(e, i)}>
        <span class="lbl">{$t(`mediaserver.choice.${c}`)}</span>
        {#if c !== 'external' && TRIAL_KINDS.includes(c)}<span class="badge">{$t('mediaserver.choice.trial')}</span>{/if}
      </button>
    {/each}
  </div>
  <div id="sm-reasons" class="reasons">
    {#each reasons as r (r)}<p><Icon name="info" size={16} />{reasonText(r)}</p>{/each}
    {#if TRIAL_KINDS.length}<p class="muted">{$t('mediaserver.choice.trialNote')} <a href={DOCS_HREF} target="_blank" rel="noopener noreferrer">{$t('mediaserver.choice.trialDocs')}</a></p>{/if}
  </div>
{:else}
  <p>{$t(plex ? 'setup.media.textPlex' : 'setup.media.text')}</p>
  {#if offReason}<p class="muted off" data-testid="media-off"><Icon name="info" size={16} /><span>{$t('setup.media.managedOff')} {reasonText(offReason)}</span></p>{/if}
  {#if state.steps.media === 'done'}<p class="muted">{$t('setup.doneText')}</p>{/if}
{/if}

{#if !loaded}
  <!-- the offer is being read -->
{:else if managedKind && view}
  <p class="intro">{$t('setup.media.managedText')}</p>
  <div class="secs">
    {#key managedKind}
      <BaseFolder api={media} {call} {base} inUse={Boolean(view.status?.container)} disabled={locked || working} on:changed={() => load()} on:job={() => load()} />
      {#if base.set}
        <FolderPicker api={media} {call} bind:rows libraries={isCurrent ? view.managed.libraries : []} {kept} {rowErrors} disabled={locked || working} on:changed={edited} />
        <GpuSection api={media} {call} bind:gpu preselect={preselectGpu} hdr={view.status?.hdr ?? null}
          canTest={isCurrent && Boolean(view.status?.container) && !working} deployed={isCurrent ? view.status?.desired?.gpu ?? null : null}
          testing={acting === 'hdr-test' || hdrWait} disabled={locked || working} on:hdr={() => act('hdr-test')} />
        <section class="sec">
          <Toggle label={$t('mediaserver.metadata.label')} hint={$t('mediaserver.metadata.hint')} bind:checked={egress} disabled={locked || working} />
        </section>
      {/if}
    {/key}
  </div>
  <div class="apply">
    <div class="acts">
      {#if finished}<Button variant="secondary" icon="chevron-right" disabled={working} on:click={() => dispatch('done')}>{$t('setup.next')}</Button>{/if}
      <Button class="go" icon="check" pending={applying} disabled={locked || working || !base.set} data-testid="media-apply" on:click={apply}>
        {finished ? $t('mediaserver.apply.apply') : $t('mediaserver.apply.setup')}
      </Button>
    </div>
    <p class="msg" class:err={error} role={error ? 'alert' : 'status'} data-testid="media-apply-error">{error}</p>
  </div>
  {#if isCurrent && view.managed.setup !== 'none'}
    <SetupProgress managed={view.managed} busy={acting === 'retry'} canRecreate={false} on:retry={() => act('retry')} />
  {/if}
{:else}
{#if offered}<p>{$t('setup.media.text')}</p>{/if}
{#if autoFields.length}
  <div class="seg" role="group" aria-label={$t('setup.media.modeLabel')}>
    <button type="button" class:on={mode === 'auto'} aria-pressed={mode === 'auto'} on:click={() => setMode('auto')}>{$t('setup.media.auto')}</button>
    <button type="button" class:on={mode === 'manual'} aria-pressed={mode === 'manual'} on:click={() => setMode('manual')}>{$t('setup.media.manual')}</button>
  </div>
{:else}
  <p class="muted">{$t('setup.media.noAuto')}</p>
{/if}

{#if mode === 'auto'}
  <form novalidate on:submit|preventDefault={createKey}>
    <p>{$t('setup.media.autoText')}</p>
    {#each autoFields as f (f)}
      <Field label={$t(AUTO_LABEL[f])} hint={f === 'url' ? $t('setup.media.urlHint') : ''} let:id let:describedby>
        {#if f === 'password'}
          <input {id} type="password" autocomplete="off" maxlength={1024} bind:value={auto.password} aria-describedby={describedby} />
        {:else if f === 'url'}
          <input {id} type="text" inputmode="url" autocomplete="off" spellcheck="false" maxlength={2048} bind:value={auto.url} aria-describedby={describedby} />
        {:else}
          <input {id} type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength={256} bind:value={auto.username} aria-describedby={describedby} />
        {/if}
      </Field>
    {/each}
    {#if ok}<Notice tone="ok"><p>{ok}</p></Notice>{/if}
    {#if msg}<Notice tone="err"><p>{msg.text}</p>{#each others as o (o)}<p>{o}</p>{/each}</Notice>{/if}
    <div class="acts"><Button type="submit" icon="key" pending={busy === 'auto'} disabled={!autoReady}>{$t('setup.media.create')}</Button></div>
  </form>
{:else}
  <form novalidate on:submit|preventDefault={() => save()}>
    <p>{$t(plex ? 'setup.media.manualTextPlex' : 'setup.media.manualText')}</p>
    {#each state.media.keys as key (key)}
      <Field label={keyLabel(key)} hint={keyHelp(key)} error={fieldErr(key)} let:id let:describedby let:invalid>
        <input {id} type={isSecretKey(key) ? 'password' : 'text'} autocomplete="off" spellcheck="false" maxlength={4096} bind:value={manual[key]}
          aria-describedby={describedby} aria-invalid={invalid} />
      </Field>
    {/each}
    {#if ok}<Notice tone="ok"><p>{ok}</p></Notice>{/if}
    {#if msg && (!msg.fields || others.length)}
      <Notice tone="err">
        <p>{msg.text}</p>
        {#each others as o (o)}<p>{o}</p>{/each}
        {#if msg.soft}
          <p>{$t('setup.saveSoft')}</p>
          <Button variant="secondary" size="sm" pending={busy === 'force'} on:click={() => save(true)}>{$t('setup.saveAnyway')}</Button>
        {/if}
      </Notice>
    {/if}
    <div class="acts">
      {#if held}<Button icon="check" on:click={() => dispatch('done')}>{$t('setup.next')}</Button>{/if}
      <Button variant="secondary" icon="activity" pending={busy === 'test'} disabled={!Object.keys(manualValues).length} on:click={test}>{$t('setup.test')}</Button>
      <Button type="submit" icon="check" pending={busy === 'save'} disabled={!Object.keys(manualValues).length}>{$t('setup.saveNext')}</Button>
    </div>
  </form>
{/if}
{/if}

<style>
  form { display: grid; gap: .8rem; }
  form > p { margin: 0; }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
  .seg { display: inline-flex; gap: .25rem; padding: .25rem; margin-bottom: 1rem; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); max-width: 100%; }
  .seg button { min-height: 44px; padding: .4rem 1rem; border-radius: 6px; background: transparent; color: var(--fg); border: 0; font-weight: 600; }
  .seg button.on { background: var(--fg); color: var(--bg); }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } .seg { display: flex; } .seg button { flex: 1; } }
  .sk { display: grid; gap: .8rem; }
  .off { display: flex; align-items: flex-start; gap: .4rem; font-size: .9rem; }
  .off :global(svg), .reasons :global(svg) { flex: none; margin-top: .15rem; color: var(--info-mark); }
  /* the three choices (the Admin card's look): glass tiles in one row, stacked on a phone; the selected one is marked by an overlay that only fades */
  .choice { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 4px; border-radius: var(--fr-r-tile); border: 1px solid var(--line); background: rgba(255, 255, 255, .04); }
  .choice button { position: relative; min-height: 44px; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .3rem .5rem; padding: .45rem .7rem; border-radius: 14px;
    background: transparent; color: var(--mut); font-weight: 600; text-align: center; isolation: isolate; border: 0; }
  .choice button::before { content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: rgba(var(--acc-rgb), .22); box-shadow: inset 0 0 0 1px var(--acc-line); opacity: 0; transition: opacity .2s ease; }
  .choice button.on { color: var(--fg); }
  .choice button.on::before { opacity: 1; }
  .choice button:hover:not(:disabled):not(.on) { color: var(--fg); background: rgba(255, 255, 255, .06); }
  .choice button:disabled { opacity: .55; cursor: not-allowed; }
  .lbl { overflow-wrap: anywhere; }
  .badge { padding: .05rem .5rem; border-radius: var(--fr-r-pill); background: var(--acc-fill); color: #fff; font-size: .72rem; font-weight: 700; }
  .reasons { display: grid; gap: .25rem; margin: .5rem 0 .8rem; font-size: .88rem; }
  .reasons p { display: flex; align-items: flex-start; gap: .4rem; margin: 0; }
  .reasons a { text-decoration: underline; }
  .intro { margin: 0 0 .8rem; }
  .secs { display: grid; gap: 1.2rem; }
  .secs > :global(section + section) { padding-top: 1rem; border-top: 1px solid var(--line); }
  .apply { display: grid; gap: .3rem; margin-top: 1.2rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  /* one width for *Einrichten* and *Übernehmen*: the label switching at the end of the first run moves nothing */
  .apply :global(.go) { min-width: 11rem; }
  .msg { margin: 0; min-height: 2.6em; font-size: .9rem; color: var(--mut); text-align: right; }
  .msg.err { color: var(--err-mark); }
  .apply ~ :global(.sp) { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  @media (max-width: 600px) {
    .choice { grid-template-columns: minmax(0, 1fr); }
    .choice button { justify-content: flex-start; text-align: left; }
  }
  @media (prefers-reduced-motion: reduce) { .choice button::before { transition: none; } }
</style>
