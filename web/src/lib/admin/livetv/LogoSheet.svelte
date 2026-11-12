<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Logo ändern* (spec §9.2): the channel's logo at the sizes people see it (list 40 px, tile, TV; with no logo the number sits in the
   * tile), *Eigenes Logo hochladen* (PNG / JPEG / WebP, ≤ 512 KB) and *Eigenes Logo entfernen*. The file is checked here first
   * (`checkLogoFile`: SVG, size, type) and only a good one is sent, as the raw body (ruling 32); the server's 413 / 415 are worded
   * too. The error line has its place reserved, so nothing moves. Every answer goes to the list through `changed`.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { channelError, checkLogoFile, dropLogo, errorCode, failText, logoSrc, uploadLogo, LOGO_TYPES, type AdminChannel } from './channels';
  import SheetFrame from './SheetFrame.svelte';

  export let channel: AdminChannel;
  export let returnTo: (() => HTMLElement | null) | null = null;

  const dispatch = createEventDispatcher<{ close: void; changed: AdminChannel }>();
  let c = channel;
  let fileEl: HTMLInputElement | undefined;
  let err = '';
  let broken = false;
  const SIZES = [{ k: 'list', px: 40 }, { k: 'tile', px: 88 }, { k: 'tv', px: 144 }] as const;
  $: key = `ltv-ch-logo:${c.id}`;
  $: busy = $busyKeys.has(key);
  $: hash = c.logoHash;
  $: if (hash) broken = false;

  async function picked() {
    const f = fileEl?.files?.[0];
    if (fileEl) fileEl.value = ''; // the same file may be chosen again
    if (!f) return;
    err = '';
    const bad = checkLogoFile(f);
    if (bad) { err = channelError(bad); return; }
    const r = await runAction({ key, run: () => uploadLogo(c.id, f), success: tr('adminLive.ch.logo.uploaded'), error: false });
    if (r.skipped) return;
    if (!r.ok || !r.value) { err = channelError(errorCode(r.error)); return; }
    c = r.value;
    dispatch('changed', c);
  }
  async function remove() {
    err = '';
    const r = await runAction({ key, run: () => dropLogo(c.id), success: tr('adminLive.ch.logo.removed'), error: failText });
    if (!r.ok || !r.value) return;
    c = r.value;
    dispatch('changed', c);
  }
</script>

<SheetFrame title={tr('adminLive.ch.logo.title', { name: c.name })} {returnTo} on:close={() => dispatch('close')}>
  <div>
    <span class="lbl">{$t('adminLive.ch.logo.sizes')}</span>
    <div class="sizes">
      {#each SIZES as s (s.k)}
        <figure>
          <div class="tile" data-size={s.k} style="width:{s.px}px;height:{s.px}px;--px:{s.px}px">
            {#if hash && !broken}<img src={logoSrc(hash)} alt="" width={s.px} height={s.px} on:error={() => (broken = true)} />{:else}<span class="num">{c.number ?? '–'}</span>{/if}
          </div>
          <figcaption>{$t(`adminLive.ch.logo.${s.k}`)}</figcaption>
        </figure>
      {/each}
    </div>
    <p class="hint">{hash && !broken ? '' : $t('adminLive.ch.logo.none')}</p>
  </div>

  <div class="foot">
    <Button icon="plus" pending={busy} disabled={busy} on:click={() => fileEl?.click()}>{$t('adminLive.ch.logo.upload')}</Button>
    <Button variant="secondary" disabled={busy || !('logo' in c.overridden)} on:click={remove}>{$t('adminLive.ch.logo.remove')}</Button>
    <input bind:this={fileEl} class="file" type="file" accept={LOGO_TYPES.join(',')} tabindex="-1" aria-hidden="true" on:change={picked} />
  </div>
  <p class="hint">{$t('adminLive.ch.logo.hint')}</p>
  <div class="slot" aria-live="polite">
    {#if err}<p class="msg" role="alert" data-form-error><Icon name="alert" size={18} /><span>{err}</span></p>{/if}
  </div>
</SheetFrame>

<style>
  .lbl { display: block; font-size: .9rem; font-weight: 600; margin-bottom: .5rem; }
  .sizes { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 1rem; }
  figure { margin: 0; display: grid; gap: .3rem; justify-items: center; }
  figcaption { font-size: .8rem; color: rgba(255, 255, 255, .8); }
  .tile { box-sizing: border-box; display: grid; place-items: center; overflow: hidden; border-radius: calc(var(--px) / 4); background: rgba(var(--fr-scrim-rgb, 18, 16, 24), .5); border: 1px solid var(--fr-line, rgba(255, 255, 255, .2)); }
  .tile img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .num { font-weight: 800; font-variant-numeric: tabular-nums; font-size: calc(var(--px) * .36); }
  .hint { margin: .5rem 0 0; min-height: 1.4em; font-size: .9rem; color: rgba(255, 255, 255, .8); }
  .foot { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
  .foot :global(.spinner) { width: 18px; height: 18px; }
  .file { display: none; }
  .slot { min-height: 3rem; }
  .msg { display: flex; gap: .45rem; align-items: flex-start; margin: 0; overflow-wrap: anywhere; }
  .msg :global(svg) { flex: none; margin-top: .15rem; color: #ffbdbd; }
</style>
