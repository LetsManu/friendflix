<script lang="ts">
  import Logo from '$lib/Logo.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { api } from '$lib/api';
  import { qrPath } from '$lib/qr';

  let code = '', poll = '', expires = 0, error = '', qr: { size: number; d: string } | null = null;
  let timer: ReturnType<typeof setInterval>, dead = false, linking = false;

  async function newCode() {
    error = '';
    try {
      const r = await api<{ code: string; pollToken: string; expiresIn: number }>('/api/tv/code', { method: 'POST' });
      code = r.code; poll = r.pollToken; expires = Date.now() + r.expiresIn * 1000 - 5000;
      qr = qrPath(`${location.origin}/remote?code=${r.code}`);
    } catch { error = 'Der Server ist gerade nicht erreichbar – neuer Versuch …'; code = ''; }
  }
  async function tick() {
    if (dead) return;
    if (!code || Date.now() > expires) return newCode();
    try {
      const r = await api<{ status: string }>('/api/tv/claim', { method: 'POST', body: { code, pollToken: poll } });
      if (r.status === 'ok') { dead = true; linking = true; clearInterval(timer); location.replace('/'); }
    } catch (e: any) { if (e?.status === 404) await newCode(); }
  }

  onMount(async () => {
    document.documentElement.classList.add('tv');
    try { // already a paired TV: straight to the portal
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.ok && (await r.json()).tv) { location.replace('/'); return; }
    } catch { /* offline: show the code screen anyway */ }
    await newCode();
    timer = setInterval(tick, 2000);
  });
  onDestroy(() => { dead = true; clearInterval(timer); document.documentElement.classList.remove('tv'); });
</script>

<svelte:head><title>Fernseher verbinden – FriendFlix</title></svelte:head>
<main class="pair">
  <div class="txt">
    <span class="logo"><Logo wordmark size={52} /></span>
    <h1>Fernseher verbinden</h1>
    <ol>
      <li>Öffne FriendFlix auf deinem Handy und tippe auf <b>Menü › Fernbedienung</b> – oder scanne den QR-Code.</li>
      <li>Gib dort diesen Code ein und bestätige:</li>
    </ol>
    {#if linking}
      <p class="code" role="status">Verbunden …</p>
    {:else if code}
      <p class="code" aria-live="polite" aria-label="Kopplungscode {code.split('').join(' ')}">{code}</p>
    {:else}
      <p class="code dim" role="status">…</p>
    {/if}
    <p class="muted small">Der Code ist 10 Minuten gültig, gilt nur einmal und wird automatisch erneuert.</p>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
  </div>
  {#if qr}
    <figure class="qr">
      <svg viewBox="-2 -2 {qr.size + 4} {qr.size + 4}" shape-rendering="crispEdges" role="img" aria-label="QR-Code zum Koppeln"><rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" /><path d={qr.d} fill="#000" /></svg>
      <figcaption class="muted">Mit der Handy-Kamera scannen</figcaption>
    </figure>
  {/if}
</main>

<style>
  .pair { min-height: 100vh; display: flex; align-items: center; justify-content: center; gap: clamp(2rem, 7vw, 7rem); padding: 3rem var(--pad-x); background: radial-gradient(900px 500px at 20% 10%, rgba(229, 15, 42, .16), transparent 70%), var(--bg); flex-wrap: wrap; }
  .txt { max-width: 38rem; }
  .logo { display: inline-flex; }
  h1 { font-size: clamp(2rem, 4.5vw, 3.2rem); margin: 1.2rem 0 1rem; }
  ol { color: #e5e5e5; font-size: 1.15rem; padding-left: 1.3rem; display: grid; gap: .5rem; }
  .code { font-size: clamp(2.6rem, 7vw, 5rem); font-weight: 800; letter-spacing: .14em; font-variant-numeric: tabular-nums; margin: 1.2rem 0 .8rem; padding: .3rem 1.2rem; background: var(--surface); border: 2px solid var(--line); border-radius: 12px; display: inline-block; font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace; }
  .code.dim { opacity: .4; }
  .small { font-size: .95rem; }
  .qr { margin: 0; text-align: center; }
  .qr svg { width: clamp(180px, 24vw, 320px); height: auto; border-radius: 14px; display: block; }
  figcaption { margin-top: .6rem; font-size: .95rem; }
</style>
