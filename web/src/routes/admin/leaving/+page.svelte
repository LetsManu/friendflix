<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import { fmtDate, t, tr } from '#lib/i18n';

  /** Admin: titles with a removal date ("Bald nicht mehr verfügbar"). Setting a date deletes nothing on the media server. */
  interface Row { itemId: string; name: string | null; type: string | null; year: number | null; leavesAt: string; days: number; note: string | null; setBy: string | null }
  let rows: Row[] | null = null, err = '', msg = '', busy = '';
  // pick a title to add
  let q = '', hits: Array<{ id: string; name: string; type: string; year?: number }> = [], searching = false, picked: { id: string; name: string } | null = null, newDate = '', newNote = '', seq = 0, searchT: ReturnType<typeof setTimeout>;
  const draft: Record<string, { date: string; note: string }> = {};
  const local = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y!, m! - 1, d); };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  async function load() {
    try {
      rows = (await api('/api/admin/leaving')).items as Row[];
      for (const r of rows) draft[r.itemId] = { date: r.leavesAt, note: r.note ?? '' };
      err = '';
    } catch { err = tr('fresh.admin.loadFailed'); rows = rows ?? []; }
  }
  onMount(load);

  function search() {
    clearTimeout(searchT);
    const term = q.trim();
    if (term.length < 2) { hits = []; searching = false; return; }
    searching = true;
    const my = ++seq;
    searchT = setTimeout(async () => {
      try {
        const r = await api(`/api/library/items?${new URLSearchParams({ q: term, types: 'Movie,Series', limit: '8' })}`);
        if (my === seq) hits = r.items;
      } catch { if (my === seq) hits = []; }
      if (my === seq) searching = false;
    }, 250);
  }
  async function put(id: string, date: string, note: string) {
    busy = id; msg = ''; err = '';
    try {
      await api(`/api/admin/leaving/${id}`, { method: 'PUT', body: { leavesAt: date, note: note.trim() || null } });
      msg = tr('fresh.admin.saved');
      await load();
      return true;
    } catch (e) {
      err = (e as { body?: { error?: string } })?.body?.error === 'date_out_of_range' ? tr('fresh.admin.dateRange') : tr('fresh.admin.saveFailed');
      return false;
    } finally { busy = ''; }
  }
  async function add() {
    if (!picked || !newDate) return;
    if (await put(picked.id, newDate, newNote)) { picked = null; newDate = ''; newNote = ''; q = ''; hits = []; }
  }
  async function remove(id: string) {
    busy = id; msg = ''; err = '';
    try { await api(`/api/admin/leaving/${id}`, { method: 'DELETE' }); msg = tr('fresh.admin.cleared'); await load(); } catch { err = tr('fresh.admin.saveFailed'); }
    busy = '';
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('fresh.admin.title') })}</title></svelte:head>
<h2>{$t('fresh.admin.title')}</h2>
<p class="muted">{$t('fresh.admin.intro')}</p>

<form class="panel add" on:submit|preventDefault={add}>
  <h3>{$t('fresh.admin.addTitle')}</h3>
  {#if picked}
    <p class="picked"><b>{picked.name}</b> <button type="button" class="sec" on:click={() => { picked = null; }}>{$t('fresh.admin.change')}</button></p>
    <div class="grid">
      <label>{$t('fresh.admin.date')}<input type="date" bind:value={newDate} min={today()} required /></label>
      <label>{$t('fresh.admin.note')}<input type="text" bind:value={newNote} maxlength="200" placeholder={$t('fresh.admin.notePlaceholder')} /></label>
    </div>
    <div class="flex"><button disabled={!newDate || busy !== ''}>{$t('fresh.admin.save')}</button></div>
  {:else}
    <label>{$t('fresh.admin.search')}<input type="search" bind:value={q} on:input={search} placeholder={$t('fresh.admin.searchPlaceholder')} autocomplete="off" /></label>
    {#if hits.length}
      <ul class="hits" aria-label={$t('fresh.admin.results')}>
        {#each hits as h (h.id)}<li><button type="button" class="hit" on:click={() => { picked = { id: h.id, name: h.name }; hits = []; }}>{h.name}{#if h.year} <span class="muted">({h.year})</span>{/if}</button></li>{/each}
      </ul>
    {:else if q.trim().length >= 2 && !searching}<p class="muted">{$t('fresh.admin.noHits')}</p>{/if}
  {/if}
</form>

<div role="status" class="st">{#if msg}<span class="ok">{msg}</span>{/if}</div>
{#if err}<p class="err" role="alert">{err}</p>{/if}

{#if rows === null}
  <div class="skeleton" style="height:4rem"></div>
{:else if !rows.length}
  <p class="muted">{$t('fresh.admin.empty')}</p>
{:else}
  <div class="scroll">
    <table>
      <thead><tr><th>{$t('fresh.admin.colTitle')}</th><th>{$t('fresh.admin.date')}</th><th>{$t('fresh.admin.note')}</th><th>{$t('fresh.admin.colSetBy')}</th><th></th></tr></thead>
      <tbody>
        {#each rows as r (r.itemId)}
          <tr>
            <td><a href="/item/{r.itemId}">{r.name ?? r.itemId.slice(0, 8)}</a>{#if r.year} <span class="muted">({r.year})</span>{/if}<br /><small class="muted">{$t(r.days === 0 ? 'fresh.leaving.today' : 'fresh.leaving.days', { n: r.days })} · {fmtDate(local(r.leavesAt))}</small></td>
            <td><input type="date" aria-label={$t('fresh.admin.date')} bind:value={draft[r.itemId]!.date} min={today()} /></td>
            <td><input type="text" aria-label={$t('fresh.admin.note')} bind:value={draft[r.itemId]!.note} maxlength="200" /></td>
            <td class="muted">{r.setBy ?? ''}</td>
            <td class="flex">
              <button type="button" disabled={busy === r.itemId || !draft[r.itemId]?.date || (draft[r.itemId]?.date === r.leavesAt && (draft[r.itemId]?.note ?? '') === (r.note ?? ''))} on:click={() => put(r.itemId, draft[r.itemId]!.date, draft[r.itemId]!.note)}>{$t('fresh.admin.save')}</button>
              <button type="button" class="sec" disabled={busy === r.itemId} on:click={() => remove(r.itemId)}>{$t('fresh.admin.clear')}</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  h2 { margin: 0 0 .3rem; font-size: 1.3rem; }
  h3 { margin: 0 0 .6rem; font-size: 1rem; }
  .add { max-width: 640px; margin: 1rem 0; display: grid; gap: .8rem; }
  .add label { display: grid; gap: .3rem; font-size: .9rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: .8rem; }
  .picked { margin: 0; display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
  .hits { list-style: none; margin: 0; padding: 0; display: grid; gap: .2rem; }
  .hit { width: 100%; text-align: left; min-height: 44px; background: var(--surface-2); border-radius: 6px; }
  .st { min-height: 1.4rem; }
  .scroll { overflow-x: auto; }
  td input { min-height: 40px; width: 100%; }
  td.flex { gap: .4rem; }
  small { font-size: .8rem; }
</style>
