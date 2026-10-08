<script lang="ts">
  import UpcomingRow from '$lib/UpcomingRow.svelte';
</script>
<svelte:head><title>Demnächst – FriendFlix</title></svelte:head>
<h1>Demnächst</h1>
<p class="muted">Kommende Titel. Mit einem Klick auf „Wünschen“ landen sie bei den Admins zur Freigabe.</p>
<div class="bleed"><UpcomingRow type="movie" title="Kommende Filme" /><UpcomingRow type="tv" title="Kommende Serien" /></div>
<style>.bleed { margin: 0 calc(var(--pad-x) * -1); }</style>
