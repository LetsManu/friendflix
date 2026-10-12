<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { addToList, createList, itemLists, removeFromList, type PickerList } from '#lib/lists';

  /** Jellyfin id of the movie / series to add (episodes are normalised server-side). */
  export let itemId: string;
  /** compact round button (Card / modal) or the larger detail-page icon button */
  export let variant: 'round' | 'ring' | 'row' = 'ring';
  /** open the picker above the button (used inside the bottom action sheet) */
  export let up = false;
  /** diameter of the round variant in px */
  export let size = 34;

  let open = false, lists: PickerList[] | null = null, err = '', creating = false, newName = '', busy = false;
  let root: HTMLElement, btn: HTMLButtonElement;

  async function load() {
    err = '';
    try { lists = await itemLists(itemId); } catch { lists = []; err = 'Listen konnten nicht geladen werden.'; }
  }
  function toggleOpen() {
    open = !open;
    if (open) { lists = null; creating = false; newName = ''; load(); }
  }
  async function toggle(l: PickerList) {
    const was = l.contains;
    l.contains = !was; lists = lists;
    try { await (was ? removeFromList(l.id, itemId) : addToList(l.id, itemId)); }
    catch (e: any) {
      if (!was && e?.status === 409 && e.body?.error === 'exists') return; // already in there
      l.contains = was; lists = lists;
      err = e?.body?.error === 'list_full' ? 'Die Liste ist voll.' : 'Das hat nicht geklappt.';
    }
  }
  async function create() {
    const name = newName.trim();
    if (!name || busy) return;
    busy = true; err = '';
    try {
      const { id } = await createList(name);
      await addToList(id, itemId);
      newName = ''; creating = false;
      await load();
    } catch (e: any) { err = e?.body?.error === 'too_many_lists' ? 'Du hast schon 20 Listen.' : 'Das hat nicht geklappt.'; }
    busy = false;
  }
  function close(refocus = false) { open = false; if (refocus) btn?.focus(); }
  function onKey(e: KeyboardEvent) { if (open && e.key === 'Escape') { e.stopPropagation(); close(true); } }
  function onDoc(e: Event) { if (open && root && !root.contains(e.target as Node)) close(); }
  if (typeof document !== 'undefined') { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey, true); }
  onDestroy(() => { if (typeof document !== 'undefined') { document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); } });
</script>

<span class="lm" class:blk={variant === 'row'} bind:this={root}>
  <button bind:this={btn} class={variant === 'ring' ? 'icon-btn ring' : variant === 'row' ? 'rowbtn' : 'round'} class:on={open} aria-haspopup="true" aria-expanded={open} style={variant === 'round' ? `width:${size}px;height:${size}px;min-height:${size}px` : undefined} aria-label="Zu Liste hinzufügen" title="Zu Liste hinzufügen" on:click|stopPropagation={toggleOpen}>
    <Icon name="list" size={variant === 'ring' ? 21 : 18} />{#if variant === 'row'}<span>Zu Liste hinzufügen …</span>{/if}
  </button>
  {#if open}
    <div class="pop" class:up class:wide={variant === 'row'} role="dialog" aria-label="Zu Liste hinzufügen">
      {#if lists === null}<p class="muted">Lade …</p>
      {:else}
        {#if !lists.length}<p class="muted">Noch keine Liste, in die du etwas legen darfst.</p>{/if}
        <ul>
          {#each lists as l (l.id)}
            <li><label><input type="checkbox" checked={l.contains} on:change={() => toggle(l)} /><span>{l.name}</span></label></li>
          {/each}
        </ul>
        {#if creating}
          <form on:submit|preventDefault={create}>
            <!-- svelte-ignore a11y_autofocus -->
            <input type="text" maxlength="60" placeholder="Name der neuen Liste" aria-label="Name der neuen Liste" bind:value={newName} autofocus />
            <button class="sec" type="submit" disabled={busy || !newName.trim()}>Anlegen</button>
          </form>
        {:else}<button class="new" type="button" on:click={() => (creating = true)}><Icon name="plus" size={16} />Neue Liste …</button>{/if}
        {#if err}<p class="err" role="alert">{err}</p>{/if}
      {/if}
    </div>
  {/if}
</span>

<style>
  .lm { position: relative; display: inline-block; }
  .blk { display: block; }
  .rowbtn { display: flex; gap: .8rem; align-items: center; width: 100%; min-height: 48px; padding: 0 1rem; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; }
  .rowbtn:hover:not(:disabled), .rowbtn.on { background: rgba(255,255,255,.08); }
  .pop.up { top: auto; bottom: calc(100% + .4rem); }
  .pop.wide { left: 0; right: 0; max-width: none; }
  .round { width: 34px; min-height: 34px; height: 34px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); color: #fff; display: grid; place-items: center; }
  .round:hover:not(:disabled) { border-color: #fff; background: rgba(42,42,42,.9); }
  .pop { position: absolute; z-index: 30; left: 0; top: calc(100% + .4rem); min-width: 230px; max-width: 80vw; background: var(--surface); color: var(--fg, #fff); border: 1px solid rgba(255,255,255,.18); border-radius: var(--radius); padding: .6rem .7rem; box-shadow: 0 14px 28px rgba(0,0,0,.6); text-align: left; font-size: .9rem; font-weight: 400; }
  ul { list-style: none; margin: 0 0 .4rem; padding: 0; max-height: 220px; overflow: auto; }
  label { display: flex; gap: .55rem; align-items: center; padding: .3rem 0; cursor: pointer; }
  .new { display: flex; gap: .4rem; align-items: center; background: none; border: 0; color: inherit; padding: .3rem 0; min-height: 0; cursor: pointer; }
  form { display: flex; gap: .4rem; }
  form input { flex: 1; min-width: 0; }
  .muted { color: var(--mut); margin: 0 0 .4rem; }
  .err { color: var(--err, #e5646e); margin: .4rem 0 0; }
</style>
