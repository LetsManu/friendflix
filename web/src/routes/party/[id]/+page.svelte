<script lang="ts">
  let innerWidth = 1200;
  import { onDestroy, onMount, tick } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import Icon from '$lib/Icon.svelte';
  import Player from '$lib/Player.svelte';

  const EMOJIS = ['😂', '😮', '😢', '❤️', '👏', '🔥', '👍', '🍿'];
  const DRIFT = 0.3; // seconds: seek when further apart than ~300 ms
  type Member = { id: string; name: string; buffering: boolean };
  let video: HTMLVideoElement | null = null;
  let ws: WebSocket | null = null;
  let itemId = '', title = '', you = '', hostId = '', mode: 'host' | 'everyone' = 'host', startAt: number | undefined;
  let members: Member[] = [];
  let chat: Array<{ id: number; name: string; text: string; mine: boolean }> = [], recent: typeof chat = [], text = '', unread = 0, panel = false, picker = false, settings = false, copied = false;
  let floating: Array<{ id: number; emoji: string; left: number; name: string }> = [];
  let state = { playing: false, position: 0, at: 0, hold: false };
  let offset = 0, bestRtt = Infinity, error = '', needClick = false, countdown = '', ready = false, n = 0, closing = false;
  let timers: ReturnType<typeof setInterval>[] = [];
  let suppressUntil = 0, chatEl: HTMLDivElement;

  $: isHost = you !== '' && you === hostId;
  $: canControl = isHost || mode === 'everyone';
  $: waitingFor = members.filter((m) => m.buffering).map((m) => m.name);
  const serverNow = () => Date.now() + offset;
  const expected = () => (state.playing && !state.hold ? state.position + (serverNow() - state.at) / 1000 : state.position);
  const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  async function apply() {
    if (!video || !ready) return;
    suppressUntil = Date.now() + 450; // programmatic play/pause/seek must not be echoed back to the room
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
    ws.onclose = (e) => { if (closing) return; if (e.code === 4404) error = 'Raum nicht gefunden.'; else if (e.code === 4409) error = 'Der Raum ist voll.'; else if (e.code === 4401) error = 'Bitte neu anmelden.'; else setTimeout(connect, 2000); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') { ({ you, hostId, itemId, title, startAt } = m); mode = m.mode; members = m.members; state = m.state; offset = m.serverNow - Date.now(); }
      else if (m.t === 'members') { hostId = m.hostId; mode = m.mode; members = m.members; }
      else if (m.t === 'state') { state = m.state; offset = m.serverNow - Date.now(); apply(); }
      else if (m.t === 'chat') {
        const msg = { id: ++n, name: m.name, text: m.text, mine: m.from === you };
        chat = [...chat.slice(-199), msg];
        recent = [...recent.slice(-3), msg]; setTimeout(() => (recent = recent.filter((r) => r.id !== msg.id)), 9000);
        if (!panel && !msg.mine) unread++;
        tick().then(() => chatEl && (chatEl.scrollTop = chatEl.scrollHeight));
      }
      else if (m.t === 'react') { const id = ++n; floating = [...floating, { id, emoji: m.emoji, left: 8 + Math.random() * 40, name: m.name }]; setTimeout(() => (floating = floating.filter((f) => f.id !== id)), 3200); }
      else if (m.t === 'pong') { const rtt = Date.now() - m.c; if (rtt < bestRtt || Math.random() < 0.1) { bestRtt = Math.min(rtt, bestRtt * 1.2); offset = m.s + rtt / 2 - Date.now(); } }
    };
  }

  function bindVideo() {
    if (!video) return;
    const control = (playing: boolean) => { if (canControl && Date.now() > suppressUntil) send({ t: 'state', playing, position: video!.currentTime }); };
    video.addEventListener('play', () => control(true));
    video.addEventListener('pause', () => control(false));
    video.addEventListener('seeked', () => control(!video!.paused));
    video.addEventListener('waiting', () => send({ t: 'buffering', value: true }));
    for (const ev of ['canplay', 'playing', 'seeked']) video.addEventListener(ev, () => send({ t: 'buffering', value: false }));
  }
  function onReady() { ready = true; bindVideo(); send({ t: 'buffering', value: true }); video?.addEventListener('canplay', () => apply(), { once: true }); }

  const sendChat = () => { if (text.trim()) { send({ t: 'chat', text }); text = ''; } };
  const react = (emoji: string) => { send({ t: 'react', emoji }); picker = false; };
  const setMode = (v: 'host' | 'everyone') => send({ t: 'mode', value: v });
  function togglePanel() { panel = !panel; picker = settings = false; if (panel) { unread = 0; tick().then(() => chatEl && (chatEl.scrollTop = chatEl.scrollHeight)); } }
  async function copyLink() { try { await navigator.clipboard.writeText(location.href); copied = true; setTimeout(() => (copied = false), 1800); } catch { /* ignore */ } }
  const back = () => (history.length > 1 ? history.back() : goto('/party'));
  const initial = (s: string) => s.slice(0, 1).toUpperCase();

  onMount(() => {
    connect();
    timers.push(setInterval(() => send({ t: 'ping', c: Date.now() }), 3000));
    timers.push(setInterval(apply, 1000)); // continuous drift correction
    timers.push(setInterval(() => { countdown = startAt && Date.now() < startAt ? `Start in ${Math.max(0, Math.ceil((startAt - serverNow()) / 1000))} s` : ''; }, 500));
  });
  onDestroy(() => { closing = true; timers.forEach(clearInterval); ws?.close(); });
