<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * What the updater says about Live TV on its own, also while detection still sees the container: `stop_failed` (a job turned it off
   * but could not stop it; the next job retries; shown only while no job runs) and "an update turned it off: reason" (the updater's `livetv.error`).
   */
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { errorKey, stopFailedShown, type LivetvAdminState } from './state';

  export let s: LivetvAdminState;
  $: l = s.updater.livetv;
  $: stopFailed = stopFailedShown(s);
  $: dropped = l?.error && l.state !== 'enabled' ? l.error : null;
  const reason = (c: string | null) => $t(`adminLive.err.${errorKey(c)}` as 'adminLive.err.generic');
</script>

{#if stopFailed}<p class="msg" role="status" data-note="stop_failed"><Icon name="alert" size={18} /><span>{$t('adminLive.err.stopFailed')}</span></p>{/if}
{#if dropped}<p class="msg" role="status" data-note="dropped"><Icon name="info" size={18} /><span>{$t('adminLive.err.dropped', { reason: reason(dropped) })}</span></p>{/if}

<style>
  .msg { display: flex; gap: .5rem; align-items: flex-start; margin: 0 0 .8rem; overflow-wrap: anywhere; min-width: 0; }
  .msg :global(svg) { flex: none; margin-top: .1rem; }
</style>
