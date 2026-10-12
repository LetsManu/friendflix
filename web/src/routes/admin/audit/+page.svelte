<script lang="ts">
  import { intlLocale } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  let entries: any[] = [];
  onMount(async () => (entries = (await api('/api/admin/audit?limit=200')).entries));
</script>
<table>
  <thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Details</th></tr></thead>
  <tbody>{#each entries as e}<tr><td>{new Date(e.at).toLocaleString(intlLocale())}</td><td>{e.actor ?? 'System'}</td><td>{e.action}</td><td class="muted">{JSON.stringify(e.meta)}</td></tr>{/each}</tbody>
</table>
