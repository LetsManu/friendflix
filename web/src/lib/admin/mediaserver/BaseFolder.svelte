<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Basisordner* (spec "The base folder and its code"): the confirmed path read-only with *Ändern*, or the path field with *Code
   * anfordern*; then the code field with its countdown (mm:ss, model.ts countdown) and where the updater wrote the line
   * (model.ts codeLogHint). A right code stores the base (a managed server is recreated on it: its job goes to the card); a wrong,
   * expired or used-up one says so. *Neuen Code anfordern* keeps the pending code until a new one replaces it; *Abbrechen* (whenever a code
   * is pending) frees the path field again. The countdown, the hint and the reason line keep their room while the code is pending: nothing
   * below moves while the time runs or a refusal appears.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { apiCode } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtList, t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { confirm } from '#lib/ui/confirm';
  import type { BaseConfirm, MediaApi, MediaStatus } from './api';
  import type { UpdaterJob } from '../updater';
  import { codeLogHint, countdown, mediaErrorText } from './model';

  export let api: MediaApi;
  export let base: MediaStatus['base'];
  /** runs a request, asking for a fresh sign-in once where it needs one (the card's) */
  export let call: <T>(fn: () => Promise<T>) => Promise<T>;
  /** a managed container exists: the base cannot be cleared (it only narrows while nothing reads it) */
  export let inUse = false;
  export let disabled = false;
  /** the card has the section *Benutzer* the unreadable note points to; the wizard has none (user and group come later, in Admin) */
  export let userSection = true;
  const dispatch = createEventDispatcher<{ changed: void; job: UpdaterJob; unreadable: boolean }>();

  /** opens with the path field (the move sheet's *Basisordner ändern*: the change is what was asked for) */
  export let startEditing = false;
  let editing = startEditing, path = base.path ?? '', code = '', error = '', note = '', doing: '' | 'request' | 'confirm' | 'clear' = '';
  $: busy = doing !== '';
  /** the expiry of a code requested here (the status brings it back after a reload) */
  let expiresAt: string | null = base.pending ? base.expiresAt : null;
  $: if (base.pending && base.expiresAt) expiresAt = base.expiresAt;
  $: pending = Boolean(expiresAt) && (base.pending || editing || !base.set);
  let now = Date.now();
  const timer = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(timer));
  $: left = expiresAt ? countdown(expiresAt, now) : '00:00';
  $: expired = pending && left === '00:00';
  $: showForm = !base.set || editing;

  const absolute = (p: string) => /^\/[^\0]*$/.test(p.trim()) && p.trim().length <= 200;

  async function request() {
    error = ''; note = '';
    if (!absolute(path)) { error = tr('mediaserver.base.pathError'); return; }
    doing = 'request';
    try {
      const r = await call(() => api.requestBase(path.trim()));
      expiresAt = r.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString();
      code = '';
      dispatch('unreadable', r.warning === 'base_unreadable');
      if (r.warning === 'base_unreadable') note = tr(userSection ? 'mediaserver.base.unreadable' : 'mediaserver.base.unreadableLater');
    } catch (e) {
      error = mediaErrorText(apiCode(e));
    } finally { doing = ''; }
  }

  async function confirmCode() {
    error = ''; note = '';
    if (!code.trim()) return;
    doing = 'confirm';
    try {
      const r: BaseConfirm = await call(() => api.confirmBase(code.trim()));
      editing = false; expiresAt = null; code = '';
      const parts = [tr('mediaserver.base.done')];
      if (r.kept.length) parts.push(tr('mediaserver.base.kept', { list: fmtList(r.kept) }));
      if (r.dropped.length) parts.push(tr('mediaserver.base.dropped', { list: fmtList(r.dropped) }));
      note = parts.join(' ');
      if (r.job) dispatch('job', r.job);
      dispatch('changed');
    } catch (e) {
      const c = apiCode(e);
      error = mediaErrorText(c);
      // the pending request is gone (expired, the fifth wrong code, none at all): a new code is needed
      if (c === 'expired' || c === 'locked' || c === 'no_pending') expiresAt = null;
    } finally { doing = ''; }
  }

  async function clear() {
    if (!(await confirm({ title: tr('mediaserver.base.clearTitle'), body: tr('mediaserver.base.clearBody'), confirmLabel: tr('mediaserver.base.clear') }))) return;
    error = '';
    doing = 'clear';
    try {
      await call(() => api.clearBase());
      path = ''; editing = false;
      dispatch('changed');
    } catch (e) {
      error = mediaErrorText(apiCode(e));
    } finally { doing = ''; }
  }
  const change = () => { editing = true; path = base.path ?? ''; error = ''; note = ''; };
  const cancel = () => { editing = false; expiresAt = null; code = ''; error = ''; };
