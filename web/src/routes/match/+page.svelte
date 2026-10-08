<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';
  import Icon from '$lib/Icon.svelte';

  let friends: Array<{ id: string; name: string; sharesHistory: boolean }> = [], picked = new Set<string>();
  let type = 'Movie', maxMinutes = 0, genre = '', genres: string[] = [];
  let result: { participants: string[]; total: number; items: Item[] } | null = null, busy = false, error = '', chosen = new Set<string>();
  onMount(async () => {
    friends = (await api('/api/friends').catch(() => ({ friends: [] }))).friends;
    genres = (await api('/api/library/genres').catch(() => ({ genres: [] }))).genres;
  });
  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); picked = n; };
  async function run() {
    busy = true; error = ''; result = null; chosen = new Set();
    try { result = await api('/api/match', { method: 'POST', body: { userIds: [...picked], type, maxMinutes: maxMinutes || undefined, genre: genre || undefined } }); }
    catch (e: any) { error = e?.body?.error === 'history_not_shared' ? `${e.body.names.join(', ')} ${e.body.names.length > 1 ? 'haben' : 'hat'} den Abgleich noch nicht erlaubt (Einstellungen → „Gruppen-Matcher“).` : 'Abgleich fehlgeschlagen.'; }
    busy = false;
  }
  const pick = (id: string) => { const n = new Set(chosen); if (n.has(id)) n.delete(id); else if (n.size < 10) n.add(id); chosen = n; };
  async function poll() {
    const r = await api('/api/polls', { method: 'POST', body: { title: 'Filmabend – das hat noch keiner gesehen', options: [...chosen].map((jfItemId) => ({ jfItemId })), closesInMinutes: 60, startsAfterMinutes: 10 } }).catch((e: any) => { error = e?.body?.error === 'poll_already_open' ? 'Du hast schon eine offene Abstimmung.' : 'Abstimmung konnte nicht erstellt werden.'; return null; });
    if (r) goto('/vote');
  }
</script>

<svelte:head><title>Gruppen-Matcher – FriendFlix</title></svelte:head>
<h1>Gruppen-Matcher</h1>
<p class="muted">Finde Titel, die <b>keiner</b> von euch gesehen hat. Nur Freunde, die den Abgleich in ihren Einstellungen erlaubt haben, können ausgewählt werden.</p>
<div class="panel">
  <h3>Wer schaut mit?</h3>
  <div class="flex">
    {#each friends as f (f.id)}
      <label class="pill" class:off={!f.sharesHistory}><input type="checkbox" disabled={!f.sharesHistory} checked={picked.has(f.id)} on:change={() => toggle(f.id)} />{f.name}{#if !f.sharesHistory}<small class="muted"> (nicht freigegeben)</small>{/if}</label>
    {:else}<span class="muted">Noch keine anderen Nutzer.</span>{/each}
  </div>
  <div class="flex" style="margin-top:1rem">
    <select bind:value={type} aria-label="Art"><option value="Movie">Filme</option><option value="Series">Serien</option><option value="Both">Filme &amp; Serien</option></select>
    <select bind:value={maxMinutes} aria-label="Maximale Länge"><option value={0}>Beliebig lang</option><option value={100}>bis 100 Min.</option><option value={120}>bis 2 Std.</option><option value={150}>bis 2,5 Std.</option></select>
    <select bind:value={genre} aria-label="Genre"><option value="">Alle Genres</option>{#each genres as g}<option>{g}</option>{/each}</select>
    <button disabled={!picked.size || busy} on:click={run}>Abgleichen</button>
  </div>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
</div>
{#if result}
  <h2>{result.items.length} Treffer <small class="muted">({result.total} insgesamt ungesehen von {result.participants.join(', ')})</small></h2>
  {#if !result.items.length}<p class="muted">Keine passenden Titel – lockere die Filter.</p>{/if}
  <div class="tiles">
    {#each result.items as i (i.id)}
      <div class="slot sel" class:on={chosen.has(i.id)}>
        <Card item={i} />
        <button class="pickbtn" aria-pressed={chosen.has(i.id)} aria-label="Für Abstimmung vormerken" on:click={() => pick(i.id)}><Icon name={chosen.has(i.id) ? 'check' : 'vote'} size={18} /></button>
      </div>
    {/each}
  </div>
  {#if chosen.size >= 2}<div class="bar2"><span>{chosen.size} Titel gewählt</span><button on:click={poll}><Icon name="vote" size={18} />Abstimmung starten</button></div>{/if}
{/if}
<style>
  .pill { display: inline-flex; align-items: center; gap: .5rem; background: var(--surface-2); padding: .4rem .9rem; border-radius: 99px; color: var(--fg); min-height: 44px; } .pill.off { opacity: .55; }
  .sel { position: relative; } .pickbtn { position: absolute; top: .4rem; right: .4rem; z-index: 3; width: 36px; min-height: 36px; padding: 0; border-radius: 50%; background: rgba(0,0,0,.7); border: 2px solid #fff; }
  .sel.on .pickbtn { background: var(--acc); border-color: var(--acc); }
  .bar2 { position: fixed; left: 50%; bottom: 1.2rem; transform: translateX(-50%); background: rgba(20,20,20,.97); border: 1px solid #444; border-radius: 99px; padding: .5rem .8rem .5rem 1.4rem; display: flex; gap: 1rem; align-items: center; z-index: 30; }
</style>
