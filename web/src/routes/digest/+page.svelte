<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '#lib/api';
  import Row from '#lib/Row.svelte';

  interface Data {
    newMovies: Array<{ id: string; name: string; year?: number }>; newMovieCount: number;
    newEpisodes: Array<{ seriesId: string; seriesName: string; count: number; followed: boolean; episodes: Array<{ id: string; name: string; season?: number; episode?: number }> }>; newEpisodeCount: number;
    available: Array<{ title: string; link: string | null; itemId: string | null }>;
    recommendations: Array<{ itemId: string; name: string; from: string; note: string | null; kind: 'recommended' | 'friends' }>;
  }
  let digest: { week: string; sentAt: string; data: Data } | null | undefined;
  let byId: Record<string, Item> = {};
  let movies: Item[] | null = null, series: Item[] | null = null, avail: Item[] | null = null, recs: Item[] | null = null;

  const pick = (ids: string[]): Item[] => ids.flatMap((id) => (byId[id] ? [byId[id]!] : []));
  const cap = (items: Item[], c: Map<string, string>) => items.map((i) => ({ ...i, caption: c.get(i.id) }));
  onMount(async () => {
    try {
      const r = await api('/api/digest/latest');
      digest = r.digest ? { week: r.digest.week, sentAt: r.digest.sentAt, data: r.digest.data } : null;
      byId = r.digest?.items ?? {};
    } catch { digest = null; }
    const d = digest?.data;
    if (!d) return;
    movies = pick(d.newMovies.map((m) => m.id));
    series = cap(pick(d.newEpisodes.map((g) => g.seriesId)), new Map(d.newEpisodes.map((g) => [g.seriesId, `${g.count} ${g.count === 1 ? 'neue Folge' : 'neue Folgen'}${g.followed ? ' · folgst du' : ''}`])));
    avail = pick(d.available.flatMap((a) => (a.itemId ? [a.itemId] : [])));
    recs = cap(pick(d.recommendations.map((r) => r.itemId)), new Map(d.recommendations.map((r) => [r.itemId, r.kind === 'friends' ? `Bewertet von ${r.from}` : `Von ${r.from}${r.note ? `: ${r.note}` : ''}`])));
  });
  $: pending = digest?.data.available.filter((a) => !a.itemId) ?? [];
  const when = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
</script>
<svelte:head><title>Wochenrückblick – FriendFlix</title></svelte:head>
<h1>Wochenrückblick</h1>
{#if digest === undefined}
  <p class="muted" aria-busy="true">Lade …</p>
{:else if !digest}
  <p class="muted">Noch kein Wochenrückblick.</p>
{:else}
  <p class="muted">Zusammenfassung vom {when(digest.sentAt)}</p>
  <div class="bleed">
    <Row title="Neu in der Bibliothek" items={movies} />
    <Row title="Neue Folgen deiner Serien" items={series} />
    <Row title="Deine Wünsche sind da" items={avail} />
    {#if pending.length}<ul class="plain">{#each pending as a}<li>{a.title}</li>{/each}</ul>{/if}
    <Row title="Freunde empfehlen" items={recs} />
  </div>
  {#if digest.data.newMovieCount > digest.data.newMovies.length}<p class="muted">… und {digest.data.newMovieCount - digest.data.newMovies.length} weitere neue Filme.</p>{/if}
{/if}
<style>
  .bleed { margin: 0 calc(var(--pad-x) * -1); }
  .plain { margin: 1rem var(--pad-x) 0; color: var(--mut); }
</style>
