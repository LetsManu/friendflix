<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  type Res = { itemId: string; name: string; type: string; ok: boolean; status: number | null; ms: number; bytes: number; error: string | null };
  let s: { running: boolean; done: number; total: number; startedAt: string | null; finishedAt: string | null; results: Res[] } | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let err = '';
  $: failed = s?.results.filter((r) => !r.ok) ?? [];
  $: good = s?.results.filter((r) => r.ok) ?? [];
  const stop = () => { clearInterval(timer); timer = undefined; };
  async function load() {
    s = await api('/api/admin/playback-check');
    if (s?.running && !timer) timer = setInterval(load, 3000);
    else if (!s?.running && timer) stop();
  }
  async function start() {
    err = '';
    try { await api('/api/admin/playback-check', { method: 'POST' }); } catch (e: any) { err = e.status === 409 ? 'Es läuft bereits eine Prüfung.' : 'Start fehlgeschlagen.'; }
    await load();
  }
  onMount(load);
  onDestroy(stop);
</script>
<p class="muted">Wandelt von jedem Titel einige Sekunden um (ein Titel nach dem anderen) und listet alle, bei denen Jellyfin scheitert. Das kann lange dauern.</p>
<div class="flex" style="margin-bottom:1rem">
  <button disabled={s?.running} on:click={start}>Prüfung starten</button>
  {#if s?.running}<span class="muted">{s.done} / {s.total || '…'}</span>{/if}
  {#if s && !s.running && s.finishedAt}<span class="muted">Letzte Prüfung: {new Date(s.finishedAt).toLocaleString('de-DE')}</span>{/if}
  {#if err}<span class="err">{err}</span>{/if}
</div>
{#if s?.running}<progress style="width:100%;margin-bottom:1rem" max={s.total || 1} value={s.done}></progress>{/if}
{#if s && (s.results.length || s.finishedAt)}
  <h3 class:err={failed.length} class:ok={!failed.length}>{failed.length ? `${failed.length} fehlgeschlagen` : 'Keine Fehler'}</h3>
  {#each failed as r}
    <div class="panel">
      <b class="err">{r.name}</b> <span class="muted">{r.type === 'Series' ? 'Serie' : 'Film'}{r.status ? ` · HTTP ${r.status}` : ''}</span>
      <div class="err" style="word-break:break-all">{r.error}</div>
      {#if r.error?.includes('500')}<div class="muted">Jellyfin konnte nicht umwandeln – FFmpeg-Log in Jellyfin prüfen (z. B. Tone-Mapping / Hardwarebeschleunigung)</div>{/if}
    </div>
  {/each}
  <details class="panel">
    <summary>{good.length} OK</summary>
    {#each good as r}<div class="flex"><span>{r.name}</span><span class="muted">{(r.ms / 1000).toFixed(1)} s</span></div>{/each}
  </details>
{/if}
