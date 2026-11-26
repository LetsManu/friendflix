<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Neu einlesen* (admins; lib/detail/rescan.ts): the three modes of Jellyfin's own refresh dialog as a radio group of ≥ 56 px rows
   * (title + one line on what it does), a line on what it covers (film / whole series / this season), the reserved status line and
   * Abbrechen / Neu einlesen. *Alle Metadaten und Bilder ersetzen* asks first (the shared confirm, above this dialog). A started rescan
   * closes the dialog and says so in a toast; a refusal stays in the status line. A modal dialog (ModalShell): the picked mode starts
   * focused, arrow keys move inside the group, Escape or the dimmed page cancels, the focus goes back to what opened it.
   *   {#if open}<RescanDialog id={item.id} name={item.name} type="Series" on:close={() => (open = false)} />{/if}
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import { uid } from '#lib/ui/ids';
  import { RESCAN_MODES, startRescan, type RescanMode } from './rescan';

  export let id: string;
  /** what the title line, the question and the toast call it ("Bright Valley", "Bright Valley · Staffel 1") */
  export let name: string;
  export let type: 'Movie' | 'Series' | 'Season';

  const dispatch = createEventDispatcher<{ close: void }>();
  const key = uid('rs');
  /** the control that opened the dialog (the ⋯ trigger or the season button) gets the focus back */
  const trigger = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
  let mode: RescanMode = 'scan', busy = false, error = '', shell: ModalShell;
  $: texts = {
    scan: { title: $t('detail.rescan.scan'), hint: $t('detail.rescan.scanHint') },
    missing: { title: $t('detail.rescan.missing'), hint: $t('detail.rescan.missingHint') },
    replace: { title: $t('detail.rescan.replace'), hint: $t('detail.rescan.replaceHint') },
  } satisfies Record<RescanMode, { title: string; hint: string }>;
  $: note = type === 'Series' ? $t('detail.rescan.seriesNote') : type === 'Season' ? $t('detail.rescan.seasonNote') : $t('detail.rescan.movieNote');

  async function submit() {
    if (busy) return;
    busy = true; error = '';
    const r = await startRescan({ id, mode, name });
    busy = false;
    if (r === 'done') shell.dismiss();
    else if (r !== 'cancelled') error = r.error;
  }
</script>

<ModalShell bind:this={shell} labelledby="{key}-t" describedby="{key}-n" focus="input:checked" width={480} {trigger} locked={busy} on:close={() => dispatch('close')}>
  <form on:submit|preventDefault={submit}>
    <h2 id="{key}-t" class="dlg-title">{$t('detail.rescan.title')}</h2>
    <div class="dlg-main">
      <p class="dlg-body nm">{name}</p>
      <p class="dlg-body note" id="{key}-n">{note}</p>
      <fieldset class="modes" disabled={busy}>
        <legend>{$t('detail.rescan.modes')}</legend>
        {#each RESCAN_MODES as m (m)}
          <label class="opt" class:on={mode === m}>
            <input type="radio" name="{key}-mode" value={m} bind:group={mode} aria-describedby="{key}-{m}-d" />
            <span class="tx">
              <span class="ti">{texts[m].title}</span>
              <span class="de" id="{key}-{m}-d">{texts[m].hint}</span>
            </span>
          </label>
        {/each}
      </fieldset>
    </div>
    <!-- the server's refusal: its line is always there, so the buttons never move -->
    <p class="dlg-err" role="alert">{error}</p>
    <div class="dlg-acts">
      <Button variant="glass" disabled={busy} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" pending={busy}>{$t('detail.rescan.start')}</Button>
    </div>
  </form>
</ModalShell>

<style>
  form { min-width: 0; }
  .nm { font-weight: 700; color: var(--fg); }
  .note { margin-top: 4px; font-size: 14px; }
  .modes { border: 0; margin: 16px 0 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  legend { padding: 0; margin-bottom: 8px; font-size: .95rem; color: var(--fg); }
  /* a mode: a ≥ 56 px row, the whole row picks it; the picked one a light glass row; the ring goes around the row */
  .opt { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; align-items: start; min-height: 56px; box-sizing: border-box; padding: 10px 12px;
    border-radius: 14px; border: 1px solid transparent; background: transparent; color: #f5f5f5; cursor: pointer; }
  .opt:hover { background: rgba(255, 255, 255, .05); }
  .opt.on { background: rgba(255, 255, 255, .08); border-color: rgba(255, 255, 255, .18); }
  .opt:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; }
  /* the radio: a grey ring, coral with a dot when picked */
  .opt input { appearance: none; -webkit-appearance: none; width: 18px; height: 18px; min-height: 0; margin: 2px 2px 0; padding: 0; flex: none; border: 2px solid #8f98a2; border-radius: 50%;
    background: transparent; outline: none; box-shadow: none; cursor: pointer; }
  .opt input:hover { border-color: #b3bac2; }
  .opt input:checked { border-color: var(--acc-light); background: radial-gradient(circle, var(--acc-light) 0 4px, transparent 4.5px); }
  .tx { min-width: 0; display: flex; flex-direction: column; }
  .ti { font-size: 15px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
  .de { margin-top: 2px; font-size: 13px; line-height: 1.35; color: #b3bac2; overflow-wrap: anywhere; }
</style>
