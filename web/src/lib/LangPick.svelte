<script lang="ts">
  import { api } from '$lib/api';
  /** movie or episode that would be played (for a series: the next episode) */
  export let targetId: string;
  /** remembers the choice per title/series on this device */
  export let storeKey: string;
  /** chosen audio language ('' = default) and subtitles ('' = my default, 'off' = none) */
  export let audio = '';
  export let sub = '';
  type Tr = { audio: Array<{ language: string; title: string }>; subtitles: Array<{ language: string; title: string }> };
  let tr: Tr | null = null, loadedFor = '';
  const NAMES: Record<string, string> = { ger: 'Deutsch', deu: 'Deutsch', eng: 'Englisch', fre: 'Französisch', fra: 'Französisch', spa: 'Spanisch', ita: 'Italienisch', jpn: 'Japanisch', kor: 'Koreanisch', tur: 'Türkisch', rus: 'Russisch', por: 'Portugiesisch', pol: 'Polnisch', dut: 'Niederländisch', nld: 'Niederländisch', zho: 'Chinesisch', chi: 'Chinesisch', und: 'Unbekannt' };
  const name = (l: { language: string; title: string }) => NAMES[l.language] ?? l.title;

  async function load(id: string) {
    if (!id || id === loadedFor) return;
    loadedFor = id;
    try { tr = await api<Tr>(`/api/items/${id}/tracks`); } catch { tr = null; }
    try { const s = JSON.parse(localStorage.getItem(`ff_lang:${storeKey}`) ?? '{}'); audio = tr?.audio.some((a) => a.language === s.audio) ? s.audio : ''; sub = s.sub === 'off' || tr?.subtitles.some((a) => a.language === s.sub) ? s.sub : ''; } catch { /* none saved */ }
  }
  $: load(targetId);
  const save = () => { try { localStorage.setItem(`ff_lang:${storeKey}`, JSON.stringify({ audio, sub })); } catch { /* private mode */ } };
</script>

{#if tr && (tr.audio.length > 1 || tr.subtitles.length)}
  <div class="lang flex">
    {#if tr.audio.length > 1}
      <label for="lg-a">Sprache</label>
      <select id="lg-a" bind:value={audio} on:change={save}><option value="">Standard</option>{#each tr.audio as a}<option value={a.language}>{name(a)}</option>{/each}</select>
    {/if}
    {#if tr.subtitles.length}
      <label for="lg-s">Untertitel</label>
      <select id="lg-s" bind:value={sub} on:change={save}><option value="">Standard</option><option value="off">Aus</option>{#each tr.subtitles as a}<option value={a.language}>{name(a)}</option>{/each}</select>
    {/if}
  </div>
{/if}

<style>.lang { margin: 0 0 1rem; gap: .5rem .8rem; } .lang label { color: var(--fg); }</style>