</script>

<section class="sec" aria-labelledby="ms-base-t">
  <h3 id="ms-base-t"><Icon name="hard-drive" size={18} />{$t('mediaserver.base.title')}</h3>
  <p class="muted small">{$t('mediaserver.base.intro')}</p>
  {#if !showForm}
    <div class="confirmed">
      <code data-testid="media-base-path">{base.path}</code>
      <span class="pill"><Icon name="check" size={14} />{$t('mediaserver.base.confirmed')}</span>
      <Button variant="secondary" size="sm" icon="pencil" {disabled} on:click={change}>{$t('mediaserver.base.change')}</Button>
      {#if api.scope === 'admin' && !inUse}<Button variant="ghost" size="sm" {disabled} pending={doing === 'clear'} on:click={clear}>{$t('mediaserver.base.clear')}</Button>{/if}
    </div>
  {:else}
    <form class="row" novalidate on:submit|preventDefault={request}>
      <Field label={$t('mediaserver.base.path')} bind:value={path} placeholder="/srv/media" maxlength={200} autocomplete="off" disabled={disabled || busy || pending} />
      <div class="btns">
        {#if !pending}<Button type="submit" variant="secondary" {disabled} pending={doing === 'request'}>{$t('mediaserver.base.request')}</Button>{/if}
        {#if editing || pending}<Button variant="ghost" disabled={busy} on:click={cancel}>{$t('common.cancel')}</Button>{/if}
      </div>
    </form>
    {#if pending}
      <form class="row" novalidate on:submit|preventDefault={confirmCode}>
        <Field label={$t('mediaserver.base.code')} bind:value={code} placeholder="XXXX-XXXX-XXXX" maxlength={20} autocomplete="off" disabled={disabled || busy || expired} />
        <div class="btns">
          <Button type="submit" pending={doing === 'confirm'} disabled={disabled || expired || !code.trim()}>{$t('mediaserver.base.confirm')}</Button>
          <!-- the pending code, its countdown and the hint stay until a new code replaces them (or a refusal says why) -->
          <Button variant="ghost" pending={doing === 'request'} disabled={busy && doing !== 'request'} on:click={request}>{$t('mediaserver.base.newCode')}</Button>
        </div>
      </form>
      <!-- fixed room: the countdown never changes width (tabular digits), the hint is there the whole time -->
      <p class="count" data-testid="media-code-countdown" aria-live="off">{expired ? $t('mediaserver.base.expired') : $t('mediaserver.base.validFor', { time: left })}</p>
      <div class="hint" data-testid="media-code-hint">
        <p>{$t('mediaserver.base.hint')}</p>
        <code>{codeLogHint.compose}</code>
        <p>{$t('mediaserver.base.hintPortainer')} <span class="path">{codeLogHint.portainer}</span></p>
      </div>
    {/if}
  {/if}
  <p class="msg" class:err={error} role={error ? 'alert' : 'status'}>{error || note}</p>
</section>

<style>
  .sec { display: grid; gap: .5rem; }
  h3 { display: flex; align-items: center; gap: .45rem; margin: 0; font-size: 1rem; }
  .small { font-size: .88rem; margin: 0; }
  .confirmed { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .8rem; }
  .confirmed code { overflow-wrap: anywhere; font-size: .95rem; }
  .pill { display: inline-flex; align-items: center; gap: .3rem; padding: .2rem .6rem; border-radius: var(--fr-r-pill); background: var(--wash-ok); color: var(--ok); font-size: .82rem; font-weight: 600; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: .6rem; }
  .btns { display: flex; flex-wrap: wrap; gap: .4rem; padding-bottom: 2px; }
  .count { margin: 0; min-height: 1.5em; font-variant-numeric: tabular-nums; color: var(--acc-text); font-weight: 600; }
  .hint { display: grid; gap: .3rem; padding: .6rem .8rem; border-radius: var(--fr-r-card); background: rgba(255, 255, 255, .05); border: 1px solid var(--line); font-size: .88rem; }
  .hint p { margin: 0; }
  .hint code { overflow-wrap: anywhere; user-select: all; }
  .path { font-weight: 600; }
  .msg { margin: 0; min-height: 2.9em; font-size: .9rem; color: var(--mut); }
  .msg.err { color: var(--err-mark); }
  @media (max-width: 560px) { .row { grid-template-columns: minmax(0, 1fr); } }
</style>
