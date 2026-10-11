<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { replaceState } from '$app/navigation';
  import { api, img, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { clearRecent, isYear, loadRecent, pushRecent } from '#lib/discovery';

  interface Person { id: string; name: string; image: boolean }
  interface Result { q: string; titles: Item[]; episodes: Item[]; people: Person[]; genres: string[]; partial: boolean }

  let input = '', term = '', pushed: string | null = null, status: 'idle' | 'loading' | 'error' | 'done' = 'idle';
  let res: Result | null = null, recent: string[] = [], t: ReturnType<typeof setTimeout>, seq = 0, ctl: AbortController | undefined, inputEl: HTMLInputElement;

  $: urlQ = ($page.url.searchParams.get('q') ?? '').trim();
  // initial value, back/forward and header-search submits come in through the URL; our own replaceState calls are skipped
  $: if (urlQ !== pushed) { pushed = urlQ; clearTimeout(t); input = urlQ; term = urlQ; }
  $: void search(term);

  async function search(q: string) {
    ctl?.abort();
    const my = ++seq;
    if (q.length < 2) { status = 'idle'; res = null; return; }
    ctl = new AbortController();
    status = 'loading';
    try {
      const r: Result = await api(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
      if (my !== seq) return;
      res = r; status = 'done'; recent = pushRecent(q);
    } catch (e: any) {
      if (my !== seq || e?.name === 'AbortError') return;
      status = 'error';
    }
  }

  function commit(v: string) {
    clearTimeout(t);
    const q = v.trim();
    if (q !== pushed) {
      pushed = q;
      try { replaceState(q ? `/search?q=${encodeURIComponent(q)}` : '/search', {}); } catch { /* router not ready */ }
    }
    term = q;
  }
  function onInput() { clearTimeout(t); t = setTimeout(() => commit(input), 250); }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && input) { e.preventDefault(); e.stopPropagation(); input = ''; commit(''); }
  }
  function pick(q: string) { input = q; commit(q); inputEl?.focus(); }
  function forget() { clearRecent(); recent = []; }
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

  onMount(() => { recent = loadRecent(); });
  onDestroy(() => { clearTimeout(t); ctl?.abort(); });

  $: count = res ? res.titles.length + res.episodes.length + res.people.length + res.genres.length : 0;
  $: empty = status === 'done' && res !== null && count === 0;
  $: year = isYear(term);
</script>

<svelte:head><title>Suche – FriendFlix</title></svelte:head>
<h1 class="sr-only">Suche</h1>
<form role="search" on:submit|preventDefault={() => commit(input)}>
  <label class="sr-only" for="q">Suche</label>
  <input id="q" class="big" type="search" autocomplete="off" enterkeyhint="search" placeholder="Titel, Person, Genre, Jahr …" bind:this={inputEl} bind:value={input} on:input={onInput} on:keydown={onKeydown} />
</form>

<p class="sr-only" role="status" aria-live="polite">{#if status === 'done' && res}{count} Treffer{/if}</p>

{#if status === 'idle'}
  {#if term.length === 0 && recent.length}
    <section aria-labelledby="rc">
      <div class="flex rhead"><h2 id="rc" class="muted">Zuletzt gesucht</h2><button type="button" class="sec small" on:click={forget}>Verlauf löschen</button></div>
      <ul class="chips">{#each recent as r (r)}<li><button type="button" class="chip" on:click={() => pick(r)}>{r}</button></li>{/each}</ul>
    </section>
  {:else}<p class="muted">Gib mindestens zwei Zeichen ein.</p>{/if}
{:else if status === 'loading'}
  <div class="tiles" aria-busy="true"><span class="sr-only">Suche läuft …</span>{#each Array(12) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if status === 'error'}
  <div class="empty" role="alert"><h2>Suche gerade nicht möglich</h2><p class="muted">Bitte versuche es in einem Moment noch einmal.</p><button type="button" on:click={() => search(term)}>Erneut versuchen</button></div>
{:else if res}
  {#if res.partial}<p class="muted note">Einige Ergebnisse konnten nicht geladen werden.</p>{/if}
  {#if empty}
    <div class="empty"><h2>Keine Treffer für „{term}“</h2><p class="muted">Der Titel ist (noch) nicht in der Bibliothek.</p><a class="btn" href="/requests?q={encodeURIComponent(term)}">Als Wunsch eintragen</a></div>
  {:else}
    {#if res.people.length}
      <section aria-labelledby="sp"><h2 id="sp" class="sh">Personen</h2>
        <ul class="people">{#each res.people as p (p.id)}
          <li><a href="/person/{p.id}"><span class="av">{#if p.image}<img src={img(p.id, 160)} alt="" loading="lazy" width="80" height="80" />{:else}<span aria-hidden="true">{initials(p.name)}</span>{/if}</span><span class="nm">{p.name}</span></a></li>
        {/each}</ul>
      </section>
    {/if}
    {#if res.genres.length}
      <section aria-labelledby="sg"><h2 id="sg" class="sh">Genres</h2>
        <ul class="chips">{#each res.genres as g (g)}<li><a class="chip" href="/browse/movies?genre={encodeURIComponent(g)}">{g}</a></li>{/each}</ul>
      </section>
    {/if}
    {#if res.titles.length}
      <section aria-labelledby="st"><h2 id="st" class="sh">{year ? `Titel aus ${term}` : 'Filme & Serien'}</h2>
        <div class="tiles">{#each res.titles as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
      </section>
    {/if}
    {#if res.episodes.length}
      <section aria-labelledby="se"><h2 id="se" class="sh">Folgen</h2>
        <div class="tiles">{#each res.episodes as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
      </section>
    {/if}
  {/if}
{/if}

<style>
  .big { width: 100%; max-width: 640px; font-size: 1.2rem; min-height: 54px; margin-bottom: 1.5rem; }
  .empty { text-align: center; padding: 4rem 0; }
  .note { font-size: .88rem; margin: 0 0 1rem; }
  .sh { font-size: 1.15rem; margin: 1.2rem 0 .8rem; }
  .rhead { justify-content: space-between; max-width: 640px; } .rhead h2 { font-size: 1rem; margin: 0; }
  .small { padding: .3rem .9rem; font-size: .85rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; }
  .chip { display: inline-flex; align-items: center; min-height: 44px; padding: 0 1rem; border-radius: 99px; background: var(--surface-2); color: var(--fg); font-weight: 500; border: 0; cursor: pointer; }
  .chip:hover { background: #3a3a3a; }
  .people { display: flex; gap: 1rem; overflow-x: auto; padding-bottom: .5rem; }
  .people a { display: flex; flex-direction: column; align-items: center; gap: .4rem; width: 96px; min-height: 44px; text-align: center; }
  .av { width: 80px; height: 80px; border-radius: 50%; overflow: hidden; background: var(--surface-2); display: grid; place-items: center; font-weight: 700; font-size: 1.4rem; color: var(--mut); }
  .av img { width: 100%; height: 100%; object-fit: cover; }
  .nm { font-size: .85rem; line-height: 1.25; overflow-wrap: anywhere; }
  .people a:hover .nm { text-decoration: underline; }
</style>
