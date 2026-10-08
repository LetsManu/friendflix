<script lang="ts">
  import { page } from '$app/stores';
  const tabs: Array<[string, string]> = [['/admin', 'Nutzer'], ['/admin/status', 'Status'], ['/admin/invites', 'Einladungen'], ['/admin/requests', 'Wünsche'], ['/admin/polls', 'Abstimmungen'], ['/admin/devices', 'Geräte'], ['/admin/audit', 'Audit-Log']];
</script>
<h1>Admin</h1>
<div class="flex" style="margin-bottom:1rem">
  {#each tabs as [href, label]}<a {href} class="btn" class:sec={$page.url.pathname !== href}>{label}</a>{/each}
</div>
<slot />
