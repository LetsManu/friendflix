<script lang="ts">
  import { pageStore } from '#lib/page';
  const page = pageStore();
  const tabs: Array<[string, string]> = [['/admin', 'Nutzer'], ['/admin/status', 'Status'], ['/admin/previews', 'Vorschauen'], ['/admin/playback', 'Wiedergabe-Check'], ['/admin/digest', 'Wochenrückblick'], ['/admin/invites', 'Einladungen'], ['/admin/requests', 'Wünsche'], ['/admin/polls', 'Abstimmungen'], ['/admin/lists', 'Listen'], ['/admin/roles', 'Rollen'], ['/admin/devices', 'Geräte'], ['/admin/audit', 'Audit-Log'], ['/admin/update', 'Update']];
</script>
<h1>Admin</h1>
<div class="flex" style="margin-bottom:1rem">
  {#each tabs as [href, label]}<a {href} class="btn" class:sec={$page.url.pathname !== href}>{label}</a>{/each}
</div>
<slot />
