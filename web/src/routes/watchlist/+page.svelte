<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { api, type Item } from '#lib/api';
  import { loadList } from '#lib/stores';
  import { autofocus } from '#lib/actions';
  import Card from '#lib/Card.svelte';

  const TABS = [{ id: 'planned', label: 'Geplant' }, { id: 'dropped', label: 'Abgebrochen' }] as const;
  let tab: (typeof TABS)[number]['id'] = 'planned';
  let items: Item[] | null = null, dropped: Item[] | null = null, msg = '', busyId = '', confirmId = '', msgT: ReturnType<typeof setTimeout>;
  const loadPlanned = () => api('/api/watchlist').then((r) => r.items).then((r: Item[]) => (items = r)).catch(() => { items = items ?? []; });
  const loadDropped = () => api('/api/dropped').then((r) => (dropped = r.items as Item[])).catch(() => { dropped = dropped ?? []; });
  onMount(() => { void loadPlanned(); return () => clearTimeout(msgT); });

  function show(t: typeof tab) {
    tab = t; confirmId = '';
    if (t === 'dropped' && dropped === null) void loadDropped();
  }
  /** "Meine Liste" toggled through a card: drop it from the planned tab, and re-read both tabs (adding a dropped title plans it) */
  function listToggled(e: CustomEvent<{ item: Item; inList: boolean }>) {
    const { item, inList } = e.detail, key = item.seriesId ?? item.id;
    if (!inList) items = (items ?? []).filter((x) => (x.seriesId ?? x.id) !== key);
    void loadPlanned();
    if (dropped !== null) void loadDropped();
  }
  async function onKey(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    show(TABS[n]!.id);
    await tick();
    document.getElementById(`tab-${TABS[n]!.id}`)?.focus();
  }
  async function move(i: Item, status: 'planned' | 'none') {
    busyId = i.id; msg = ''; confirmId = '';
    try {
      await api(`/api/items/${i.id}/status`, { method: 'PUT', body: { status } });
      dropped = (dropped ?? []).filter((x) => x.id !== i.id);
      if (status === 'planned') { if (items === null) void loadPlanned(); else items = [i, ...items.filter((x) => x.id !== i.id)]; }
      void loadList();
    } catch {
      msg = 'Konnte nicht gespeichert werden.';
      clearTimeout(msgT); msgT = setTimeout(() => (msg = ''), 5000);
    }
    busyId = '';
  }
</script>
<svelte:head><title>Meine Liste – FriendFlix</title></svelte:head>
<h1>Meine Liste</h1>
<div class="tabs" role="tablist" aria-label="Listenart">
  {#each TABS as t (t.id)}
    <button type="button" role="tab" id="tab-{t.id}" class="sec" class:on={tab === t.id} aria-selected={tab === t.id} aria-controls="panel-{t.id}" tabindex={tab === t.id ? 0 : -1} on:click={() => show(t.id)} on:keydown={onKey}>{t.label}</button>
  {/each}
</div>
<div role="status">{#if msg}<p class="err">{msg}</p>{/if}</div>
{#if tab === 'planned'}
  <div role="tabpanel" id="panel-planned" aria-labelledby="tab-planned">
    {#if items === null}<div class="tiles">{#each Array(8) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
    {:else if !items.length}<p class="muted">Noch nichts hier. Füge Titel über das Plus hinzu.</p>
    {:else}<div class="tiles">{#each items as i (i.id)}<div class="slot"><Card item={i} on:listtoggle={listToggled} /></div>{/each}</div>{/if}
  </div>
{:else}
  <div role="tabpanel" id="panel-dropped" aria-labelledby="tab-dropped">
    {#if dropped === null}<div class="tiles">{#each Array(4) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
    {:else if !dropped.length}<p class="muted">Keine abgebrochenen Titel. Sie verschwinden aus „Weiterschauen“, bleiben aber hier erhalten.</p>
    {:else}<div class="tiles">
      {#each dropped as i (i.id)}
        <div class="slot">
          <Card item={i} on:listtoggle={listToggled} />
          {#if confirmId === i.id}
            <div class="acts" role="group" aria-label="„{i.name}“ entfernen?">
              <p class="ask">„{i.name}“ ganz aus Meine Liste entfernen?</p>
              <div class="flex">
                <button type="button" disabled={busyId === i.id} on:click={() => move(i, 'none')}>Ja, entfernen</button>
                <button type="button" class="sec" use:autofocus on:click={() => (confirmId = '')}>Abbrechen</button>
              </div>
            </div>
          {:else}
            <div class="flex acts">
              <button type="button" disabled={busyId === i.id} on:click={() => move(i, 'planned')}>Wieder aufnehmen</button>
              <button type="button" class="sec" disabled={busyId === i.id} aria-label="{i.name} entfernen" on:click={() => (confirmId = i.id)}>Entfernen</button>
            </div>
          {/if}
        </div>
      {/each}
    </div>{/if}
  </div>
{/if}
<style>
  .tabs { display: flex; gap: .4rem; margin-bottom: 1rem; }
  .tabs button { border-radius: 99px; padding-inline: 1.2rem; }
  .tabs button.on { background: #fff; color: #000; }
  .acts { margin-top: .5rem; }
  .ask { margin: 0 0 .5rem; font-size: .9rem; }
</style>
