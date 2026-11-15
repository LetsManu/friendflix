<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getActiveProfile } from '#lib/api';
  import { features, featuresKnown } from '#lib/capabilities';
  import { t } from '#lib/i18n';
  import { kidsMode } from '#lib/kids';
  import RecordingsRow from './RecordingsRow.svelte';
  import { doneRecordings, listRecordings, type Recording } from './recordings';

  /**
   * *Deine Aufnahmen* on the home page (DVR follow-ups): the profile's finished recordings (done, partial; its own and the ones shared
   * with it), newest first, as the Live-TV tab's tiles; *Alle* opens Meine Aufnahmen. Only with Live TV for this profile, asked once
   * /api/me has answered (like the upcoming row). Its room is reserved while it loads (the row's skeleton) whenever this profile had
   * finished recordings on its last visit (a per-profile hint in the browser), so the rows below do not jump when it arrives; without
   * that hint nothing shows until there is something. It sits low on the page (above *Demnächst*). Not on a TV (its side bar has
   * *Aufnahmen*).
   */
  const hintKey = () => `ff-home-recs:${getActiveProfile() ?? ''}`;
  const readHint = (): boolean => { try { return localStorage.getItem(hintKey()) === '1'; } catch { return false; } };
  const writeHint = (on: boolean) => { try { if (on) localStorage.setItem(hintKey(), '1'); else localStorage.removeItem(hintKey()); } catch { /* private mode */ } };

  /** null while loading */
  let recs: Recording[] | null = null;
  let hinted = readHint();
  let mounted = false, started = false;
  onMount(() => { mounted = true; });
  $: on = !$kidsMode && (!$featuresKnown || $features.livetv);
  $: if (mounted && $featuresKnown && $features.livetv && !$kidsMode && !started) {
    started = true;
    listRecordings('done').then((r) => { recs = doneRecordings(r.recordings); writeHint(recs.length > 0); }).catch(() => { recs = []; });
  }
  // Live TV is off for this profile after all: no row, and no reserved room next time
  $: if ($featuresKnown && !$features.livetv && hinted) { hinted = false; writeHint(false); }
</script>

{#if on && (recs === null ? hinted : recs.length > 0)}<RecordingsRow recordings={recs} canRecord title={$t('home.rows.recordings')} home />{/if}
