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
  onMount(() => { load(); void loadDl(); });
  onDestroy(stop);

  // ---- Offline downloads: prepared files and active licenses ----
  type DlJob = { id: string; item_id: string; quality: string; audio_lang: string; status: string; seg_done: number; seg_total: number | null; bytes: string | number | null; error: string | null; updated_at: string; licenses: number };
  type DlLic = { id: string; item_id: string; title: string | null; series_name: string | null; user_name: string; device_label: string | null; quality: string; status: string; expires_at: string };
  let dl: { enabled: boolean; maxBytes: number; diskBytes: number; jobs: DlJob[]; licenses: DlLic[] } | null = null;
  let dlErr = '';
  const gb = (b: number | string | null | undefined) => (Number(b ?? 0) / 1e9).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' GB';
  const STATUS: Record<string, string> = { queued: 'wartet', preparing: 'wird vorbereitet', ready: 'bereit', failed: 'fehlgeschlagen', pending: 'ausstehend', fetched: 'geladen' };
  async function loadDl() {
    try { const r = await api('/api/admin/downloads'); dl = { enabled: Boolean(r.enabled), maxBytes: r.maxBytes ?? 0, diskBytes: r.diskBytes ?? 0, jobs: r.jobs ?? [], licenses: r.licenses ?? [] }; dlErr = ''; } catch { dlErr = 'Downloads konnten nicht geladen werden.'; }
  }
  async function revoke(id: string) {
    if (!confirm('Diese Download-Lizenz widerrufen? Das Gerät löscht die Kopie bei der nächsten Online-Prüfung.')) return;
    try { await api(`/api/admin/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { dlErr = 'Widerrufen nicht möglich.'; }
    await loadDl();
  }
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

<h2>Offline-Downloads</h2>
<p class="muted">Vom Server vorbereitete Dateien und aktive Lizenzen. Ältere Dateien werden automatisch entfernt, sobald der Speichergrenzwert (<code>DOWNLOAD_CACHE_MAX_GB</code>) erreicht ist.</p>
{#if dlErr}<p class="err">{dlErr}</p>{/if}
{#if dl}
  {#if !dl.enabled}<p class="muted">Downloads sind serverseitig abgeschaltet (<code>DOWNLOADS_ENABLED=false</code>).</p>{/if}
  <div class="flex"><span>Speicher: {gb(dl.diskBytes)} von {gb(dl.maxBytes)}</span><button class="sec" on:click={loadDl}>Aktualisieren</button></div>
  <progress style="width:100%;margin:.5rem 0 1rem" max={dl.maxBytes || 1} value={dl.diskBytes}></progress>
  <h3>Vorbereitung ({dl.jobs.length})</h3>
  {#each dl.jobs as j (j.id)}
    <div class="panel">
      <b>{j.item_id}</b> <span class="muted">{j.quality} · {STATUS[j.status] ?? j.status}{j.status === 'preparing' && j.seg_total ? ` · ${Math.round((j.seg_done / j.seg_total) * 100)} %` : ''}{j.bytes ? ` · ${gb(j.bytes)}` : ''} · {j.licenses} Lizenz(en)</span>
      {#if j.error}<div class="err" style="word-break:break-all">{j.error}</div>{/if}
    </div>
  {:else}<p class="muted">Keine Jobs.</p>{/each}
  <h3>Aktive Lizenzen ({dl.licenses.length})</h3>
  {#each dl.licenses as l (l.id)}
    <div class="panel flex">
      <span><b>{l.series_name ? `${l.series_name} · ` : ''}{l.title ?? l.item_id}</b> <span class="muted">{l.user_name}{l.device_label ? ` · ${l.device_label}` : ''} · {l.quality} · {STATUS[l.status] ?? l.status} · bis {new Date(l.expires_at).toLocaleDateString('de-DE')}</span></span>
      <button class="sec" on:click={() => revoke(l.id)}>Widerrufen</button>
    </div>
  {:else}<p class="muted">Keine aktiven Lizenzen.</p>{/each}
{/if}
