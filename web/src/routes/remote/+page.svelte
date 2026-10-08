<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api, fmtClock, img, type Item } from '$lib/api';
  import Icon from '$lib/Icon.svelte';
  import { castToTv, holdRemote, sendToTv, tvOnline, tvStatus } from '$lib/remote';

  let release: (() => void) | undefined;
  let codeIn = '', fromLink = false, msg = '', busy = false, pairOpen = true;
  let resume: Item[] = [], nextUp = new Map<string, Item>(), q = '', results: Item[] | null = null, sent = '', sentT: ReturnType<typeof setTimeout>, seq = 0, searchT: ReturnType<typeof setTimeout>;

  $: st = $tvStatus;
  $: playing = Boolean(st?.itemId);
  $: pct = st?.duration ? Math.min(100, ((st.position ?? 0) / st.duration) * 100) : 0;
  $: if ($tvOnline) pairOpen = false;

  const fmtCode = (v: string) => { const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c; };
  const onCode = () => (codeIn = fmtCode(codeIn));

  async function pair() {
    busy = true; msg = '';
    try {
      await api('/api/tv/pair', { method: 'POST', body: { code: codeIn } });
      msg = 'Gekoppelt – der Fernseher meldet sich in wenigen Sekunden an.'; codeIn = ''; fromLink = false;
    } catch (e: any) {
      msg = e?.status === 404 ? 'Code unbekannt oder abgelaufen. Prüfe den Code auf dem Fernseher.' : e?.status === 409 ? 'Dieser Code wurde schon verwendet.' : 'Koppeln fehlgeschlagen.';
    }
    busy = false;
  }

  const confirmed = (t: string) => { sent = t; clearTimeout(sentT); sentT = setTimeout(() => (sent = ''), 2500); };
  async function ctl(action: 'play' | 'pause' | 'toggle' | 'seekBy' | 'stop' | 'home' | 'next' | 'audio' | 'sub', value?: number) {
    if (!(await sendToTv({ t: 'ctl', action, value }))) confirmed('Keine Verbindung zum Fernseher');
  }
  async function cast(id: string, name: string) {
    confirmed((await castToTv(id)) ? `„${name}“ wird auf dem Fernseher gestartet …` : 'Keine Verbindung zum Fernseher');
  }
  /** what a click on "play on TV" starts: movies/episodes directly, series via their next-up episode */
  const target = (i: Item): Item | null => (i.type === 'Series' ? nextUp.get(i.id) ?? null : i);

  function search() {
    clearTimeout(searchT);
    const term = q.trim();
    if (term.length < 2) { results = null; return; }
    const my = ++seq;
    searchT = setTimeout(async () => {
      try { const r = (await api(`/api/library/items?q=${encodeURIComponent(term)}&types=Movie,Series&limit=12`)).items as Item[]; if (my === seq) results = r; } catch { if (my === seq) results = []; }
    }, 250);
  }

  onMount(() => {
    release = holdRemote();
    const c = $page.url.searchParams.get('code');
    if (c) { codeIn = fmtCode(c); fromLink = true; }
    api('/api/library/resume').then((r) => (resume = r.items)).catch(() => undefined);
    api('/api/library/nextup').then((r) => (nextUp = new Map((r.items as Item[]).filter((e) => e.seriesId).map((e) => [e.seriesId!, e])))).catch(() => undefined);
  });
  onDestroy(() => { release?.(); clearTimeout(sentT); clearTimeout(searchT); });
</script>

