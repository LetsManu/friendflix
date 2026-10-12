<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { downloads, initManager, getSupport, pause, progressPct, refreshStorage, removeDownload, resume, stateLabel, storageInfo, checkIn, type DlView } from '#lib/offline/manager';
  import { SUPPORT_HINT, persist, type Support } from '#lib/offline/opfs';
  import { daysLeft } from '#lib/offline/license';
  import { fmtBytes } from '#lib/offline/size';

  let support: Support = { ok: false };
  let me: Me | null = null, ready = false;
  let quality = 'hd', persistMsg = '';

  onMount(async () => {
    support = getSupport();
    me = await api<Me>('/api/me').catch(() => null);
    try { quality = localStorage.getItem('ff_dl_quality') ?? 'hd'; } catch { /* ignore */ }
    if (support.ok) { await initManager(); void refreshStorage(); void checkIn(); }
    ready = true;
  });
  function setQuality(q: string) { quality = q; try { localStorage.setItem('ff_dl_quality', q); } catch { /* ignore */ } }
  async function askPersist() { persistMsg = (await persist()) ? 'Speicher wird geschützt.' : 'Der Browser hat den Schutz nicht erteilt; Downloads können bei Platzmangel gelöscht werden.'; void refreshStorage(); }

  $: list = [...$downloads.values()].filter((v) => v.profileId === (me?.profile?.id ?? v.profileId));
  $: groups = Object.values(list.reduce<Record<string, { name: string; items: DlView[] }>>((acc, v) => {
    const k = v.seriesName ?? '\u0000Filme';
    (acc[k] ??= { name: v.seriesName ?? 'Filme', items: [] }).items.push(v);
    return acc;
  }, {})).map((g) => ({ ...g, items: g.items.sort((a, b) => (a.s ?? 0) - (b.s ?? 0) || (a.e ?? 0) - (b.e ?? 0) || a.title.localeCompare(b.title)) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  $: used = list.reduce((n, v) => n + v.bytesHave, 0);
  $: total = $storageInfo.quota;
  $: barPct = total ? Math.min(100, (used / total) * 100) : 0;
  const label = (v: DlView) => (v.seriesName ? `S${v.s ?? '?'}:E${v.e ?? '?'} · ${v.title}` : v.title);
  const busy = (v: DlView) => v.state === 'queued' || v.state === 'preparing' || v.state === 'downloading';
  let confirmAll = false;
  async function wipe() { confirmAll = false; await Promise.all(list.map((v) => removeDownload(v.id))); }
</script>

<svelte:head><title>Downloads – FriendFlix</title></svelte:head>
<h1>Downloads</h1>
{#if !ready}<div class="skeleton" style="height:10rem"></div>
{:else if !support.ok}
  <p class="muted">{SUPPORT_HINT[support.reason ?? 'no-opfs']}</p>
{:else if me && !me.downloads?.allowed}
  <p class="muted">Downloads sind für dein Konto nicht freigeschaltet.</p>
{:else}
  <section class="panel store">
    <div class="bar" role="progressbar" aria-label="Belegter Speicher" aria-valuenow={Math.round(barPct)} aria-valuemin="0" aria-valuemax="100"><i style="width:{barPct}%"></i></div>
    <p>{fmtBytes(used)} von {fmtBytes(total)} Gerätespeicher belegt{#if me?.downloads?.max} · bis zu {me.downloads.max} Downloads{/if}</p>
    <div class="flex">
      <label>Standard-Qualität
        <select value={quality} on:change={(e) => setQuality(e.currentTarget.value)}>
          <option value="sd">Niedrig (480p)</option><option value="hd">Mittel (720p)</option><option value="fhd">Hoch (1080p)</option><option value="original">Original</option>
        </select>
      </label>
      {#if !$storageInfo.persisted}<button class="sec" on:click={askPersist}>Speicher schützen</button>{/if}
    </div>
    {#if persistMsg}<p class="muted" role="status">{persistMsg}</p>{/if}
    <p class="muted small">Downloads funktionieren ohne Internet, solange die Lizenz gültig ist. Ein Kopierschutz besteht nicht; Ablauf und Sperrung werden beim nächsten Online-Kontakt durchgesetzt. Beim Herunterladen muss dieser Tab geöffnet bleiben.</p>
  </section>

  {#if !list.length}
    <p class="muted">Noch keine Downloads. Auf einer Titelseite findest du „Herunterladen“.</p>
  {:else}
    {#each groups as g (g.name)}
      <h2>{g.name}</h2>
      <ul class="list">
        {#each g.items as v (v.id)}
          <li class="item">
            <div class="tx">
              <b>{label(v)}</b>
              <span class="muted small">{stateLabel(v)}{#if v.state === 'done'} · {fmtBytes(v.bytesTotal)} · noch {daysLeft(v.expiresAt, Date.now())} Tage{/if}{#if v.state === 'error' && v.msg} · {v.msg}{/if}</span>
              {#if busy(v) || v.state === 'paused'}<div class="bar slim" role="progressbar" aria-label="Fortschritt" aria-valuenow={v.state === 'preparing' ? v.prep ?? 0 : progressPct(v)} aria-valuemin="0" aria-valuemax="100"><i style="width:{v.state === 'preparing' ? v.prep ?? 0 : progressPct(v)}%"></i></div>{/if}
            </div>
            <div class="acts">
              {#if v.state === 'done'}<a class="btn" href="/offline?play={v.id}"><Icon name="play" size={18} />Abspielen</a>{/if}
              {#if v.state === 'downloading'}<button class="sec" on:click={() => pause(v.id)}><Icon name="pause" size={18} />Pausieren</button>{/if}
              {#if v.state === 'paused' || v.state === 'error'}<button class="sec" on:click={() => resume(v.id)}><Icon name="play" size={18} />Fortsetzen</button>{/if}
              <button class="icon-btn" aria-label="{v.state === 'done' ? 'Löschen' : 'Abbrechen'}: {label(v)}" title={v.state === 'done' ? 'Löschen' : 'Abbrechen'} on:click={() => removeDownload(v.id)}><Icon name="x" size={20} /></button>
            </div>
          </li>
        {/each}
      </ul>
    {/each}
    {#if confirmAll}
      <p class="flex"><span>Alle Downloads auf diesem Gerät löschen?</span><button on:click={wipe}>Ja, alle löschen</button><button class="sec" on:click={() => (confirmAll = false)}>Abbrechen</button></p>
    {:else}<button class="sec" on:click={() => (confirmAll = true)}>Alle löschen</button>{/if}
  {/if}
{/if}

<style>
  .store { display: grid; gap: .8rem; max-width: 720px; margin-bottom: 1.5rem; }
  .bar { height: 8px; border-radius: 4px; background: var(--surface-2, #2a2a2a); overflow: hidden; } .bar i { display: block; height: 100%; background: var(--acc); transition: width .3s; }
  .bar.slim { height: 4px; margin-top: .3rem; }
  .small { font-size: .85rem; } .store p { margin: 0; }
  .list { list-style: none; padding: 0; margin: 0 0 1.5rem; display: grid; gap: .5rem; max-width: 900px; }
  .item { display: flex; gap: 1rem; align-items: center; justify-content: space-between; padding: .8rem 1rem; background: var(--surface); border-radius: 8px; flex-wrap: wrap; }
  .tx { display: flex; flex-direction: column; gap: .15rem; min-width: 0; flex: 1 1 240px; }
  .acts { display: flex; gap: .5rem; align-items: center; }
</style>
