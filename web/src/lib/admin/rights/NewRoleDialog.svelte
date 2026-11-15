<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Neue Rolle* (roles redesign §5.2): the name (1 to 30 characters, the role write's bounds), then where the role starts — a radio
   * list of the server's templates (Familie, Freund, Gast, Nur Live-TV while Live TV is installed, Leer), each a ≥ 56 px row with its
   * title and, on one line, the areas it starts with, and *Kopie von …* with a role select. The select sits at the end of the copy's
   * row, always laid out (unseen until the copy is picked), so the dialog never changes its height and nothing stands empty between
   * the options and the buttons. *Duplizieren* opens it with the copy of its role picked (`from`).
   * `submit` carries the POST body (newRole.ts); the page creates the role (`busy`, `error` come back) and opens its page. The
   * server's refusal is the dialog's status line above the buttons (reserved, `.dlg-err`), not the name's error. Picking the copy
   * scrolls its select into view (short screens).
   * A modal dialog (ModalShell): the name starts focused, Tab stays inside, Escape or the dimmed page cancels.
   *   <NewRoleDialog {matrix} from="family" {busy} {error} {trigger} on:submit={(e) => create(e.detail)} on:cancel={close} />
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { locale, t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { uid } from '#lib/ui/ids';
  import { roleName, type RoleMatrix } from './model';
  import { createBody, firstStart, startOptions, type CreateBody, type StartKey } from './newRole';

  export let matrix: RoleMatrix;
  /** the role a copy starts from; set: *Duplizieren* (the copy is picked) */
  export let from = '';
  export let busy = false;
  export let error = '';
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ submit: CreateBody; cancel: void }>();
  const id = uid('nr');
  let name = '', tried = false, shell: ModalShell;
  let start: StartKey = firstStart(matrix, from);
  let source = from || (matrix.roles.find((r) => r.key === 'family') ?? matrix.roles.find((r) => r.base !== 'admin') ?? matrix.roles[0])?.key || '';
  $: clean = name.trim();
  $: bad = tried && (clean.length < 1 || clean.length > 30) ? $t('adminPeople.roles.errLabel') : '';
  /** `_l`: the language, so a switch re-renders the titles and lines */
  const optionsOf = (m: RoleMatrix, src: string, _l: unknown) => startOptions(m, src);
  $: options = optionsOf(matrix, source, $locale);
  // a start point the server no longer lists (Live TV taken away meanwhile): back to the first one
  $: if (!options.some((o) => o.key === start)) start = firstStart(matrix);
  $: sources = matrix.roles.map((r) => ({ value: r.key, label: roleName(r) }));
  $: copying = start === 'copy';
  /** the copy picked by the person: its select (below the fold on a phone) comes into view */
  let srcRow: HTMLElement;
  async function picked(k: StartKey) {
    if (k !== 'copy') return;
    await tick();
    srcRow?.scrollIntoView({ block: 'nearest' });
  }

  function cancel() { if (!busy) dispatch('cancel'); }
  function submit() {
    tried = true;
    if (busy || clean.length < 1 || clean.length > 30 || (copying && !source)) return;
    dispatch('submit', createBody(clean, start, source));
  }
</script>

<ModalShell bind:this={shell} labelledby="{id}-t" focus="input" width={480} {trigger} locked={busy} on:close={cancel}>
  <form on:submit|preventDefault={submit}>
    <h2 id="{id}-t" class="dlg-title">{$t('adminPeople.roles.new.title')}</h2>
    <Field label={$t('adminPeople.roles.fLabel')} bind:value={name} maxlength={30} error={bad} disabled={busy} autocomplete="off" />
    <fieldset class="starts" disabled={busy}>
      <legend>{$t('adminPeople.roles.new.startFrom')}</legend>
      {#each options as o (o.key)}
        <div class="row" class:copy={o.key === 'copy'}>
          <label class="opt" class:on={start === o.key}>
            <input type="radio" name="{id}-start" value={o.key} bind:group={start} on:change={() => void picked(o.key)} aria-labelledby="{id}-{o.key}-t" aria-describedby={o.desc ? `${id}-${o.key}-d` : undefined} />
            <span class="tx">
              <span class="ti" id="{id}-{o.key}-t">{o.title}</span>
              <span class="de" id="{id}-{o.key}-d">{o.desc}</span>
            </span>
          </label>
          {#if o.key === 'copy'}
            <!-- the copy's select, at the end of its row: always laid out (unseen until the copy is picked), so nothing moves -->
            <div class="src" bind:this={srcRow} class:shown={copying} aria-hidden={copying ? undefined : 'true'} inert={!copying}>
              <Select label={$t('adminPeople.roles.new.copyFrom')} hideLabel options={sources} bind:value={source} disabled={busy || !copying} />
            </div>
          {/if}
        </div>
      {/each}
    </fieldset>
    <!-- the server's refusal (a template gone, a name taken): its line is always there, so the buttons never move -->
    <p class="dlg-err" role="alert">{error}</p>
    <div class="dlg-acts">
      <Button variant="glass" disabled={busy} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" pending={busy}>{$t('adminPeople.roles.create')}</Button>
    </div>
  </form>
</ModalShell>

<style>
  form { min-width: 0; }
  form > :global(.field) { margin-top: 4px; }
  .starts { border: 0; margin: 16px 0 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  legend { padding: 0; margin-bottom: 8px; font-size: .95rem; color: var(--fg); }
  .row { position: relative; min-width: 0; }
  /* an option (the mockup): a ≥ 56 px row, the whole row picks it; the picked one a light glass row; the ring goes around the row */
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
  /* one line: a long area line ends in "…" (the full line is the radio's description); nothing moves when it changes */
  .de { margin-top: 2px; font-size: 13px; line-height: 1.35; color: #b3bac2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .de:empty { display: none; }
  /* the copy's row keeps room at its end for the select */
  .copy { --src-w: min(180px, 46%); }
  .copy .opt { padding-right: calc(var(--src-w) + 20px); }
  .src { position: absolute; top: 0; bottom: 0; right: 8px; width: var(--src-w); display: flex; align-items: center; scroll-margin-bottom: 8px;
    visibility: hidden; opacity: 0; transition: opacity 150ms var(--fr-out, ease-out); }
  .src > :global(.field) { width: 100%; }
  .src.shown { visibility: visible; opacity: 1; }
  :global(html.m-still) .src { transition: none; }
  @media (prefers-reduced-motion: reduce) { .src { transition: none; } }
</style>