<svelte:head><title>Fernbedienung – FriendFlix</title></svelte:head>
<div class="remote">
  <h1><Icon name="tv" size={30} /> Fernbedienung</h1>

  <section class="panel status" aria-live="polite">
    <div class="state"><span class="led" class:on={$tvOnline} aria-hidden="true"></span><b>{$tvOnline ? 'Fernseher verbunden' : 'Kein Fernseher verbunden'}</b></div>
    {#if $tvOnline}
      {#if playing}
        <p class="now"><b>{st?.title ?? 'Wiedergabe'}</b><span class="muted">{st?.paused ? 'Pausiert' : 'Läuft'}{st?.duration ? ` · ${fmtClock(st.position ?? 0)} / ${fmtClock(st.duration)}` : ''}</span></p>
        <div class="bar" aria-hidden="true"><i style="width:{pct}%"></i></div>
      {:else}<p class="muted">Der Fernseher zeigt gerade die Startseite. Wähle unten einen Titel.</p>{/if}
    {:else}
      <p class="muted">Schalte den Fernseher ein und öffne dort <b>{location.host}/tv</b> im Browser. Sobald er verbunden ist, erscheint hier die Fernbedienung.</p>
    {/if}
  </section>

  {#if $tvOnline}
    <section class="panel pad" aria-label="Steuerung">
      <div class="keys">
        <button class="sec" aria-label="60 Sekunden zurück" on:click={() => ctl('seekBy', -60)}>−60</button>
        <button class="sec" aria-label="10 Sekunden zurück" on:click={() => ctl('seekBy', -10)}><Icon name="rewind10" size={30} /></button>
        <button class="main light" aria-label={st?.paused === false ? 'Pause' : 'Abspielen'} on:click={() => ctl('toggle')}><Icon name={st?.paused === false ? 'pause' : 'play'} size={38} /></button>
        <button class="sec" aria-label="10 Sekunden vor" on:click={() => ctl('seekBy', 10)}><Icon name="forward10" size={30} /></button>
        <button class="sec" aria-label="60 Sekunden vor" on:click={() => ctl('seekBy', 60)}>+60</button>
      </div>
      <div class="flex keys2">
        <button class="sec" on:click={() => ctl('stop')} disabled={!playing}><Icon name="stop" size={18} />Beenden</button>
        <button class="sec" on:click={() => ctl('next')} disabled={!playing}><Icon name="skip-next" size={20} />Nächste Folge</button>
        <button class="sec" on:click={() => ctl('home')}><Icon name="home" size={20} />Startseite</button>
      </div>
      {#if st?.audio && st.audio.length > 1}
        <label class="tl" for="aud">Ton</label>
        <select id="aud" value={st.audioSel} on:change={(e) => ctl('audio', Number(e.currentTarget.value))}>{#each st.audio as a}<option value={a.i}>{a.t}</option>{/each}</select>
      {/if}
      {#if st?.subs && st.subs.length}
        <label class="tl" for="sbt">Untertitel</label>
        <select id="sbt" value={st.subSel ?? -1} on:change={(e) => ctl('sub', Number(e.currentTarget.value))}><option value={-1}>Aus</option>{#each st.subs as a}<option value={a.i}>{a.t}</option>{/each}</select>
      {/if}
    </section>

    {#if resume.length}
      <h2>Weiter schauen</h2>
      <ul class="list">
        {#each resume.slice(0, 10) as i (i.id)}
          <li>
            <span class="th">{#if i.image}<img loading="lazy" src={img(i.id, 200)} alt="" />{/if}</span>
            <span class="tx"><b>{i.seriesName ?? i.name}</b><span class="muted">{i.type === 'Episode' ? `S${i.parentIndexNumber}:E${i.indexNumber} · ${i.name}` : i.year ?? ''}</span></span>
            <button class="light" on:click={() => cast(i.id, i.seriesName ?? i.name)}><Icon name="play" size={18} />Auf TV</button>
          </li>
        {/each}
      </ul>
    {/if}

    <h2>Titel suchen</h2>
    <form role="search" on:submit|preventDefault={search}>
      <label class="sr-only" for="rq">Titel suchen</label>
      <input id="rq" class="wide" type="search" placeholder="Film oder Serie …" bind:value={q} on:input={search} />
    </form>
    {#if results}
      <ul class="list">
        {#each results as i (i.id)}
          {@const t = target(i)}
          <li>
            <span class="th">{#if i.image}<img loading="lazy" src={img(i.id, 200)} alt="" />{/if}</span>
            <span class="tx"><b>{i.name}</b><span class="muted">{i.type === 'Series' ? 'Serie' : i.year ?? ''}</span></span>
            {#if t}<button class="light" on:click={() => cast(t.id, i.name)}><Icon name="play" size={18} />{i.type === 'Series' ? `S${t.parentIndexNumber}:E${t.indexNumber}` : 'Auf TV'}</button>
            {:else}<a class="btn sec" href="/item/{i.id}">Folgen</a>{/if}
          </li>
        {:else}<li class="muted">Keine Treffer.</li>{/each}
      </ul>
    {/if}
  {/if}

  <details class="panel pair" bind:open={pairOpen}>
    <summary><b>{$tvOnline ? 'Weiteren Fernseher koppeln' : 'Fernseher koppeln'}</b></summary>
    <p class="muted">Öffne auf dem Fernseher im Browser <b>{location.host}/tv</b>. Dort erscheint ein Code (oder ein QR-Code zum Scannen). Gib ihn hier ein:</p>
    {#if fromLink}<p class="warn" role="note">Dieser Code kam über einen Link. Koppel nur, wenn <b>{codeIn}</b> genau so jetzt auf deinem Fernseher steht – sonst könnte jemand anderes Zugriff auf dein Konto bekommen.</p>{/if}
    <form class="flex" on:submit|preventDefault={pair}>
      <label class="sr-only" for="code">Code vom Fernseher</label>
      <input id="code" class="code" bind:value={codeIn} on:input={onCode} placeholder="ABCD-EFGH" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="9" />
      <button disabled={busy || codeIn.replace('-', '').length < 8}>Koppeln</button>
    </form>
    {#if msg}<p role="status" class:ok={msg.startsWith('Gekoppelt')} class:err={!msg.startsWith('Gekoppelt')}>{msg}</p>{/if}
    <p class="muted small">Der Fernseher bleibt 30 Tage angemeldet (7 Tage ohne Nutzung) und erscheint unter „Geräte“ – dort kannst du ihn jederzeit sperren.</p>
  </details>

  {#if sent}<div class="toast" role="status">{sent}</div>{/if}
</div>

<style>
  .remote { max-width: 720px; }
  h1 { display: flex; align-items: center; gap: .6rem; }
  .state { display: flex; align-items: center; gap: .6rem; }
  .led { width: 12px; height: 12px; border-radius: 50%; background: #666; } .led.on { background: var(--ok); box-shadow: 0 0 10px var(--ok); }
  .now { display: flex; flex-direction: column; margin: .6rem 0 .4rem; }
  .keys { display: grid; grid-template-columns: 1fr 1fr 1.5fr 1fr 1fr; gap: .6rem; align-items: stretch; }
  .keys button { min-height: 64px; font-size: 1.05rem; padding: 0; min-width: 0; }
  .keys .main { min-height: 78px; border-radius: 14px; }
  .keys2 { margin-top: .8rem; }
  .tl { display: block; margin: .9rem 0 .2rem; } select { width: 100%; }
  .pad { padding: 1.1rem; }
  .list { list-style: none; padding: 0; margin: 0 0 1.2rem; display: grid; gap: .5rem; }
  .list li { display: grid; grid-template-columns: 92px 1fr auto; gap: .8rem; align-items: center; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: .5rem .7rem .5rem .5rem; }
  .th { aspect-ratio: 16 / 9; background: #222; border-radius: 4px; overflow: hidden; display: block; } .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tx { display: flex; flex-direction: column; min-width: 0; } .tx b, .tx .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wide { width: 100%; font-size: 1.05rem; margin-bottom: .8rem; }
  .pair { margin-top: 1.5rem; } summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
  .code { font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 1.5rem; letter-spacing: .15em; text-transform: uppercase; width: 11ch; text-align: center; }
  .small { font-size: .85rem; }
  .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(76px + env(safe-area-inset-bottom)); background: rgba(20, 20, 20, .96); border: 1px solid #444; padding: .7rem 1.1rem; border-radius: 8px; z-index: 70; max-width: 90vw; }
</style>
