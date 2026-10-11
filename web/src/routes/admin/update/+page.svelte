<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  const HINT: Record<string, string> = { ENOTFOUND: 'Hostname nicht auflösbar, IP statt nas.local verwenden', EAI_AGAIN: 'DNS-Fehler, IP verwenden', ECONNREFUSED: 'Port geschlossen, Adresse/Port prüfen', EHOSTUNREACH: 'Host nicht erreichbar, Netzwerk/Firewall prüfen', ETIMEDOUT: 'Zeitüberschreitung, Firewall prüfen', ECONNRESET: 'Verbindung abgebrochen' };
  const STEP: Record<string, string> = { webhook: 'Webhook-Aufruf (URL prüfen)', stack: 'Stack-Abfrage (Stack-ID / API-Key prüfen)', stack_file: 'Stack-Datei lesen', redeploy: 'Redeploy (Endpoint-ID prüfen)' };
  let u: any = null;
  let busy = false;
  let force = false;
  let err = '';
  let phase: '' | 'started' | 'restarting' | 'done' | 'timeout' = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  const sha7 = (s: string) => s.slice(0, 7);
  const dt = (d?: string | null) => (d ? new Date(d).toLocaleString('de-DE') : 'unbekannt');
  async function load(refresh = false) {
    busy = true;
    try { u = await api('/api/admin/update' + (refresh ? '?refresh=1' : '')); } finally { busy = false; }
  }
  $: upToDate = u?.behind === 0;
  async function start() {
    if (!confirm('Portal jetzt aktualisieren? Alle Dienste starten kurz neu, laufende Streams brechen ab.')) return;
    err = '';
    try { await api('/api/admin/update', { method: 'POST' }); } catch (e: any) {
      err = e.status === 429 ? 'Es wurde gerade erst ein Update angestoßen. Bitte zwei Minuten warten.' : e.status === 409 ? 'Portainer ist nicht konfiguriert.' : e.body?.error === 'portainer_unreachable' ? `Portainer nicht erreichbar${e.body?.code ? ` (${e.body.code}${HINT[e.body.code] ? `: ${HINT[e.body.code]}` : ''})` : ''}. Details im Backend-Log.` : `Portainer-Fehler${e.body?.status ? ` (HTTP ${e.body.status})` : ''}${e.body?.step ? ` bei ${STEP[e.body.step] ?? e.body.step}` : ''}. Details im Backend-Log.`;
      return;
    }
    phase = 'started';
    const t0 = Date.now();
    const target = u.latest?.sha ?? u.current.sha;
    let down = false; // forced reload of the same version is only detectable by the restart gap
    timer = setInterval(async () => {
      if (Date.now() - t0 > 5 * 60_000) { stop(); phase = 'timeout'; return; }
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        if (!r.ok) throw new Error();
        const { sha } = await r.json();
        if (sha === target && (sha !== u.current.sha || down)) { stop(); phase = 'done'; setTimeout(() => location.reload(), 1500); }
      } catch { down = true; phase = 'restarting'; }
    }, 3000);
  }
  function stop() { clearInterval(timer); timer = undefined; }
  onMount(() => load());
  onDestroy(stop);
</script>
<p class="muted">Portainer aktualisiert automatisch alle 12 Stunden. Mit dem Knopf geht es sofort.</p>
{#if u}
  <div class="panel">
    <div class="flex">
      <span>Installiert: <b>{sha7(u.current.sha)}</b> vom {dt(u.current.builtAt)}</span>
      {#if u.latest}
        <span class={upToDate ? 'ok' : 'warn'}>{upToDate ? 'Aktuell' : u.behind ? `${u.behind} Updates verfügbar` : 'Unbekannter Stand'}</span>
      {/if}
      <button class="sec" style="margin-left:auto" disabled={busy || !!phase} on:click={() => load(true)}>Neu prüfen</button>
    </div>
    {#if u.latest}
      <div>Neueste Version: <b>{sha7(u.latest.sha)}</b> vom {dt(u.latest.date)} · <a href={u.latest.runUrl} target="_blank" rel="noopener">CI-Lauf</a></div>
    {:else}
      <div class="err">Neueste Version nicht abrufbar ({u.error ?? 'unbekannt'}).</div>
    {/if}
    {#if u.current.sha === 'dev'}<div class="muted">Lokaler Entwicklungs-Build: kein Versionsvergleich möglich.</div>{/if}
  </div>
  <div class="panel">
    <div class="flex">
      <button disabled={!u.portainer.configured || !!phase || busy || (upToDate && !force)} on:click={start}>Jetzt aktualisieren</button>
      {#if upToDate}<label class="flex"><input type="checkbox" bind:checked={force} /> trotzdem neu laden</label>{/if}
    </div>
    {#if !u.portainer.configured}
      <p class="muted">Nicht eingerichtet. In der <code>.env</code> setzen: <code>PORTAINER_WEBHOOK_URL</code> oder <code>PORTAINER_URL</code>, <code>PORTAINER_API_KEY</code>, <code>PORTAINER_STACK_ID</code> (optional <code>PORTAINER_ENDPOINT_ID</code>).</p>
    {/if}
    {#if err}<p class="err">{err}</p>{/if}
    {#if phase === 'started'}<p class="warn">Update angestoßen … warte auf neue Version</p>{/if}
    {#if phase === 'restarting'}<p class="warn">Server startet neu …</p>{/if}
    {#if phase === 'done'}<p class="ok">Update fertig</p>{/if}
    {#if phase === 'timeout'}<p class="err">Zeitüberschreitung – bitte in Portainer prüfen</p>{/if}
  </div>
  {#if u.commits.length}
    <h2>Änderungen</h2>
    {#each u.commits as c (c.sha)}
      <div class="panel flex">
        <a href={c.url} target="_blank" rel="noopener">{c.message}</a>
        <span class="muted" style="margin-left:auto">{c.author} · {dt(c.date)}</span>
      </div>
    {/each}
  {/if}
{/if}
