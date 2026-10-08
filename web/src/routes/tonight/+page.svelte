<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';
  import Icon from '$lib/Icon.svelte';

  // Mood -> genre names (matched case-insensitively against the library's own genre list, German or English metadata)
  const MOODS: Array<{ id: string; label: string; re: RegExp }> = [
    { id: 'laugh', label: 'Lachen', re: /kom(ö|oe)die|comedy/i },
    { id: 'tension', label: 'Spannung', re: /thriller|krimi|crime|mystery|horror/i },
    { id: 'action', label: 'Action & Abenteuer', re: /action|abenteuer|adventure|science|sci-?fi|fantasy/i },
    { id: 'heart', label: 'Gefühl', re: /drama|romanz|romance|liebe/i },
    { id: 'family', label: 'Für alle', re: /familie|family|animation|kinder/i },
    { id: 'know', label: 'Etwas lernen', re: /dokumentation|documentary|geschichte|history|biograf/i },
  ];
  const TIMES: Array<[string, string, number]> = [['short', 'Kurz (bis 90 Min.)', 90], ['normal', 'Normal (bis 2 Std.)', 120], ['long', 'Egal, ich hab Zeit', 0]];
  const KINDS: Array<[string, string]> = [['Movie', 'Film'], ['Series', 'Serie'], ['Movie,Series', 'Egal']];

  let genres: string[] = [], mood = new Set<string>(), time = 'normal', kind = 'Movie,Series', picks: Item[] | null = null, busy = false, tried = false, seen = new Set<string>();
  onMount(async () => { genres = (await api('/api/library/genres').catch(() => ({ genres: [] }))).genres; });

  const toggle = (id: string) => { const s = new Set(mood); if (s.has(id)) s.delete(id); else s.add(id); mood = s; };
  async function find(again = false) {
    busy = true; tried = true;
    if (!again) seen = new Set();
    const names = MOODS.filter((m) => mood.has(m.id)).flatMap((m) => genres.filter((g) => m.re.test(g)));
    const maxMin = TIMES.find((t) => t[0] === time)![2];
    try {
      const q = new URLSearchParams({ types: kind, filter: 'unplayed', sort: 'Random', limit: '60' });
      if (names.length) q.set('genre', [...new Set(names)].join('|'));
      const items = ((await api(`/api/library/items?${q}`)).items as Item[])
        .filter((i) => !seen.has(i.id) && (!maxMin || i.type === 'Series' || !i.runtimeTicks || i.runtimeTicks <= maxMin * 600_000_000));
      // best rated first among the random draw, so every suggestion is worth it
      picks = items.sort((a, b) => (b.communityRating ?? 0) - (a.communityRating ?? 0)).slice(0, 3);
      picks.forEach((p) => seen.add(p.id));
    } catch { picks = []; }
    busy = false;
  }
</script>

<svelte:head><title>Heute Abend – FriendFlix</title></svelte:head>
<h1>Was passt heute Abend?</h1>
<p class="muted">Drei Fragen, drei Vorschläge – nur Titel, die du noch nicht gesehen hast.</p>

<section class="panel q" aria-label="Stimmung">
  <h2>Worauf hast du Lust?</h2>
  <div class="chips" role="group" aria-label="Stimmung, mehrere möglich">{#each MOODS as m}<button class="chip" class:on={mood.has(m.id)} aria-pressed={mood.has(m.id)} on:click={() => toggle(m.id)}>{m.label}</button>{/each}</div>
  <small class="muted">Nichts gewählt = alles.</small>
</section>
<section class="panel q" aria-label="Zeit">
  <h2>Wie viel Zeit hast du?</h2>
  <div class="chips" role="radiogroup">{#each TIMES as [v, l]}<button class="chip" class:on={time === v} role="radio" aria-checked={time === v} on:click={() => (time = v)}>{l}</button>{/each}</div>
</section>
<section class="panel q" aria-label="Art">
  <h2>Film oder Serie?</h2>
  <div class="chips" role="radiogroup">{#each KINDS as [v, l]}<button class="chip" class:on={kind === v} role="radio" aria-checked={kind === v} on:click={() => (kind = v)}>{l}</button>{/each}</div>
</section>

<div class="flex"><button on:click={() => find(false)} disabled={busy}><Icon name="shuffle" size={20} />Vorschläge zeigen</button>{#if picks?.length}<button class="sec" on:click={() => find(true)} disabled={busy}>Andere Vorschläge</button>{/if}</div>

{#if picks}
  {#if picks.length}<div class="tiles picks">{#each picks as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>
  {:else if tried}<p class="muted" style="margin-top:1.5rem">Dazu habe ich nichts Ungesehenes gefunden. Wähle weniger Filter oder mehr Zeit.</p>{/if}
{/if}

<style>
  .q h2 { font-size: 1.05rem; margin: 0 0 .6rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .4rem; }
  .chip { background: var(--surface-2); border-radius: 999px; font-weight: 500; padding: .5rem 1.1rem; }
  .chip.on { background: #fff; color: #000; }
  .picks { margin-top: 1.5rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
</style>
