<script lang="ts">
  import { onMount } from 'svelte';
  import OfflinePlayer from '#lib/OfflinePlayer.svelte';
  import { bumpMaxSeen, daysLeft, isPlayable, REASON_TEXT } from '#lib/offline/license';
  import { getAllDownloads, getMeta, setMeta, type DownloadRecord } from '#lib/offline/db';

  // Prerendered hub: never calls /api (the session may be gone, the network is). Reads IndexedDB only.
  let items: DownloadRecord[] = [];
  let loaded = false, maxSeen = 0, profileName = '';
  let playing: DownloadRecord | null = null;

  const fmtSize = (b: number) => (b / 1e9 >= 1 ? `${(b / 1e9).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB` : `${Math.round(b / 1e6)} MB`);
  $: groups = group(items);
  function group(list: DownloadRecord[]) {
    const m = new Map<string, DownloadRecord[]>();
    for (const d of list) { const k = d.seriesName ?? ''; m.set(k, [...(m.get(k) ?? []), d]); }
    return [...m.entries()].map(([series, eps]) => ({ series, eps: eps.sort((a, b) => (a.s ?? 0) - (b.s ?? 0) || (a.e ?? 0) - (b.e ?? 0) || a.title.localeCompare(b.title, 'de')) })).sort((a, b) => a.series.localeCompare(b.series, 'de'));
  }
  const verdict = (d: DownloadRecord) => isPlayable(d, Date.now(), { maxSeenTime: maxSeen });

  async function load() {
    try {
      maxSeen = Number((await getMeta<number>('maxSeenTime')) ?? 0);
      const profile = (await getMeta<string>('lastProfileId')) as string | undefined;
      const all = await getAllDownloads();
      items = all.filter((d) => d.profileId === profile);
      profileName = items[0]?.profileName ?? '';
      const now = Date.now();
      if (now > maxSeen) { maxSeen = bumpMaxSeen(maxSeen, now); await setMeta('maxSeenTime', maxSeen); }
    } catch { items = []; }
    loaded = true;
  }
  onMount(() => {
    void init();
    const onShow = () => load();
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  });
  async function init() {
    await load();
    const id = new URLSearchParams(location.search).get('play');
    const hit = id ? items.find((d) => d.id === id) : null;
    if (hit && verdict(hit).ok) playing = hit;
  }
  async function closePlayer() { playing = null; await load(); }
</script>

<svelte:head><title>Offline</title></svelte:head>

<section class="offline" id="main">
  <h1>Offline{profileName ? ` · ${profileName}` : ''}</h1>
  <p class="muted">Keine Verbindung zu FriendFlix. Deine heruntergeladenen Titel kannst du trotzdem ansehen.</p>
  <div class="flex">
    <button class="btn" type="button" on:click={() => location.assign('/')}>Erneut verbinden</button>
  </div>

  {#if !loaded}
    <p class="muted" role="status">Lade …</p>
  {:else if !items.length}
    <p class="muted">Auf diesem Gerät sind keine Downloads vorhanden.</p>
  {:else}
    {#each groups as g (g.series)}
      <div class="grp">
        {#if g.series}<h2>{g.series}</h2>{/if}
        {#each g.eps as d (d.id)}
          {@const v = verdict(d)}
          <div class="row">
            <div class="meta">
              <b>{d.s != null && d.e != null ? `S${d.s} E${d.e} · ` : ''}{d.title}</b>
              <span class="muted">{fmtSize(d.bytesTotal)} · noch {daysLeft(d.expiresAt, Date.now())} Tage{d.state !== 'done' ? ' · nicht fertig' : ''}</span>
              {#if !v.ok && v.reason}<span class="warn">{REASON_TEXT[v.reason]}</span>{/if}
            </div>
            <button type="button" disabled={!v.ok} on:click={() => (playing = d)}>Abspielen</button>
          </div>
        {/each}
      </div>
    {/each}
  {/if}
</section>

{#if playing}<OfflinePlayer dl={playing} on:close={closePlayer} />{/if}

<style>
  .offline { min-height: 60vh; display: flex; flex-direction: column; align-items: center; gap: 1rem; text-align: center; padding: 3rem 1rem; }
  h1 { margin: 0; }
  p { margin: 0; max-width: 32rem; }
  .muted { opacity: .8; }
  .grp { width: min(40rem, 100%); text-align: left; display: flex; flex-direction: column; gap: .5rem; margin-top: 1rem; }
  h2 { margin: 0 0 .25rem; font-size: 1.1rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .7rem .9rem; border: 1px solid #333; border-radius: 6px; }
  .meta { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
  .warn { color: #ffb347; font-size: .85rem; }
  .flex { display: flex; gap: .6rem; }
</style>
