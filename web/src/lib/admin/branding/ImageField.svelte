<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One upload of Admin → Branding (the mockup's dashed `.drop` row): a thumbnail of the staged image (or a stand-in), the title and
   * help, *Hochladen* (a hidden file input: PNG, JPEG or WebP; the page prepares and uploads the file) and *Entfernen*. The status line
   * under it (working, uploaded, or what went wrong) keeps its room, so nothing moves.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { PICK_TYPES, type BrandImageKind } from './imageResize';

  export let kind: BrandImageKind;
  export let title: string;
  export let help: string;
  /** the staged image's URL (null: none staged) */
  export let url: string | null;
  export let busy = false;
  /** the status line: a note, or an error (`error` true) */
  export let status = '';
  export let error = false;
  /** the thumbnail's shape: wide (the logo, the sign-in image) or square (the symbol) */
  export let wide = false;
  /** the id of *Hochladen* (the page focuses it when the server names this image) */
  export let uploadId: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ pick: File; remove: void }>();
  let input: HTMLInputElement | undefined;

  function picked() {
    const f = input?.files?.[0];
    if (input) input.value = ''; // the same file may be chosen again
    if (f) dispatch('pick', f);
  }
</script>

<div class="img" role="group" aria-label={title}>
  <div class="drop">
    <span class="thumb" class:wide>
      {#if url}<img src={url} alt="" draggable="false" />{:else}<slot name="empty"><Icon name="image" size={22} /></slot>{/if}
    </span>
    <span class="txt"><b>{title}</b><span class="help">{help}</span></span>
    <span class="acts">
      <Button id={uploadId} variant="secondary" size="sm" icon="arrow-up" pending={busy} aria-label={$t('admin.branding.logo.uploadA11y', { what: title })} on:click={() => input?.click()}>{$t('admin.branding.logo.upload')}</Button>
      <!-- always there (disabled without an image): the row never changes width -->
      <Button variant="ghost" size="sm" disabled={busy || !url} aria-label={$t('admin.branding.logo.removeA11y', { what: title })} on:click={() => dispatch('remove')}>{$t('admin.branding.logo.remove')}</Button>
    </span>
    <input bind:this={input} class="file" type="file" data-kind={kind} accept={PICK_TYPES.join(',')} tabindex="-1" aria-hidden="true" on:change={picked} />
  </div>
  <p class="status" aria-live="polite">{#if status}<span class:err={error}>{#if error}<Icon name="alert" size={16} />{/if}{status}</span>{/if}</p>
</div>

<style>
  .img { min-width: 0; }
  /* the buttons under the text (the form column is narrow beside the preview): thumbnail | title, help / buttons */
  .drop { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-areas: 'thumb txt' 'thumb acts'; gap: 10px 14px; align-items: center; min-height: 72px; padding: 12px 14px;
    border-radius: 16px; border: 1px dashed rgba(255, 255, 255, .28); background: rgba(0, 0, 0, .18); }
  .thumb { grid-area: thumb; align-self: start; width: 56px; height: 56px; border-radius: 14px; overflow: hidden; display: grid; place-items: center; background: rgba(255, 255, 255, .08); color: rgba(255, 255, 255, .8); }
  .thumb.wide { width: 96px; height: 56px; border-radius: 10px; }
  .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .txt { grid-area: txt; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .txt b { font-size: .95rem; }
  .help { font-size: .85rem; color: rgba(255, 255, 255, .78); line-height: 1.4; }
  .acts { grid-area: acts; display: flex; flex-wrap: wrap; gap: 8px; }
  .file { display: none; }
  .status { margin: .35rem 0 0; min-height: 2.6em; font-size: .85rem; color: rgba(255, 255, 255, .8); }
  .status span { display: inline-flex; gap: .4rem; align-items: flex-start; }
  .status .err { color: var(--err); font-weight: 600; }
  .status :global(svg) { flex: none; margin-top: .1rem; }
</style>
