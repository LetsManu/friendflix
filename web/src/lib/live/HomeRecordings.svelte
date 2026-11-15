<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { features, featuresKnown } from '#lib/capabilities';
  import { t } from '#lib/i18n';
  import { kidsMode } from '#lib/kids';
  import RecordingsRow from './RecordingsRow.svelte';
  import { doneRecordings, listRecordings, type Recording } from './recordings';

  /**
   * *Deine Aufnahmen* on the home page (DVR follow-ups): the profile's finished recordings (done, partial; its own and the ones shared
   * with it), newest first, as the Live-TV tab's tiles; *Alle* opens Meine Aufnahmen. Only with Live TV for this profile, asked once
   * /api/me has answered (like the upcoming row); nothing shows while it loads, when it fails or when there is nothing finished. It sits
   * low on the page (above *Demnächst*), so its arrival moves nothing in view at the top. Not on a TV (its side bar has *Aufnahmen*).
   */
  let recs: Recording[] = [];
  let mounted = false, started = false;
  onMount(() => { mounted = true; });
  $: if (mounted && $featuresKnown && $features.livetv && !$kidsMode && !started) {
    started = true;
    listRecordings('done').then((r) => { recs = doneRecordings(r.recordings); }).catch(() => undefined);
  }
</script>

{#if recs.length}<RecordingsRow recordings={recs} title={$t('home.rows.recordings')} home />{/if}
