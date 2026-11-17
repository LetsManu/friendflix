<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Sicherungen* (spec "Backup and restore"): the list the updater keeps (the last 3 own and uploaded, the last 2 automatic), *Sicherung*
   * (trickplay only when chosen), *Wiederherstellen* (same kind only), *Herunterladen* (the passphrase typed twice, at least 12
   * characters, never stored: the file comes encrypted with age) and *Aus Datei wiederherstellen* (a downloaded file with its
   * passphrase). The dialogs keep their error line from the start; a request that needs a fresh sign-in asks for it (the card's `call`).
   */
  import { createEventDispatcher } from 'svelte';
  import { apiCode } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { confirm } from '#lib/ui/confirm';
  import { fmtBytes } from '#lib/ui/format';
  import { toast } from '#lib/ui/toast';
  import { uid } from '#lib/ui/ids';
  import type { UpdaterJob } from '../updater';
  import type { MediaApi, MediaBackup, MediaView } from './api';
  import { mediaErrorText, passphraseError, type ActionOp } from './model';

  export let api: MediaApi;
  export let call: <T>(fn: () => Promise<T>) => Promise<T>;
  export let view: MediaView;
  export let actions: ActionOp[];
  /** a job runs: nothing else starts */
  export let busy = false;
  const dispatch = createEventDispatcher<{ job: UpdaterJob | null; changed: void }>();
  const id = uid('msbk');

  $: kind = view.managed.kind;
  $: backups = view.status?.backups ?? [];
  $: admin = api.scope === 'admin';
  const label = (b: MediaBackup) => tr('mediaserver.backup.row', { date: fmtDateTime(b.at), version: b.upstream, size: fmtBytes(b.size) });

  let open: null | 'create' | 'download' | 'upload' = null, target: MediaBackup | null = null, trigger: HTMLElement | null = null;
  let trickplay = false, pass = '', pass2 = '', file: File | null = null, tried = false, error = '', working = false, shell: ModalShell;
  function show(which: NonNullable<typeof open>, e: Event, b: MediaBackup | null = null) {
    trigger = e.currentTarget as HTMLElement;
    open = which; target = b; trickplay = false; pass = ''; pass2 = ''; file = null; tried = false; error = '';
  }
  const close = () => { if (!working) open = null; };
  $: passErr = open === 'download' && tried ? passphraseError(pass, pass2) : open === 'upload' && tried ? (passphraseError(pass, pass) ?? null) : null;

  async function run<T>(fn: () => Promise<T>, after: (r: T) => void) {
    working = true; error = '';
    try {
      after(await call(fn));
      open = null;
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return; // the save picker was closed
      error = mediaErrorText(apiCode(e));
    } finally { working = false; }
  }
  const jobOf = (r: unknown) => ((r as { job?: UpdaterJob | null } | null)?.job ?? null);

  function submit() {
    tried = true;
    if (open === 'create') return run(() => api.action({ op: 'backup', trickplay }), (r) => dispatch('job', jobOf(r)));
    if (open === 'download' && target) {
      if (passphraseError(pass, pass2)) return;
      const b = target;
      return run(() => api.download(b.id, pass), () => toast.success(tr('mediaserver.backup.downloaded')));
    }
    if (open === 'upload') {
      if (!file || passphraseError(pass, pass)) return;
      const f = file;
      return run(() => api.upload(f, pass), (r) => { dispatch('changed'); dispatch('job', r.job); });
    }
  }

  async function restore(b: MediaBackup) {
    if (!(await confirm({ title: tr('mediaserver.backup.restoreTitle', { date: fmtDateTime(b.at) }), body: tr('mediaserver.backup.restoreBody'), danger: true, confirmLabel: tr('mediaserver.backup.restore') }))) return;
    try {
      dispatch('job', jobOf(await call(() => api.action({ op: 'restore', id: b.id }))));
    } catch (e) {
      toast.error(mediaErrorText(apiCode(e)));
    }
  }
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy() { node.remove(); } }; };
  const picked = (e: Event) => { file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null; };
</script>

