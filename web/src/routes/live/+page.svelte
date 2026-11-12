<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { features, featuresKnown } from '#lib/capabilities';
  import { t } from '#lib/i18n';
  import { runAction } from '#lib/ui/action';
  import { channels as fetchChannels, favourite, type LiveChannel, type LiveList } from '#lib/live/api';
  import { minute } from '#lib/live/fade';
  import FavTiles from '#lib/live/FavTiles.svelte';
  import GroupChips from '#lib/live/GroupChips.svelte';
  import LiveList_ from '#lib/live/LiveList.svelte';
  import { channelOrder, type LiveFilter } from '#lib/live/order';
  import { watchPath } from '#lib/live/progress';

  /**
   * /live (spec §11): the favourites row, the group chips and the channel grid, on desktop and phone (the TV layout is Task 37).
   * The list is fetched with its ETag and refreshed every 30 s (and when the tab comes back), so a minute of programme data
   * arrives without a reload; the layout reserves every slot (rows, lines, the time-left slot), so arriving data moves nothing.
   */
  const REFRESH_MS = 30_000;

  let list: LiveList | null = null;
  let etag: string | undefined;
  let failed = false;
  let busy = false;
  let filter: LiveFilter = 'all';

  async function load(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const r = await fetchChannels(etag);
      if (!r.notModified) { list = r.list; etag = r.etag ?? undefined; }
      failed = false;
    } catch {
      // a refresh that fails keeps what is on screen; only a first load that fails shows the message
      if (!list) failed = true;
    } finally { busy = false; }
  }
  const retry = () => { failed = false; void load(); };

  onMount(() => {
    void load();
    const every = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    const back = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(every); document.removeEventListener('visibilitychange', back); };
  });

  // Live TV off (or not for this person): there is no such page
  $: if ($featuresKnown && !$features.livetv) void goto('/', { replaceState: true });

  $: loading = list === null && !failed;
  $: favs = list ? channelOrder(list.channels, 'fav', list.favourites, []) : [];
  $: recent = list ? channelOrder(list.channels, 'recent', list.favourites, list.recent) : [];
  $: groups = list?.groups ?? [];
  // a chip that disappeared (the last recent channel, a group the admin removed) falls back to All
  $: if (list && ((filter === 'recent' && !recent.length) || (filter !== 'all' && filter !== 'fav' && filter !== 'recent' && !groups.some((g) => g.id === filter)))) filter = 'all';
  $: shown = list ? channelOrder(list.channels, filter, list.favourites, list.recent) : [];

  /** the player; a route the client does not know (a build without it) is a plain page load, so a tap never does nothing */
  const open = (c: LiveChannel) => { const to = watchPath(c.id); void goto(to).catch(() => { location.href = to; }); };

  /** the star: the list changes at once (favourites keep their order, a new one goes last); a refused call puts it back with a toast */
  function setFavourite(id: string, on: boolean) {
    if (!list) return;
    list = {
      ...list,
      channels: list.channels.map((c) => (c.id === id ? { ...c, favourite: on } : c)),
      favourites: on ? [...list.favourites.filter((f) => f !== id), id] : list.favourites.filter((f) => f !== id),
    };
  }
  function toggleStar(c: LiveChannel) {
    const on = !c.favourite;
    void runAction({
      key: `live-fav:${c.id}`,
      apply: () => { setFavourite(c.id, on); return () => setFavourite(c.id, !on); },
      run: () => favourite(c.id, on),
    });
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('live.title') })}</title></svelte:head>

<div class="live">
  <div class="head"><h1>{$t('live.title')}</h1></div>

  {#if failed}
    <div class="panel failed" role="alert">
      <p>{$t('live.loadFailed')}</p>
      <button type="button" class="sec" on:click={retry}>{$t('live.player.retry')}</button>
    </div>
  {:else}
    <FavTiles channels={favs} now={$minute} {loading} on:open={(e) => open(e.detail)} />
    <GroupChips {groups} value={filter} recent={recent.length > 0} {loading} on:select={(e) => (filter = e.detail)} />
    <LiveList_ channels={shown} now={$minute} {loading} {filter} none={!!list && !list.channels.length} on:open={(e) => open(e.detail)} on:star={(e) => toggleStar(e.detail)} />
  {/if}
</div>

<style>
  .live { max-width: 1400px; margin: 0 auto; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 44px; margin-bottom: 1rem; }
  h1 { margin: 0; }
  .failed { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 72px; }
  .failed p { margin: 0; }
  @media (max-width: 720px) {
    .head { margin-bottom: .6rem; }
  }
</style>
