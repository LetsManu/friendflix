<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Ordner* (spec "Subfolders", "Folder changes after the first run"): a breadcrumb browser one level at a time below the confirmed
   * base (names only; symlinks shown, never selectable; unreadable ones marked), and the chosen folders as rows with their library
   * name (1–60) and type (*Filme*, *Serien*, *Musik*, *Gemischt*). Removing a folder whose library exists asks first and says the
   * library stays; such kept libraries are listed with *Bibliothek löschen*, which counts the FriendFlix references first. Each row
   * keeps a note line from the start for its warning, the card's refusal (library_name_taken, library_referenced) or the Live TV
   * offer, and the browser list has a fixed height: nothing moves while a level loads or a note appears.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { apiCode } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { confirm } from '#lib/ui/confirm';
  import { toast } from '#lib/ui/toast';
  import type { BrowseEntry, FolderInput, LibraryEntry, LibraryType, MediaApi } from './api';
  import { MAX_FOLDERS, mediaErrorText } from './model';

  export let api: MediaApi;
  export let call: <T>(fn: () => Promise<T>) => Promise<T>;
  export let rows: FolderInput[];
  /** the libraries stored for this kind (a row's library exists in the server: removing it asks first) */
  export let libraries: LibraryEntry[] = [];
  /** libraries whose folder is no longer chosen (they stay in the server) */
  export let kept: LibraryEntry[] = [];
  /** per row (by rel): the card's refusal for it */
  export let rowErrors: Record<string, string> = {};
  /** the Live TV recordings offer (model.ts livetvOffer) */
  export let livetv: { rel: string; target: string } | null = null;
  export let disabled = false;
  const dispatch = createEventDispatcher<{ livetv: string; changed: void }>();

  const TYPES: LibraryType[] = ['movies', 'tvshows', 'music', 'mixed'];
  $: typeOptions = TYPES.map((v) => ({ value: v, label: $t(`mediaserver.folders.types.${v}`) }));
  /** the levels opened below the base */
  let trail: string[] = [];
  let entries: BrowseEntry[] = [], truncated = false, loading = false, browseError = '';
  /** the entries seen unreadable (their row warns) */
  let unreadable = new Set<string>();
  const relOf = (name: string) => [...trail, name].join('/');
  // a chosen folder is at most 3 levels below the base: open up to the second level, pick up to the third
  $: canOpen = trail.length < 2;
  $: canPick = trail.length < 3;

  async function browse(to: string[]) {
    loading = true; browseError = '';
    try {
      const r = await call(() => api.browse(to.join('/')));
      trail = to; entries = r.entries; truncated = r.truncated;
      for (const e of r.entries) if (e.unreadable) unreadable.add(to.concat(e.name).join('/'));
      unreadable = unreadable;
    } catch (e) {
      browseError = mediaErrorText(apiCode(e));
    } finally { loading = false; }
  }
  onMount(() => { void browse([]); });

  const picked = (rel: string) => rows.some((r) => r.rel === rel);
  function pick(e: BrowseEntry) {
    const rel = relOf(e.name);
    if (picked(rel) || rows.length >= MAX_FOLDERS) return;
    rows = [...rows, { rel, name: e.name.slice(0, 60), type: 'movies' }];
    dispatch('changed');
  }
  async function unpick(rel: string) {
    const row = rows.find((r) => r.rel === rel);
    const lib = libraries.find((l) => l.rel === rel && l.created);
    if (lib && !(await confirm({ title: tr('mediaserver.folders.removeTitle', { name: row?.name ?? lib.name }), body: tr('mediaserver.folders.removeBody'), confirmLabel: tr('mediaserver.folders.removeConfirm') }))) return;
    rows = rows.filter((r) => r.rel !== rel);
    dispatch('changed');
  }
  const edited = () => { rows = rows; dispatch('changed'); };

  let deleting = '';
  async function deleteLibrary(lib: LibraryEntry) {
    deleting = lib.slug;
    try {
      const { libraries: all } = await call(() => api.libraries());
      const refs = all.find((l) => l.slug === lib.slug)?.references ?? null;
      const body = refs ? tr('mediaserver.folders.deleteBody', { lists: refs.lists, resume: refs.resume, recordings: refs.recordings }) : tr('mediaserver.folders.deleteUnknown');
      if (!(await confirm({ title: tr('mediaserver.folders.deleteTitle', { name: lib.name }), body, danger: true, confirmLabel: tr('mediaserver.folders.deleteLibrary') }))) return;
      await call(() => api.deleteLibrary(lib.slug));
      toast.success(tr('mediaserver.folders.deleted'));
      dispatch('changed');
    } catch (e) {
      toast.error(mediaErrorText(apiCode(e)));
    } finally { deleting = ''; }
  }

  function note(rel: string): { text: string; tone: 'err' | 'warn' | 'offer' } | null {
    if (rowErrors[rel]) return { text: rowErrors[rel]!, tone: 'err' };
    if (unreadable.has(rel)) return { text: tr('mediaserver.folders.rowUnreadable'), tone: 'warn' };
    if (livetv?.rel === rel) return { text: tr('mediaserver.folders.livetv', { target: livetv.target }), tone: 'offer' };
    return null;
  }
