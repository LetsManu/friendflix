<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Protokoll* (spec "Admin and wizard"): the media server's last 300 log lines, fetched when the dialog opens and never stored. The
   * updater strips ANSI codes, cuts lines at 500 characters and replaces keys, tokens and passwords with "…"; the lines are shown as
   * text, never as markup. *Kopieren* puts them on the clipboard. The list box has a fixed height from the start.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { apiCode } from '#lib/api';
  import { t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import { toast } from '#lib/ui/toast';
  import { uid } from '#lib/ui/ids';
  import type { MediaApi } from './api';
  import { mediaErrorText } from './model';

  export let api: MediaApi;
  export let call: <T>(fn: () => Promise<T>) => Promise<T>;
  export let trigger: HTMLElement | null = null;
  const dispatch = createEventDispatcher<{ close: void }>();
  const id = uid('mslog');
  const TAIL = 300;

  let lines: string[] | null = null, error = '', shell: ModalShell;
  onMount(async () => {
    try {
      lines = (await call(() => api.logs(TAIL))).lines;
    } catch (e) {
      error = mediaErrorText(apiCode(e));
    }
  });
  async function copy() {
    try {
      await navigator.clipboard.writeText((lines ?? []).join('\n'));
      toast.success(tr('mediaserver.logs.copied'));
    } catch {
      toast.error(tr('mediaserver.logs.copyFailed'));
    }
  }
</script>

<ModalShell bind:this={shell} labelledby="{id}-t" describedby="{id}-d" width={760} {trigger} on:close={() => dispatch('close')}>
  <form on:submit|preventDefault={copy}>
    <h2 id="{id}-t" class="dlg-title">{$t('mediaserver.logs.title')}</h2>
    <p id="{id}-d" class="dlg-body">{$t('mediaserver.logs.intro')}</p>
    <div class="dlg-main">
      <!-- a scrolling box: keyboard users reach it to scroll (axe scrollable-region-focusable) -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre class="log" data-testid="media-log" tabindex="0" aria-label={$t('mediaserver.logs.title')}>{#if error}{''}{:else if lines === null}{$t('mediaserver.logs.loading')}{:else if !lines.length}{$t('mediaserver.logs.empty')}{:else}{lines.join('\n')}{/if}</pre>
    </div>
    <p class="dlg-err" role={error ? 'alert' : undefined}>{error}</p>
    <div class="dlg-acts">
      <Button variant="glass" on:click={() => shell.dismiss()}>{$t('common.close')}</Button>
      <Button type="submit" icon="copy" disabled={!lines?.length}>{$t('mediaserver.logs.copy')}</Button>
    </div>
  </form>
</ModalShell>

<style>
  .log { margin: 8px 0 0; height: min(50vh, 26rem); overflow: auto; padding: .7rem .8rem; border-radius: var(--fr-r-card); background: rgba(0, 0, 0, .35); border: 1px solid var(--line);
    font-size: .8rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; color: #d7dbe0; }
</style>
