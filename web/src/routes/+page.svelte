<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError, type Item } from '#lib/api';
  import Hero from '#lib/Hero.svelte';
  import LazyRow from '#lib/LazyRow.svelte';
  import Row from '#lib/Row.svelte';
  import UpcomingRow from '#lib/UpcomingRow.svelte';

  let hero: Item | null = null, heroPlay = '';
  let resume: Item[] | null = null, next: Item[] | null = null, latest: Item[] | null = null, mine: Item[] | null = null;
  let recs: Item[] | null = null, friendsRated: Item[] | null = null;
  let top: Item[] | null = null, because: { name: string } | null = null, becauseItems: Item[] | null = null;
  let views: Item[] = [], genres: string[] = [], error = '';
  const q = (p: Record<string, string>) => new URLSearchParams(p).toString();
  // Jellyfin can answer 5xx/network errors right after a fresh sign-up: retry (not on 401/403) before giving up
  const retry = async <T,>(fn: () => Promise<T>, tries = 3, delayMs = 1500): Promise<T> => {
    for (let i = 1; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (i >= tries || (e instanceof ApiError && (e.status === 401 || e.status === 403))) throw e;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  };
  const load = (path: string) => retry(() => api(path));
  const items = (p: Record<string, string>) => load(`/api/library/items?${q(p)}`).then((r) => r.items as Item[]);

  onMount(async () => {
    load('/api/library/resume').then((r) => (resume = r.items)).catch(() => (resume = []));
    load('/api/library/nextup').then((r) => (next = r.items)).catch(() => (next = []));
    items({ types: 'Movie,Series', sort: 'DateCreated', desc: 'true', limit: '24' }).then((r) => (latest = r)).catch(() => (latest = []));
    load('/api/library/because').then((r) => { because = r.because; becauseItems = r.items; }).catch(() => (becauseItems = []));
    load('/api/recommendations').then((r) => (recs = r.items)).catch(() => (recs = []));
    load('/api/library/friends-rated').then((r) => (friendsRated = r.items)).catch(() => (friendsRated = []));
    items({ types: 'Movie,Series', sort: 'CommunityRating', desc: 'true', limit: '10' }).then((r) => (top = r)).catch(() => (top = []));
    load('/api/watchlist').then((r) => (mine = r.items)).catch(() => (mine = []));
    load('/api/library/views').then((r) => (views = r.items)).catch(() => (error = 'Bibliothek konnte nicht geladen werden.'));
    load('/api/library/genres').then((r) => (genres = r.genres.slice(0, 8))).catch(() => undefined);
    // Billboard: random title that has a backdrop (falls back to the newest one)
    try {
      const pool = await items({ types: 'Movie,Series', sort: 'Random', limit: '15' });
      hero = pool.find((i) => i.backdrop) ?? pool[0] ?? null;
    } catch { hero = null; }
  });
  async function removeResume(id: string) {
    const prev = resume;
    resume = resume ? resume.filter((i) => i.id !== id) : resume; // optimistic
    try { await api(`/api/library/resume/${id}`, { method: 'DELETE' }); } catch { resume = prev; }
  }
  $: heroRank = hero && top ? top.findIndex((i) => i.id === hero!.id) + 1 : 0;
  // Jellyfin's next-up also lists the episode you are in the middle of: that one is already under "Weiterschauen"
  $: nextOnly = next && resume ? next.filter((e) => !resume!.some((r) => r.id === e.id)) : next;
</script>

<svelte:head><title>FriendFlix</title></svelte:head>
<Hero item={hero} rank={heroRank} />
<div class="rows">
  {#if error}<p class="err" style="margin:1rem var(--pad-x)">{error}</p>{/if}
  <Row title="Weiterschauen" items={resume} removable on:remove={(e) => removeResume(e.detail.id)} />
  <Row title="Nächste Folge" items={nextOnly} />
  <Row title="Von Freunden empfohlen" items={recs} />
  <Row title="Freunde haben bewertet" items={friendsRated} />
  {#if because}<Row title="Weil du „{because.name}“ gesehen hast" items={becauseItems} />{/if}
  <Row title="Neu hinzugefügt" items={latest} href="/new" />
  <Row title="Top 10 nach Bewertung" items={top} ranked />
  <Row title="Meine Liste" items={mine} href="/watchlist" />
  <UpcomingRow type="movie" title="Demnächst – jetzt wünschen" />
  {#each views as v (v.id)}
    <LazyRow title={v.name} href="/library/{v.id}" load={() => items({ parentId: v.id, sort: 'DateCreated', desc: 'true', limit: '24' })} />
  {/each}
  {#each genres as g (g)}
    <LazyRow title={g} href="/browse/movies?genre={encodeURIComponent(g)}" load={() => items({ types: 'Movie,Series', genre: g, sort: 'Random', limit: '24' })} />
  {/each}
</div>

<style>.rows { position: relative; z-index: 2; padding-bottom: 5rem; }</style>
