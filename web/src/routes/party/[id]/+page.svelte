<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';
  import Player from '$lib/Player.svelte';

  const EMOJIS = ['😂', '😮', '😢', '❤️', '👏', '🔥', '👍', '🍿'];
  const DRIFT = 0.3; // seconds: seek when further apart than ~300 ms
  let video: HTMLVideoElement | null = null;
  let ws: WebSocket | null = null;
  let itemId = '', title = '', you = '', hostId = '', startAt: number | undefined;
  let members: Array<{ id: string; name: string; buffering: boolean }> = [];
  let chat: Array<{ name: string; text: string }> = [], text = '';
  let floating: Array<{ id: number; emoji: string; left: number }> = [];
  let state = { playing: false, position: 0, at: 0, hold: false };
  let offset = 0, bestRtt = Infinity, error = '', needClick = false, countdown = '', ready = false;
  let timers: ReturnType<typeof setInterval>[] = [];
  let suppressUntil = 0, n = 0;

  $: isHost = you !== '' && you === hostId;
  const serverNow = () => Date.now() + offset;
  const expected = () => (state.playing && !state.hold ? state.position + (serverNow() - state.at) / 1000 : state.position);
  const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  async function apply() {
    if (!video || !ready) return;
    suppressUntil = Date.now() + 400; // our own programmatic play/pause must not be echoed to the room
    const exp = expected();
    const drift = video.currentTime - exp;
    if (state.hold || !state.playing) {
      if (!video.paused) video.pause();
      if (Math.abs(drift) > 0.1) video.currentTime = exp;
    } else {
      if (Math.abs(drift) > DRIFT) video.currentTime = exp;
      video.playbackRate = Math.abs(drift) > 0.08 && Math.abs(drift) <= DRIFT ? (drift > 0 ? 0.95 : 1.05) : 1;
      if (video.paused) await video.play().catch(() => (needClick = true));
    }
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/party/${$page.params.id}`);
    ws.onclose = (e) => { if (e.code === 4404) error = 'Raum nicht gefunden.'; else if (e.code === 4409) error = 'Raum ist voll.'; else if (!error) setTimeout(connect, 2000); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') { ({ you, hostId, itemId, title, startAt } = m); members = m.members; state = m.state; offset = m.serverNow - Date.now(); }
      else if (m.t === 'members') { hostId = m.hostId; members = m.members; }
      else if (m.t === 'state') { state = m.state; offset = m.serverNow - Date.now(); apply(); }
      else if (m.t === 'chat') chat = [...chat.slice(-199), { name: m.name, text: m.text }];
      else if (m.t === 'react') { const id = ++n; floating = [...floating, { id, emoji: m.emoji, left: 10 + Math.random() * 80 }]; setTimeout(() => (floating = floating.filter((f) => f.id !== id)), 2500); }
      else if (m.t === 'pong') { const rtt = Date.now() - m.c; if (rtt < bestRtt || Math.random() < 0.1) { bestRtt = Math.min(rtt, bestRtt * 1.2); offset = m.s + rtt / 2 - Date.now(); } }
    };
  }

  function bindVideo() {
    if (!video) return;
    const host = (playing: boolean) => { if (isHost && Date.now() > suppressUntil) send({ t: 'state', playing, position: video!.currentTime }); };
    video.addEventListener('play', () => host(true));
    video.addEventListener('pause', () => host(false));
    video.addEventListener('seeked', () => host(!video!.paused));
    video.addEventListener('waiting', () => send({ t: 'buffering', value: true }));
    for (const ev of ['canplay', 'playing', 'seeked']) video.addEventListener(ev, () => send({ t: 'buffering', value: false }));
  }

  function onReady() { ready = true; bindVideo(); send({ t: 'buffering', value: true }); video?.addEventListener('canplay', () => apply(), { once: true }); }
  const sendChat = () => { if (text.trim()) { send({ t: 'chat', text }); text = ''; } };

  onMount(() => {
    connect();
    timers.push(setInterval(() => send({ t: 'ping', c: Date.now() }), 3000));
    timers.push(setInterval(apply, 1000)); // continuous drift correction
    timers.push(setInterval(() => { countdown = startAt && Date.now() < startAt ? `Start in ${Math.ceil((startAt - serverNow()) / 1000)} s` : ''; }, 500));
  });
  onDestroy(() => { timers.forEach(clearInterval); error = 'closed'; ws?.close(); });
</script>

{#if error && error !== 'closed'}<p class="err">{error}</p>{/if}
<div style="display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:1rem">
  <div style="position:relative">
    <h2>{title || 'Watch-Party'} {#if countdown}<span class="badge">{countdown}</span>{/if}</h2>
    {#if itemId}<Player {itemId} bind:video on:ready={onReady} />{/if}
    {#if needClick}<p class="warn">Dein Browser blockiert Autoplay. <button on:click={() => { needClick = false; apply(); }}>Mitschauen</button></p>{/if}
    {#if state.hold}<p class="warn">⏳ Warte auf alle Teilnehmer (Puffer) …</p>{/if}
    <div style="pointer-events:none;position:absolute;inset:0;overflow:hidden">{#each floating as f (f.id)}<span style="position:absolute;bottom:10%;left:{f.left}%;font-size:2rem;animation:up 2.5s ease-out forwards">{f.emoji}</span>{/each}</div>
    <div class="flex" style="margin-top:.6rem">{#each EMOJIS as e}<button class="sec" on:click={() => send({ t: 'react', emoji: e })}>{e}</button>{/each}</div>
  </div>
  <div class="panel" style="display:flex;flex-direction:column;height:70vh">
    <b>Dabei ({members.length})</b>
    <div class="muted" style="font-size:.85rem">{#each members as m}<span>{m.name}{m.id === hostId ? ' 👑' : ''}{m.buffering ? ' ⏳' : ''} </span>{/each}</div>
    <div style="flex:1;overflow:auto;margin:.6rem 0">{#each chat as c}<div><b>{c.name}:</b> {c.text}</div>{/each}</div>
    <form class="flex" on:submit|preventDefault={sendChat}><input bind:value={text} maxlength="500" placeholder="Nachricht …" style="flex:1" /><button>↵</button></form>
    <small class="muted">{isHost ? 'Du bist Host: deine Steuerung gilt für alle.' : 'Nur der Host steuert Play/Pause/Spulen.'}</small>
  </div>
</div>
<style>@keyframes up { from { transform: translateY(0); opacity: 1 } to { transform: translateY(-260px); opacity: 0 } }</style>
