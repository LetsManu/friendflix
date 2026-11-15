<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Neue Rolle* (roles redesign §5.2): the name (1 to 30 characters, the role write's bounds), then where the role starts — a radio
   * list of the server's templates (Familie, Freund, Gast, Nur Live-TV while Live TV is installed, Leer), each a ≥ 56 px row with its
   * title and the areas it starts with, and *Kopie von …* with a role select. The select's row is always laid out (unseen until the
   * copy is picked), so the dialog never changes its height. *Duplizieren* opens it with the copy of its role picked (`from`).
   * `submit` carries the POST body (newRole.ts); the page creates the role (`busy`, `error` come back) and opens its page.
   * A modal dialog (ModalShell): the name starts focused, Tab stays inside, Escape or the dimmed page cancels.
   *   <NewRoleDialog {matrix} from="family" {busy} {error} {trigger} on:submit={(e) => create(e.detail)} on:cancel={close} />
   */
  import { createEventDispatcher } from 'svelte';
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

  function cancel() { if (!busy) dispatch('cancel'); }
  function submit() {
    tried = true;
    if (busy || clean.length < 1 || clean.length > 30 || (copying && !source)) return;
    dispatch('submit', createBody(clean, start, source));
  }
</script>

<ModalShell bind:this={shell} labelledby="{id}-t" focus="input" {trigger} locked={busy} on:close={cancel}>
  <form on:submit|preventDefault={submit}>
    <h2 id="{id}-t">{$t('adminPeople.roles.new.title')}</h2>
    <div class="body">
      <Field label={$t('adminPeople.roles.fLabel')} bind:value={name} maxlength={30} error={bad || error} disabled={busy} autocomplete="off" />
      <fieldset class="starts" disabled={busy}>
        <legend>{$t('adminPeople.roles.new.startFrom')}</legend>
        {#each options as o (o.key)}
          <label class="opt" class:on={start === o.key}>
            <input type="radio" name="{id}-start" value={o.key} bind:group={start} aria-labelledby="{id}-{o.key}-t" aria-describedby={o.desc ? `${id}-${o.key}-d` : undefined} />
            <span class="tx">
              <span class="ti" id="{id}-{o.key}-t">{o.title}</span>
              <span class="de" id="{id}-{o.key}-d">{o.desc}</span>
            </span>
          </label>
        {/each}
      </fieldset>
      <!-- the select's row is always there (unseen until the copy is picked): the dialog keeps its height -->
      <div class="src" class:shown={copying} aria-hidden={copying ? undefined : 'true'} inert={!copying}>
        <Select label={$t('adminPeople.roles.new.copyFrom')} options={sources} bind:value={source} disabled={busy || !copying} />
      </div>
    </div>
    <div class="acts">
      <Button variant="ghost" disabled={busy} on:click={() => shell.dismiss()}>{$t('common.cancel')}</Button>
      <Button type="submit" pending={busy}>{$t('adminPeople.roles.create')}</Button>
    </div>
  </form>
</ModalShell>

<style>
  h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
  /* the content scrolls inside the dialog on short screens; the title and the buttons stay */
  .body { max-height: calc(100dvh - 14rem); overflow-y: auto; margin: 0 -.4rem; padding: 0 .4rem; overscroll-behavior: contain; }
  .body > :global(.field) { margin-top: 1rem; }
  .starts { border: 0; margin: 1rem 0 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: .35rem; }
  legend { padding: 0; margin-bottom: .45rem; font-size: .95rem; color: var(--fg); }
  /* an option: a ≥ 56 px row, the whole row picks it; the ring goes around the row */
  .opt { display: flex; align-items: center; gap: .8rem; min-height: 56px; box-sizing: border-box; padding: .45rem .8rem; border-radius: 12px; cursor: pointer;
    background: rgba(255, 255, 255, .04); box-shadow: inset 0 0 0 1px #323a43; }
  .opt:hover { background: rgba(255, 255, 255, .07); }
  .opt.on { background: rgba(255, 79, 109, .12); box-shadow: inset 0 0 0 1.5px var(--acc); }
  .opt:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; }
  .opt input { width: 20px; height: 20px; margin: 0; flex: none; accent-color: var(--acc); outline: none; }
  .tx { min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
  .ti { font-weight: 700; }
  /* one line: a long area line ends in "…" instead of growing the row (nothing moves when the copied role changes) */
  .de { font-size: .84rem; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.3em; }
  .src { margin-top: .6rem; visibility: hidden; opacity: 0; transition: opacity 150ms var(--fr-out, ease-out); }
  .src.shown { visibility: visible; opacity: 1; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.2rem; flex-wrap: wrap; }
  /* phones: the buttons stack (full width), the content takes their room from the scroller */
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts :global(.ui-btn) { width: 100%; } .body { max-height: calc(100dvh - 18rem); } }
  :global(html.m-still) .src { transition: none; }
  @media (prefers-reduced-motion: reduce) { .src { transition: none; } }
</style>
