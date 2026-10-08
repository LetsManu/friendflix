<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api';

  /** "Demnächst": upcoming releases from Seerr with a one-click wish. */
  export let type: 'movie' | 'tv' = 'movie';
  export let title = 'Demnächst im Kino';
  let items: Array<{ tmdbId: number; mediaType: string; title: string; releaseDate?: string; poster?: string; status: string }> | null = null;
  let msg = '';
  const fmt = (d?: string) => (d ? new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Termin offen');
  onMount(() => { api(`/api/seerr/upcoming?type=${type}`).then((r) => (items = r.results)).catch(() => (items = [])); });
  async function wish(it: NonNullable<typeof items>[number]) {
    try { await api('/api/requests', { method: 'POST', body: { mediaType: it.mediaType, tmdbId: it.tmdbId } }); it.status = 'angefragt'; items = items; msg = `„${it.title}“ wurde gewünscht.`; }
    catch (e) { msg = e instanceof ApiError && e.status === 409 ? 'Dafür gibt es schon einen Wunsch.' : 'Wunsch fehlgeschlagen.'; }
  }
</script>

{#if items === null || items.length}
  <section class="up" aria-label={title} aria-busy={items === null}>
    <h2>{title}</h2>
    <div class="track">
      {#if items === null}{#each Array(7) as _}<div class="skeleton ph"></div>{/each}
      {:else}{#each items as it (it.tmdbId)}
        <article class="c">
          {#if it.poster}<img loading="lazy" src={it.poster} alt="" />{:else}<div class="noimg">{it.title}</div>{/if}
          <div class="t"><b class="name">{it.title}</b><span class="muted">{fmt(it.releaseDate)}</span>
            <div class="act">
              {#if it.status === 'nicht_angefragt' || it.status === 'abgelehnt'}<button class="sec" on:click={() => wish(it)}>Wünschen</button>
              {:else if it.status === 'verfuegbar'}<span class="ok">Verfügbar</span>{:else}<span class="warn">Gewünscht</span>{/if}
            </div>
          </div>
        </article>{/each}{/if}
    </div>
    {#if msg}<p class="muted" role="status">{msg}</p>{/if}
  </section>
{/if}

<style>
  .up { margin: 1.6rem 0 0; position: relative; z-index: 1; }
  h2 { font-size: clamp(1.05rem, 1.6vw, 1.4rem); font-weight: 600; margin: 0 var(--pad-x) .6rem; }
  .track { display: flex; gap: .6rem; overflow-x: auto; padding: 0 var(--pad-x) .8rem; scrollbar-width: thin; scroll-snap-type: x proximity; }
  .c, .ph { flex: 0 0 150px; scroll-snap-align: start; } .ph { aspect-ratio: 2 / 3; }
  .c { background: var(--surface); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; }
  .c img, .noimg { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; background: #222; display: grid; place-items: center; text-align: center; padding: .4rem; }
  /* Cards stretch to the tallest one; the text block fills the card and the action sits at the bottom, so all buttons line up */
  .t { flex: 1; padding: .5rem .6rem .7rem; display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; }
  .name { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.6em; line-height: 1.3; } /* always two lines of space */
  .act { margin-top: auto; padding-top: .35rem; min-height: 44px; display: flex; align-items: center; }
  .act button { width: 100%; min-height: 36px; padding: .3rem .6rem; font-size: .85rem; }
</style>
