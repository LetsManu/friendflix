<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import Icon from '$lib/Icon.svelte';
  let s: any = null, c: any = null, year = new Date().getFullYear();
  const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  async function load() { s = await api(`/api/stats/me?year=${year}`); c = await api('/api/stats/community'); }
  onMount(load);
  $: max = s ? Math.max(1, ...s.byMonth.map((m: any) => m.minutes)) : 1;
</script>

<h1>Dein Wrapped <select bind:value={year} on:change={load}>{#each [0, 1, 2] as d}<option>{new Date().getFullYear() - d}</option>{/each}</select></h1>
{#if s}
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
    <div class="panel"><h2>{Math.floor(s.totalMinutes / 60)} h {s.totalMinutes % 60} min</h2><span class="muted">geschaut</span></div>
    <div class="panel"><h2>{s.titles}</h2><span class="muted">verschiedene Titel</span></div>
    <div class="panel"><h2>{s.movies} / {s.episodes}</h2><span class="muted">Filme / Folgen</span></div>
    <div class="panel"><h2>{s.favoriteWeekday ?? '–'}</h2><span class="muted">Lieblingstag</span></div>
  </div>
  <div class="panel"><h3>Top 5</h3><ol>{#each s.topItems as t}<li>{t.name} <span class="muted">· {t.minutes} min</span></li>{/each}</ol></div>
  <div class="panel"><h3>Pro Monat</h3>
    <div style="display:flex;gap:.4rem;align-items:flex-end;height:120px">
      {#each months as m, i}{@const v = s.byMonth.find((x: any) => x.m === i + 1)?.minutes ?? 0}
        <div style="flex:1;text-align:center"><div style="background:var(--acc);height:{(v / max) * 100}px;border-radius:3px 3px 0 0" title="{v} min"></div><small class="muted">{m}</small></div>{/each}
    </div></div>
  <h3>Achievements</h3>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
    {#each s.achievements as a}<div class="panel" style="opacity:{a.earnedAt ? 1 : 0.4}"><span class="ach"><Icon name={a.icon} size={26} /></span> <b>{a.title}</b><br /><small class="muted">{a.desc}</small></div>{/each}
  </div>
{/if}
{#if c}
  <h3>Diesen Monat in der Gruppe</h3>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
    <div class="panel"><b>Bestenliste</b><ol>{#each c.leaderboard as l}<li>{l.name} <span class="muted">· {Math.round(l.minutes / 60 * 10) / 10} h</span></li>{/each}</ol></div>
    <div class="panel"><b>Meistgeschaut</b><ol>{#each c.topTitles as t}<li>{t.name} <span class="muted">· {t.viewers} Zuschauer</span></li>{/each}</ol></div>
  </div>
{/if}
<style>.ach { display: inline-grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: var(--surface-2); color: var(--acc); vertical-align: middle; }</style>