<section class="sec" aria-labelledby="{id}-t" data-testid="media-backups">
  <h3 id="{id}-t"><Icon name="hard-drive" size={18} />{$t('mediaserver.backup.title')}</h3>
  <div class="acts">
    {#if actions.includes('backup')}<Button variant="secondary" icon="download" disabled={busy} on:click={(e) => show('create', e)}>{$t('mediaserver.backup.create')}</Button>{/if}
    {#if admin && kind}<Button variant="secondary" icon="arrow-up" disabled={busy} on:click={(e) => show('upload', e)}>{$t('mediaserver.backup.upload')}</Button>{/if}
  </div>
  {#if !backups.length}<p class="muted small">{$t('mediaserver.backup.none')}</p>
  {:else}
    <ul>
      {#each backups as b (b.id)}
        <li data-backup={b.id}>
          <div class="what"><span>{label(b)}</span><span class="tag">{$t(`mediaserver.backup.tag.${b.tag}`)}</span></div>
          <div class="btns">
            {#if actions.includes('restore') && b.kind === kind}<Button variant="ghost" size="sm" disabled={busy} on:click={() => restore(b)}>{$t('mediaserver.backup.restore')}</Button>{/if}
            {#if admin}<Button variant="ghost" size="sm" icon="download" on:click={(e) => show('download', e, b)}>{$t('mediaserver.backup.download')}</Button>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if open}
  <!-- on the page itself: the glass card around this list would become the fixed overlay's containing block -->
  <div use:portal>
  <ModalShell bind:this={shell} labelledby="{id}-dt" describedby="{id}-dd" focus={open === 'create' ? 'button[role=switch]' : 'input'} {trigger} locked={working} on:close={close}>
    <form novalidate on:submit|preventDefault={submit}>
      <h2 id="{id}-dt" class="dlg-title">{$t(open === 'create' ? 'mediaserver.backup.createTitle' : open === 'download' ? 'mediaserver.backup.downloadTitle' : 'mediaserver.backup.uploadTitle')}</h2>
      <div class="dlg-main">
        <p id="{id}-dd" class="dlg-body">{$t(open === 'create' ? 'mediaserver.backup.createBody' : open === 'download' ? 'mediaserver.backup.downloadBody' : 'mediaserver.backup.uploadBody')}</p>
        {#if open === 'create'}
          <Toggle label={$t('mediaserver.backup.trickplay')} bind:checked={trickplay} disabled={working} />
        {:else if open === 'download'}
          {#if target}<p class="which">{label(target)}</p>{/if}
          <Field label={$t('mediaserver.backup.passphrase')} type="password" bind:value={pass} autocomplete="new-password" maxlength={4096} disabled={working}
            error={passErr === 'short' || passErr === 'long' ? $t(`mediaserver.backup.passError.${passErr}`) : ''} />
          <Field label={$t('mediaserver.backup.passphraseAgain')} type="password" bind:value={pass2} autocomplete="new-password" maxlength={4096} disabled={working}
            error={passErr === 'mismatch' ? $t('mediaserver.backup.passError.mismatch') : ''} />
        {:else}
          <div class="field">
            <label for="{id}-f">{$t('mediaserver.backup.file')}</label>
            <input id="{id}-f" type="file" accept=".age,application/octet-stream" disabled={working} on:change={picked} />
            {#if tried && !file}<span class="ferr" role="alert">{$t('mediaserver.backup.fileMissing')}</span>{/if}
          </div>
          <Field label={$t('mediaserver.backup.uploadPassphrase')} type="password" bind:value={pass} autocomplete="off" maxlength={4096} disabled={working}
            error={passErr === 'short' || passErr === 'long' ? $t(`mediaserver.backup.passError.${passErr}`) : ''} />
        {/if}
      </div>
      <p class="dlg-err" role={error ? 'alert' : undefined}>{error}</p>
      <div class="dlg-acts">
        <Button variant="glass" disabled={working} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
        <Button type="submit" pending={working}>{$t(open === 'create' ? 'mediaserver.backup.createConfirm' : open === 'download' ? 'mediaserver.backup.downloadConfirm' : 'mediaserver.backup.uploadConfirm')}</Button>
      </div>
    </form>
  </ModalShell>
  </div>
{/if}

<style>
  .sec { display: grid; gap: .5rem; }
  h3 { display: flex; align-items: center; gap: .45rem; margin: 0; font-size: 1rem; }
  .small { font-size: .88rem; margin: 0; }
  .acts { display: flex; flex-wrap: wrap; gap: .5rem; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; }
  li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .3rem .8rem; padding: .35rem 0; border-top: 1px solid var(--line); }
  .what { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .6rem; min-width: 0; }
  .what span:first-child { overflow-wrap: anywhere; }
  .tag { font-size: .78rem; color: var(--mut); }
  .btns { display: flex; flex-wrap: wrap; gap: .3rem; }
  .which { margin: 10px 0 4px; font-weight: 600; overflow-wrap: anywhere; }
  form :global(.field), form :global(.tgl) { margin-top: 10px; }
  .field { display: flex; flex-direction: column; gap: .3rem; }
  .field input { min-height: 44px; }
  .ferr { font-size: .85rem; color: var(--err); font-weight: 600; }
</style>