</script>

<section class="sec" aria-labelledby="ms-folders-t">
  <h3 id="ms-folders-t"><Icon name="list" size={18} />{$t('mediaserver.folders.title')}</h3>
  <p class="muted small">{$t('mediaserver.folders.intro')}</p>

  <nav class="crumbs" aria-label={$t('mediaserver.folders.browser')}>
    <button type="button" class="crumb" disabled={disabled || loading || trail.length === 0} on:click={() => browse([])}>{$t('mediaserver.folders.root')}</button>
    {#each trail as part, i (i)}
      <span aria-hidden="true">/</span>
      <button type="button" class="crumb" aria-current={i === trail.length - 1 ? 'location' : undefined} disabled={disabled || loading || i === trail.length - 1} on:click={() => browse(trail.slice(0, i + 1))}>{part}</button>
    {/each}
  </nav>
  <!-- fixed height: a level loading, empty or long never moves what follows -->
  <div class="list" aria-busy={loading ? 'true' : undefined} data-testid="media-browser">
    {#if browseError}<p class="msg err" role="alert">{browseError}</p>
    {:else if loading && !entries.length}<p class="msg">{$t('mediaserver.folders.loading')}</p>
    {:else if !entries.length}<p class="msg">{$t('mediaserver.folders.empty')}</p>
    {:else}
      <ul>
        {#each entries as e (e.name)}
          {@const rel = relOf(e.name)}
          <li class:dim={e.symlink} data-entry={e.name}>
            {#if canOpen && !e.symlink && !e.unreadable}
              <button type="button" class="open" aria-label={$t('mediaserver.folders.open', { name: e.name })} disabled={disabled || loading} on:click={() => browse([...trail, e.name])}>
                <span class="nm">{e.name}</span><Icon name="chevron-right" size={16} />
              </button>
            {:else}<span class="nm plain">{e.name}</span>{/if}
            {#if e.symlink}<span class="tag">{$t('mediaserver.folders.symlink')}</span>
            {:else}
              {#if e.unreadable}<span class="tag warn">{$t('mediaserver.folders.unreadable')}</span>{/if}
              {#if canPick}
                <Button variant={picked(rel) ? 'glass' : 'secondary'} size="sm" icon={picked(rel) ? 'check' : 'plus'} disabled={disabled || picked(rel) || rows.length >= MAX_FOLDERS}
                  on:click={() => pick(e)}>{picked(rel) ? $t('mediaserver.folders.picked') : $t('mediaserver.folders.pick')}</Button>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <p class="muted tiny">{truncated ? $t('mediaserver.folders.truncated') : !canPick ? $t('mediaserver.folders.deepest') : ''}</p>

  <h4>{$t('mediaserver.folders.chosen')}</h4>
  {#if !rows.length}<p class="muted small">{$t('mediaserver.folders.none')}</p>{/if}
  <ul class="rows">
    {#each rows as r (r.rel)}
      {@const n = note(r.rel)}
      <li data-row={r.rel}>
        <code class="rel">{r.rel}</code>
        <div class="ctl">
          <Field label={$t('mediaserver.folders.name')} bind:value={r.name} maxlength={60} autocomplete="off" {disabled} on:input={edited} />
          <Select label={$t('mediaserver.folders.type')} bind:value={r.type} options={typeOptions} {disabled} on:change={edited} />
          <button type="button" class="rm" aria-label={$t('mediaserver.folders.remove', { name: r.name || r.rel })} {disabled} on:click={() => unpick(r.rel)}><Icon name="x" size={18} /></button>
        </div>
        <p class="note {n?.tone ?? ''}" role={n?.tone === 'err' ? 'alert' : undefined}>
          {#if n}{n.text}{#if n.tone === 'offer'} <Button variant="secondary" size="sm" {disabled} on:click={() => dispatch('livetv', livetv?.target ?? '')}>{$t('mediaserver.folders.livetvSave')}</Button>{/if}{/if}
        </p>
      </li>
    {/each}
  </ul>
  <p class="muted tiny">{$t('mediaserver.folders.watchHint')}</p>

  {#if kept.length}
    <h4>{$t('mediaserver.folders.kept')}</h4>
    <p class="muted small">{$t('mediaserver.folders.keptHint')}</p>
    <ul class="kept">
      {#each kept as k (k.slug)}
        <li><span>{k.name}</span><span class="muted tiny">{$t(`mediaserver.folders.types.${k.type}`)}</span>
          {#if api.scope === 'admin'}<Button variant="ghost" size="sm" pending={deleting === k.slug} {disabled} on:click={() => deleteLibrary(k)}>{$t('mediaserver.folders.deleteLibrary')}</Button>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .sec { display: grid; gap: .5rem; min-width: 0; }
  h3 { display: flex; align-items: center; gap: .45rem; margin: 0; font-size: 1rem; }
  h4 { margin: .4rem 0 0; font-size: .92rem; }
  .small { font-size: .88rem; margin: 0; }
  .tiny { font-size: .8rem; margin: 0; min-height: 1.3em; }
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem; min-width: 0; }
  .crumb { min-height: 44px; padding: 0 .5rem; background: transparent; color: var(--acc-text); font-weight: 600; border-radius: var(--fr-r-card); max-width: 100%; overflow-wrap: anywhere; }
  .crumb:disabled { color: var(--fg); opacity: 1; cursor: default; }
  .crumb:hover:not(:disabled) { background: rgba(255, 255, 255, .06); }
  .list { height: 15rem; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--fr-r-card); background: rgba(255, 255, 255, .03); }
  .list ul { list-style: none; margin: 0; padding: .2rem; display: grid; }
  .list li { display: flex; align-items: center; gap: .4rem; min-height: 44px; padding: 0 .3rem; border-radius: 8px; }
  .list li + li { border-top: 1px solid var(--line); }
  .dim { color: var(--mut); }
  .open { flex: 1 1 auto; min-width: 0; min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: .4rem; padding: 0 .4rem; background: transparent; color: inherit; font-weight: 500; border-radius: 8px; text-align: left; }
  .open:hover:not(:disabled) { background: rgba(255, 255, 255, .06); }
  .nm { min-width: 0; overflow-wrap: anywhere; }
  .plain { flex: 1 1 auto; padding: 0 .4rem; }
  .tag { flex: none; font-size: .78rem; color: var(--mut); }
  .tag.warn { color: var(--warn); }
  .msg { margin: 0; padding: .8rem; color: var(--mut); }
  .msg.err { color: var(--err-mark); }
  .rows, .kept { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  .rows li { display: grid; gap: .3rem; padding: .5rem .6rem; border-radius: var(--fr-r-card); border: 1px solid var(--line); min-width: 0; }
  .rel { font-size: .85rem; color: var(--mut); overflow-wrap: anywhere; }
  .ctl { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 44px; align-items: end; gap: .5rem; }
  .rm { width: 44px; height: 44px; padding: 0; background: transparent; color: var(--mut); border-radius: 50%; }
  .rm:hover:not(:disabled) { background: rgba(255, 255, 255, .08); color: var(--fg); }
  .note { margin: 0; min-height: 44px; font-size: .85rem; color: var(--mut); display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
  .note.err { color: var(--err-mark); }
  .note.warn { color: var(--warn); }
  .kept li { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .8rem; }
  @media (max-width: 560px) { .ctl { grid-template-columns: minmax(0, 1fr) 44px; } .ctl :global(.field:nth-child(2)) { grid-column: 1; } }
</style>
