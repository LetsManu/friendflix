<script lang="ts">
  import { onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type Item } from '$lib/api';
  import Icon from '$lib/Icon.svelte';
  import Player from '$lib/Player.svelte';
  import { prefs } from '$lib/stores';

  let video: HTMLVideoElement | null = null;
  let item: Item | null = null, nextEp: Item | null = null;
  let sleepAfterEpisode = false;
  let showNext = false, countdown = 0, cd: ReturnType<typeof setInterval>;
  $: id = $page.params.id!;

  $: id, (async () => {
    item = null; nextEp = null; stopCountdown(); showNext = false;
    try {
      item = (await api(`/api/items/${id}`)).item;
      if (item?.type === 'Episode' && item.seriesId) nextEp = (await api('/api/library/nextup')).items.find((e: Item) => e.seriesId === item!.seriesId && e.id !== id) ?? null;
    } catch { /* player shows its own error */ }
  })();

  const back = () => (history.length > 1 ? history.back() : goto('/'));
  function stopCountdown() { clearInterval(cd); countdown = 0; }
  function startCountdown() {
    if (!nextEp) return;
    if (sleepAfterEpisode || !$prefs.autoplayNext) { showNext = true; countdown = 0; return; } // wait for the viewer's click
    showNext = true; countdown = 8; clearInterval(cd);
    cd = setInterval(() => { countdown -= 1; if (countdown <= 0) { stopCountdown(); goto(`/watch/${nextEp!.id}`); } }, 1000);
  }
  function onTime() { if (video && nextEp && !showNext && video.duration && video.duration - video.currentTime < 25) showNext = true; }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !document.fullscreenElement) back(); }
  onDestroy(stopCountdown);
</script>

<svelte:window on:keydown={onKey} />
<svelte:head><title>{item?.name ?? 'Wiedergabe'} – FriendFlix</title></svelte:head>
<div class="wrap">
  {#key id}
    <Player itemId={id} bind:video bind:sleepAfterEpisode hasNext={Boolean(nextEp)} on:next={() => nextEp && goto(`/watch/${nextEp.id}`)} on:timeupdate={onTime} on:ended={startCountdown}>
      <div slot="top" class="top">
        <button class="icon-btn" aria-label="Zurück" on:click={back}><Icon name="arrow-left" size={30} /></button>
        {#if item}<div class="ttl"><b>{item.seriesName ?? item.name}</b>{#if item.seriesName}<span>S{item.parentIndexNumber}:E{item.indexNumber} „{item.name}“</span>{/if}</div>{/if}
      </div>
      {#if showNext && nextEp}
        <div class="next" role="dialog" aria-label="Nächste Folge">
          <div class="nt"><span class="muted">Nächste Folge</span><b>S{nextEp.parentIndexNumber}:E{nextEp.indexNumber} · {nextEp.name}</b>{#if countdown}<span class="muted">Start in {countdown} s</span>{/if}</div>
          <div class="flex"><a class="btn light" href="/watch/{nextEp.id}"><Icon name="play" size={20} />Jetzt ansehen</a>{#if countdown}<button class="sec" on:click={() => { stopCountdown(); showNext = false; }}>Abbrechen</button>{/if}</div>
        </div>
      {/if}
    </Player>
  {/key}
</div>

<style>
  .wrap { position: fixed; inset: 0; background: #000; z-index: 40; }
  .wrap :global(.stage) { height: 100%; }
  .top { padding: .8rem 1rem; display: flex; align-items: center; gap: .6rem; background: linear-gradient(rgba(0,0,0,.8), transparent); }
  .ttl { display: flex; flex-direction: column; line-height: 1.2; } .ttl span { color: var(--mut); font-size: .9rem; }
  .next { position: absolute; right: var(--pad-x); bottom: 8.5rem; z-index: 9; background: rgba(20,20,20,.94); border: 1px solid #444; border-radius: 8px; padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: .8rem; max-width: min(380px, 92vw); }
  .nt { display: flex; flex-direction: column; gap: .15rem; }
</style>
