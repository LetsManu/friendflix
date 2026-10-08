<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';

  let items: Item[] | null = null, input = '', t: ReturnType<typeof setTimeout>, seq = 0;
  $: q = ($page.url.searchParams.get('q') ?? '').trim();
  $: if (q !== input) input = q;
  $: run(q);

  function run(term: string) {
    clearTimeout(t);
    if (term.length < 2) { items = term ? [] : null; return; }
    const my = ++seq;
    t = setTimeout(async () => {
      try { const r = (await api(`/api/library/items?q=${encodeURIComponent(term)}&types=Movie,Series,Episode&limit=60`)).items; if (my === seq) items = r; } catch { if (my === seq) items = []; }
    }, 250);
  }
  const onInput = () => goto(`/search?q=${encodeURIComponent(input)}`, { replaceState: true, keepFocus: true, noScroll: true });
</script>

<svelte:head><title>Suche – FriendFlix</title></svelte:head>
<form role="search" on:submit|preventDefault={onInput}>
  <label class="sr-only" for="q">Suche</label>
  <input id="q" class="big" placeholder="Filme, Serien, Folgen …" bind:value={input} on:input={onInput} />
</form>
{#if items === null}<p class="muted">Gib mindestens zwei Zeichen ein.</p>
{:else if !items.length}
  <div class="empty"><h2>Keine Treffer für „{q}“</h2><p class="muted">Der Titel ist (noch) nicht in der Bibliothek.</p><a class="btn" href="/requests?q={encodeURIComponent(q)}">Als Wunsch eintragen</a></div>
{:else}
  <h2 class="muted" style="font-size:1rem">Ergebnisse für „{q}“</h2>
  <div class="tiles">{#each items as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
{/if}
<style>.big { width: 100%; max-width: 640px; font-size: 1.2rem; min-height: 54px; margin-bottom: 1.5rem; } .empty { text-align: center; padding: 4rem 0; }</style>
