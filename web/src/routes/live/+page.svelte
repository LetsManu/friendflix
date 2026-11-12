<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { features, featuresKnown } from '#lib/capabilities';
  import { t } from '#lib/i18n';
  import { kidsMode } from '#lib/kids';
  import { pageStore } from '#lib/page';
  import { runAction } from '#lib/ui/action';
  import { channels as fetchChannels, favourite, setFavouriteOrder, type LiveChannel, type LiveList } from '#lib/live/api';
  import { minute } from '#lib/live/fade';
  import FavOrderSheet from '#lib/live/FavOrderSheet.svelte';
  import { starSync } from '#lib/live/favStar';
  import FavTiles from '#lib/live/FavTiles.svelte';
  import GroupChips from '#lib/live/GroupChips.svelte';
  import KidsLive from '#lib/live/KidsLive.svelte';
  import LiveList_ from '#lib/live/LiveList.svelte';
  import { channelOrder, type LiveFilter } from '#lib/live/order';
  import { watchPath } from '#lib/live/progress';
  import TvLiveList from '#lib/live/TvLiveList.svelte';

  /**
   * /live (spec §11): the favourites row, the group chips and the channel grid on desktop and phone; the 10-foot list on a TV
   * (`html.tv`, TvLiveList, §11.3); big tiles for a kids profile (KidsLive, §11.4). `?play=last` (TV startet mit Live-TV) opens the
   * player of the profile's last channel, or the list when there is none.
   * The list is fetched with its ETag and refreshed every 30 s (and when the tab comes back), so a minute of programme data
   * arrives without a reload; the layout reserves every slot (rows, lines, the time-left slot), so arriving data moves nothing.
   */
  const REFRESH_MS = 30_000;
  const page = pageStore();

  let list: LiveList | null = null;
  let etag: string | undefined;
  let failed = false;
  let busy = false;
  let filter: LiveFilter = 'all';
  /** the shell turned the TV layout on (html.tv): paired TVs, or the `?tv=1` preview */
  let tvMode = false;

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
    const html = document.documentElement;
    const sync = () => { tvMode = html.classList.contains('tv'); };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['class'] });
    void load();
    const every = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    const back = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', back);
    return () => { mo.disconnect(); clearInterval(every); document.removeEventListener('visibilitychange', back); };
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

  /** the player, with the filter the list is on: it decides the zapping order there (`?f=`, spec §12.2) */
  const open = (c: LiveChannel) => void goto(`${watchPath(c.id)}?f=${encodeURIComponent(filter)}`);

  // `?play=last`: the profile's last channel plays at once. The parameter goes first (a replaced history entry), so Back from the
  // player lands on the plain list, and from there Home. Without a last channel (or one the person no longer sees) the list stays.
  let playDone = false;
  $: wantPlay = $page.url.searchParams.get('play') === 'last';
  $: playing = wantPlay && !playDone && !failed;
  $: if (list && wantPlay && !playDone) startPlay(list);
  function startPlay(l: LiveList) { playDone = true; void playLast(l); }
  async function playLast(l: LiveList) {
    const c = l.last ? l.channels.find((x) => x.id === l.last!.id) : undefined;
    const u = new URL(location.href);
    u.searchParams.delete('play');
    await goto(u.pathname + u.search, { replaceState: true });
    if (c) open(c);
  }

  /** the star: the list changes at once (favourites keep their order, a new one goes last); a refused call puts it back with a toast */
  function setFavourite(id: string, on: boolean) {
    if (!list) return;
    list = {
      ...list,
      channels: list.channels.map((c) => (c.id === id ? { ...c, favourite: on } : c)),
      favourites: on ? [...list.favourites.filter((f) => f !== id), id] : list.favourites.filter((f) => f !== id),
    };
  }
  // *Ordnen*: the sheet stores the complete order; the list follows at once, so the row, the chip and the player's zapping use it
  let orderOpen = false;
  let orderTrigger: HTMLElement | null = null;
  const openOrder = (el: HTMLElement) => { orderTrigger = el; orderOpen = true; };
  async function saveOrder(ids: string[]): Promise<void> {
    await setFavouriteOrder(ids);
    if (list) list = { ...list, favourites: [...ids, ...list.favourites.filter((f) => !ids.includes(f))] }; // favourites the person cannot see keep their place behind
  }
  // the star (R27): the latest press per channel always wins; a press during a running save is sent right after it, never dropped
  const stars = starSync({
    show: setFavourite,
    send: async (id, on) => (await runAction({ key: `live-fav:${id}`, run: () => favourite(id, on) })).ok,
  });
  const toggleStar = (c: LiveChannel) => void stars.toggle(c.id, list?.channels.find((x) => x.id === c.id)?.favourite ?? c.favourite);
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('live.title') })}</title></svelte:head>

<div class="live" class:tv={tvMode && !$kidsMode} class:kids={$kidsMode}>
  <div class="head"><h1>{$t('live.title')}</h1></div>

  {#if failed}
    <div class="panel failed" role="alert">
      <p>{$t('live.loadFailed')}</p>
      <button type="button" class="sec" on:click={retry}>{$t('live.player.retry')}</button>
    </div>
  {:else if $kidsMode}
    <KidsLive channels={shown} {favs} now={$minute} loading={loading || playing} none={!!list && !list.channels.length} on:open={(e) => open(e.detail)} on:star={(e) => toggleStar(e.detail)} on:order={(e) => openOrder(e.detail)} />
  {:else if tvMode}
    <TvLiveList channels={shown} all={list?.channels ?? []} {favs} {groups} {filter} recent={recent.length > 0} last={list?.last?.id ?? null} now={$minute} loading={loading || playing} none={!!list && !list.channels.length}
      on:open={(e) => open(e.detail)} on:star={(e) => toggleStar(e.detail)} on:select={(e) => (filter = e.detail)} on:order={(e) => openOrder(e.detail)} />
  {:else}
    <FavTiles channels={favs} now={$minute} {loading} on:open={(e) => open(e.detail)} on:order={(e) => openOrder(e.detail)} />
    <GroupChips {groups} value={filter} recent={recent.length > 0} {loading} on:select={(e) => (filter = e.detail)} />
    <LiveList_ channels={shown} now={$minute} {loading} {filter} none={!!list && !list.channels.length} on:open={(e) => open(e.detail)} on:star={(e) => toggleStar(e.detail)} />
  {/if}
</div>

{#if orderOpen}
  <FavOrderSheet rows={favs} save={saveOrder} tv={tvMode} trigger={orderTrigger} on:close={() => (orderOpen = false)} />
{/if}

<style>
  .live { max-width: 1400px; margin: 0 auto; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 44px; margin-bottom: 1rem; }
  h1 { margin: 0; }
  .failed { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 72px; }
  .failed p { margin: 0; }
  /* TV: the whole width of the page frame, the heading at TV size (1u = 1 px at a 1080p viewport) */
  .tv { --u: calc(100vw / 1920); max-width: none; }
  .tv h1 { font-size: calc(var(--u) * 44); line-height: calc(var(--u) * 56); }
  .tv .head { min-height: calc(var(--u) * 64); margin-bottom: calc(var(--u) * 8); padding-left: calc(var(--u) * 28); }
  /* kids: the heading in the kids ink */
  .kids h1 { color: #20233a; font-weight: 900; }
  @media (max-width: 720px) {
    .head { margin-bottom: .6rem; }
  }
</style>
