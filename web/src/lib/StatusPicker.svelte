<script lang="ts">
  import { api } from '#lib/api';
  import { loadList } from '#lib/stores';

  type Status = 'none' | 'planned' | 'watching' | 'watched' | 'dropped';
  /** movie or series id whose per-profile watch status is shown; hidden while loading or when the request fails */
  export let id: string;
  let status: Status | null = null, msg = '', busy = false, seq = 0, msgT: ReturnType<typeof setTimeout>;

  $: void load(id);
  async function load(itemId: string) {
    const my = ++seq;
    status = null; msg = '';
    try {
      const r = await api(`/api/items/${itemId}/status`);
      if (my === seq) status = r.status as Status;
    } catch { /* optional */ }
  }
  async function pick(target: 'planned' | 'dropped') {
    if (!status || busy) return;
    const before = status, my = ++seq;
    const want = status === target ? 'none' : target;
    status = want; busy = true; msg = '';
    try {
      const r = await api(`/api/items/${id}/status`, { method: 'PUT', body: { status: want } });
      if (my === seq) status = r.status as Status;
      void loadList(); // keeps the "Meine Liste" button in sync
    } catch {
      if (my === seq) status = before;
      msg = 'Status konnte nicht gespeichert werden.';
      clearTimeout(msgT); msgT = setTimeout(() => (msg = ''), 5000);
    }
    busy = false;
  }
</script>

{#if status !== null}
  <div class="status" role="group" aria-label="Status">
    <div class="seg">
      <button type="button" class="sec" class:on={status === 'planned'} aria-pressed={status === 'planned'} disabled={busy} on:click={() => pick('planned')}>Geplant</button>
      <button type="button" class="sec" class:on={status === 'dropped'} aria-pressed={status === 'dropped'} disabled={busy} on:click={() => pick('dropped')}>Abgebrochen</button>
    </div>
    {#if status === 'watching'}<span class="badge">Schaue ich gerade</span>{:else if status === 'watched'}<span class="badge">Gesehen</span>{/if}
  </div>
{/if}
<div role="status">{#if msg}<p class="err">{msg}</p>{/if}</div>

<style>
  .status { display: flex; flex-wrap: wrap; gap: .7rem; align-items: center; margin-bottom: .6rem; }
  .seg { display: inline-flex; gap: 2px; }
  .seg button { border-radius: 0; padding-inline: 1rem; }
  .seg button:first-child { border-radius: 99px 0 0 99px; }
  .seg button:last-child { border-radius: 0 99px 99px 0; }
  .seg button.on { background: #fff; color: #000; }
  .badge { min-height: 44px; display: inline-flex; align-items: center; padding-inline: 1rem; }
</style>
