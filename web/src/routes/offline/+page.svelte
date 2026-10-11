<svelte:head><title>Keine Verbindung</title></svelte:head>

<section class="offline" id="main">
  <h1>Keine Verbindung</h1>
  <p>FriendFlix kann gerade nicht erreicht werden. Prüfe deine Internetverbindung und versuche es erneut.</p>
  <button class="btn" type="button" on:click={() => location.assign('/')}>Erneut versuchen</button>
</section>

<style>
  .offline { min-height: 60vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; text-align: center; padding: 2rem 1rem; }
  h1 { margin: 0; }
  p { margin: 0; max-width: 32rem; opacity: 0.8; }
</style>