</script>

<svelte:window bind:innerWidth />
<svelte:head><title>{title || 'Watch-Party'} – FriendFlix</title></svelte:head>
<div class="wrap">
  {#if error}<div class="fatal"><p class="err">{error}</p><a class="btn" href="/party">Zur Übersicht</a></div>{/if}
  {#if itemId}
    <Player itemId={itemId} bind:video partyMode {canControl} inset={panel && innerWidth > 720 ? 340 : 0} denyHint="Nur der Host steuert die Wiedergabe." on:ready={onReady}>
      <div slot="top" class="top">
        <button class="icon-btn" aria-label="Party verlassen" on:click={back}><Icon name="arrow-left" size={30} /></button>
        <div class="ttl"><b>{title}</b><span>Watch-Party{#if countdown} · {countdown}{/if}</span></div>
        <span class="sp"></span>
        <ul class="avatars" aria-label="Teilnehmer ({members.length})">
          {#each members as m (m.id)}
            <li class:buf={m.buffering} title="{m.name}{m.id === hostId ? ' (Host)' : ''}{m.buffering ? ' – lädt' : ''}">
              <span class="av">{initial(m.name)}</span>{#if m.id === hostId}<span class="crown"><Icon name="crown" size={12} fill /></span>{/if}
            </li>
          {/each}
        </ul>
        <button class="icon-btn" aria-label="Einladungslink kopieren" title="Einladungslink kopieren" on:click={copyLink}><Icon name={copied ? 'check' : 'link'} size={24} /></button>
      </div>

      {#if state.hold && waitingFor.length}<div class="hold" role="status"><div class="spin"></div>Warte auf {waitingFor.join(', ')} …</div>{/if}
      {#if needClick}<div class="hold"><button on:click|stopPropagation={() => { needClick = false; apply(); }}><Icon name="play" size={20} />Mitschauen</button></div>{/if}

      <div class="floats" aria-hidden="true">{#each floating as f (f.id)}<span class="fl" style="left:{f.left}%"><b>{f.emoji}</b><i>{f.name}</i></span>{/each}</div>

      {#if !panel && recent.length}
        <ul class="bubbles" aria-live="polite">{#each recent as r (r.id)}<li><b>{r.name}</b> {r.text}</li>{/each}</ul>
      {/if}

      {#if panel}
        <aside class="chat" aria-label="Chat" on:click|stopPropagation on:keydown|stopPropagation role="complementary">
          <header><b>Chat</b><button class="icon-btn" aria-label="Chat schließen" on:click={togglePanel}><Icon name="x" size={22} /></button></header>
          <div class="msgs" bind:this={chatEl} role="log" aria-live="polite">
            {#each chat as c (c.id)}<p class:mine={c.mine}><b>{c.name}</b><span>{c.text}</span></p>{:else}<p class="muted">Noch keine Nachrichten. Sag Hallo!</p>{/each}
          </div>
          <form on:submit|preventDefault={sendChat}><input bind:value={text} maxlength="500" placeholder="Nachricht …" aria-label="Nachricht" /><button aria-label="Senden"><Icon name="chevron-right" size={20} /></button></form>
        </aside>
      {/if}

      <svelte:fragment slot="extra">
        {#if isHost}
          <div class="mwrap">
            <button class="ic" aria-label="Party-Einstellungen" aria-expanded={settings} on:click|stopPropagation={() => { settings = !settings; picker = false; }}><Icon name={mode === 'everyone' ? 'users' : 'lock'} size={26} /></button>
            {#if settings}
              <div class="menu" role="dialog" aria-label="Wer darf steuern?" on:click|stopPropagation on:keydown|stopPropagation>
                <h3>Wer darf steuern?</h3>
                <button class="mi" class:on={mode === 'host'} on:click={() => setMode('host')}>{#if mode === 'host'}<Icon name="check" size={16} />{:else}<span class="sp2"></span>{/if}Nur ich (Host)</button>
                <button class="mi" class:on={mode === 'everyone'} on:click={() => setMode('everyone')}>{#if mode === 'everyone'}<Icon name="check" size={16} />{:else}<span class="sp2"></span>{/if}Alle Teilnehmer</button>
              </div>
            {/if}
          </div>
        {:else}
          <span class="roleinfo" title={mode === 'everyone' ? 'Alle dürfen steuern' : 'Nur der Host steuert'}><Icon name={mode === 'everyone' ? 'users' : 'lock'} size={22} /></span>
        {/if}
        <div class="mwrap">
          <button class="ic" aria-label="Reaktion senden" aria-expanded={picker} on:click|stopPropagation={() => { picker = !picker; settings = false; }}><Icon name="smile" size={28} /></button>
          {#if picker}<div class="picker" role="menu" on:click|stopPropagation on:keydown|stopPropagation>{#each EMOJIS as e}<button class="em" role="menuitem" aria-label="Reaktion {e}" on:click={() => react(e)}>{e}</button>{/each}</div>{/if}
        </div>
        <button class="ic chatbtn" aria-label="Chat {panel ? 'schließen' : 'öffnen'}{unread ? `, ${unread} ungelesen` : ''}" aria-expanded={panel} on:click|stopPropagation={togglePanel}>
          <Icon name="message" size={27} />{#if unread}<span class="dot">{unread}</span>{/if}
        </button>
      </svelte:fragment>
    </Player>
  {:else if !error}<div class="fatal"><div class="spin"></div><p class="muted">Verbinde mit der Party …</p></div>{/if}
</div>

<style>
  .wrap { position: fixed; inset: 0; background: #000; z-index: 40; }
  .wrap :global(.stage) { height: 100%; }
  .fatal { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 1rem; }
  .top { padding: .8rem 1rem; display: flex; align-items: center; gap: .6rem; background: linear-gradient(rgba(0,0,0,.8), transparent); }
  .ttl { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; } .ttl b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .ttl span { color: var(--mut); font-size: .88rem; }
  .sp { flex: 1; }
  .avatars { display: flex; list-style: none; margin: 0 .4rem 0 0; padding: 0; }
  .avatars li { position: relative; margin-left: -8px; }
  .av { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #e50f2a, #7a0a17); border: 2px solid #000; font-weight: 800; font-size: .9rem; }
  .buf .av { outline: 2px solid var(--warn); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .55; } }
  .crown { position: absolute; right: -4px; top: -6px; color: #f5c518; }
  .hold { position: absolute; left: 50%; top: 14%; transform: translateX(-50%); background: rgba(20,20,20,.92); padding: .7rem 1.3rem; border-radius: 999px; display: flex; gap: .7rem; align-items: center; z-index: 9; }
  .spin { width: 20px; height: 20px; border: 3px solid #555; border-top-color: var(--acc); border-radius: 50%; animation: sp .9s linear infinite; } @keyframes sp { to { transform: rotate(360deg); } }
  .floats { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 6; }
  .fl { position: absolute; bottom: 14%; display: flex; flex-direction: column; align-items: center; animation: up 3.2s ease-out forwards; }
  .fl b { font-size: 2.4rem; } .fl i { font-style: normal; font-size: .72rem; background: rgba(0,0,0,.6); padding: 0 .4rem; border-radius: 99px; }
  @keyframes up { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-340px); opacity: 0; } }
  .bubbles { position: absolute; left: clamp(.8rem, 2.4vw, 2.4rem); bottom: 9.5rem; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; max-width: min(420px, 70vw); z-index: 6; pointer-events: none; }
  .bubbles li { background: rgba(0,0,0,.62); padding: .35rem .8rem; border-radius: 14px; font-size: .92rem; animation: fadein .25s; } @keyframes fadein { from { opacity: 0; transform: translateY(6px); } }
  .chat { position: absolute; top: 0; right: 0; bottom: 0; width: min(340px, 92vw); background: rgba(14,14,14,.94); z-index: 10; display: flex; flex-direction: column; border-left: 1px solid #2c2c2c; animation: slide var(--t-med) var(--ease); }
  @keyframes slide { from { transform: translateX(100%); } }
  .chat header { display: flex; justify-content: space-between; align-items: center; padding: .6rem .6rem .6rem 1rem; border-bottom: 1px solid #2c2c2c; }
  .msgs { flex: 1; overflow-y: auto; padding: .8rem 1rem; display: flex; flex-direction: column; gap: .5rem; }
  .msgs p { margin: 0; display: flex; flex-direction: column; background: #232323; padding: .4rem .7rem; border-radius: 10px; align-self: flex-start; max-width: 90%; word-break: break-word; }
  .msgs p.mine { align-self: flex-end; background: #5b0d17; } .msgs b { font-size: .75rem; color: var(--mut); }
  .chat form { display: flex; gap: .4rem; padding: .7rem; border-top: 1px solid #2c2c2c; } .chat input { flex: 1; min-width: 0; }
  .ic { background: transparent; padding: 0; width: 48px; min-height: 48px; border-radius: 50%; color: #fff; position: relative; } .ic:hover:not(:disabled) { background: rgba(255,255,255,.14); }
  .roleinfo { display: grid; place-items: center; width: 40px; color: var(--mut); }
  .mwrap { position: relative; }
  .picker { position: absolute; right: 0; bottom: 58px; display: grid; grid-template-columns: repeat(4, 1fr); gap: .2rem; background: rgba(20,20,20,.97); border: 1px solid #3a3a3a; border-radius: 10px; padding: .4rem; z-index: 20; }
  .em { background: transparent; font-size: 1.6rem; width: 48px; padding: 0; } .em:hover:not(:disabled) { background: rgba(255,255,255,.12); transform: scale(1.15); }
  .menu { position: absolute; right: 0; bottom: 58px; background: rgba(20,20,20,.97); border: 1px solid #3a3a3a; border-radius: 6px; padding: .6rem .3rem; min-width: 210px; z-index: 20; }
  .menu h3 { font-size: 1rem; margin: 0 .6rem .4rem; }
  .mi { display: flex; width: 100%; justify-content: flex-start; align-items: center; gap: .5rem; background: transparent; color: #d2d2d2; font-weight: 400; padding: .35rem .6rem; min-height: 40px; border-radius: 4px; } .mi.on { color: #fff; font-weight: 700; } .mi:hover:not(:disabled) { background: rgba(255,255,255,.1); }
  .sp2 { width: 16px; flex: none; }
  .dot { position: absolute; top: 6px; right: 4px; background: var(--acc); font-size: .65rem; min-width: 1.1rem; height: 1.1rem; border-radius: 99px; display: grid; place-items: center; font-weight: 700; }
  @media (max-width: 720px) { .avatars { display: none; } .bubbles { bottom: 8rem; } }
</style>
