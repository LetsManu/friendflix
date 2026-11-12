<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { get } from 'svelte/store';
  import { afterNavigate, goto } from '$app/navigation';
  import { features, featuresKnown } from '#lib/capabilities';
  import { t } from '#lib/i18n';
  import LivePlayer from '#lib/live/LivePlayer.svelte';
  import { pageStore } from '#lib/page';

  /**
   * /live/watch/<channelId>?f=<filter> (spec §12): the live player. `f` is the list's filter (all, fav, recent or a group id) and
   * decides the zapping order. The player changes the address itself on a switch (shallow, no navigation), so the channel is read
   * once per real navigation, never from the shallow update: a zap never re-creates the player.
   */
  const page = pageStore();
  const read = () => { const p = get(page); return { id: p.params.channelId ?? '', f: p.url.searchParams.get('f') || 'all' }; };
  let id = read().id;
  let f = read().f;
  afterNavigate(() => { const n = read(); if (n.id !== id) { id = n.id; f = n.f; } });

  // Live TV off (or not for this person): there is no such page
  $: if ($featuresKnown && !$features.livetv) void goto('/', { replaceState: true });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('live.title') })}</title></svelte:head>

{#key id}
  <LivePlayer channelId={id} filter={f} />
{/key}
