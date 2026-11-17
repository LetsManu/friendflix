<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { t, tr, fmtDate, hasKey, trDynamic } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api } from '#lib/api';
  import TrailerButton from '#lib/TrailerButton.svelte';
  import { episodeKey, loadReminders, movieKey, removeReminder } from '#lib/reminders';
  import { features } from '#lib/capabilities';
  import { pickSeasons, requestCollection, seasonRanges } from '#lib/requests/picker';
  import { submitWish } from '#lib/requests/wish';

  let q = $page.url.searchParams.get('q') ?? '', results: any[] = [], mine: any[] = [], msg = '', busy = false, mineErr = '', requesting = new Set<string>();
  let quota: { limit: number | null; used: number; remaining: number | null; resetsAt: string } | null = null;
  $: full = quota !== null && quota.limit !== null && (quota.remaining ?? 0) <= 0;
  const day = (iso: string) => fmtDate(iso, { dateStyle: 'medium' });
  const limitMsg = (resetsAt: string) => tr('social.requests.limit', { date: day(resetsAt) });
  /** true while `msg` is the request-limit message (it is already shown by the quota line) */
  let msgIsLimit = false;
  const loadQuota = async () => { try { quota = await api('/api/requests/quota'); } catch { /* optional */ } };
  /** request status label in the UI language ('' for not requested, unknown states as they are) */
  const label = (s: string): string => (s === 'nicht_angefragt' ? '' : hasKey(`social.requests.status.${s}`) ? trDynamic(`social.requests.status.${s}`) : s);
  const kindLabel = (mediaType: string) => (mediaType === 'tv' ? $t('social.kind.series') : $t('social.kind.movie'));
  const cls: Record<string, string> = { verfuegbar: 'ok', in_arbeit: 'warn', angefragt: 'warn', abgelehnt: 'err' };

  let reminders: any[] = [];
  const loadRem = async () => { try { reminders = (await api('/api/reminders')).reminders; } catch { reminders = []; } };
  async function unremind(r: any) {
    try { await removeReminder(r.kind === 'tmdb' ? movieKey(r.mediaType, r.tmdbId) : episodeKey(r.itemId), r.id); reminders = reminders.filter((x) => x.id !== r.id); } catch { msg = tr('social.requests.reminderRemoveFailed'); msgIsLimit = false; }
  }
  async function loadMine() {
    try { mine = (await api('/api/requests/mine')).requests; mineErr = ''; } catch { mineErr = tr('social.requests.mineFailed'); }
  }
  async function search() {
    if (q.trim().length < 2) return;
    busy = true; msg = ''; msgIsLimit = false;
    try { results = (await api(`/api/seerr/search?q=${encodeURIComponent(q.trim())}`)).results; } catch { msg = tr('social.searchUnavailable'); }
    busy = false;
  }
  /** after a movie wish: the collection it belongs to, offered as "Ganze Reihe anfragen…" next to the message */
  let offer: { tmdbId: number; title: string; name: string } | null = null;
  async function request(r: any) {
    const k = `${r.mediaType}:${r.tmdbId}`;
    if (requesting.has(k)) return;
    requesting.add(k); requesting = requesting; msg = ''; msgIsLimit = false; offer = null;
    // a series: the season picker makes the wish (closed without one: nothing changes)
    const res = r.mediaType === 'tv' ? await pickSeasons({ tmdbId: r.tmdbId, title: r.title }) : await submitWish(r.mediaType, r.tmdbId);
    if (res?.kind === 'requested') {
      r.status = 'angefragt'; results = results; msg = tr('social.requests.requested', { title: r.title }); loadMine(); loadQuota();
      if (res.collection) offer = { tmdbId: r.tmdbId, title: r.title, name: res.collection.name };
    } else if (res?.kind === 'limit') { msg = limitMsg(res.resetsAt); msgIsLimit = true; loadQuota(); }
    else if (res?.kind === 'exists') { r.status = 'angefragt'; results = results; msg = tr('social.requests.duplicate'); }
    else if (res) msg = tr('social.requests.failed');
    requesting.delete(k); requesting = requesting;
  }
  async function wholeSeries() {
    if (!offer) return;
    const o = offer;
    const done = await requestCollection({ tmdbId: o.tmdbId, title: o.name });
    if (done?.requested.length) {
      const got = new Set(done.requested);
      for (const x of results) if (x.mediaType === 'movie' && got.has(x.tmdbId)) x.status = 'angefragt';
      results = results; loadMine(); loadQuota();
    }
  }
  // without a request service the page holds only the reminders (no quota, search or wishes; nothing that would answer 404)
  let mounted = false, serviceLoaded = false;
  function loadService() {
    serviceLoaded = true;
    loadMine(); loadQuota(); if (q) search();
  }
  onMount(() => {
    void loadReminders(); loadRem();
    mounted = true;
  });
  // reactive, not read once: a page rendered early from a stale boot hint (no request service) loads its wishes, quota and
  // ?q= search as soon as /api/me reports the service
  $: if (mounted && $features.requests && !serviceLoaded) loadService();
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('social.requests.title') })}</title></svelte:head>
<h1>{$t('social.requests.title')}</h1>
{#if $features.requests}
<form class="flex" on:submit|preventDefault={search}>
  <input placeholder={$t('social.requests.searchPlaceholder')} bind:value={q} style="width:100%;max-width:480px" />
  <button disabled={busy}>{$t('social.search')}</button>
</form>
{#if quota && quota.limit !== null}<p class:warn={full} class:muted={!full}>{#if full}{limitMsg(quota.resetsAt)}{:else}{$t('social.requests.quota', { remaining: quota.remaining, limit: quota.limit })}{/if}</p>{/if}
<div role="status">{#if msg && !(full && msgIsLimit)}<p class="warn">{msg}</p>{/if}</div>
{#if offer}<p class="offer"><span>{$t('home.wish.collection.partOf', { title: offer.title, name: offer.name })}</span> <button type="button" class="sec" on:click={wholeSeries}>{$t('home.wish.collection.open')}</button></p>{/if}
<div class="grid" style="margin-top:1rem">
  {#each results as r}
    <div class="card">
      {#if r.poster}<img loading="lazy" src={r.poster} alt={r.title} />{:else}<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />{/if}
      <div class="t">{r.title}<small>{r.year ?? ''} · {kindLabel(r.mediaType)}</small>
        {#if r.status === 'nicht_angefragt' || r.status === 'abgelehnt'}<button style="margin-top:.4rem;width:100%" disabled={full || requesting.has(`${r.mediaType}:${r.tmdbId}`)} on:click={() => request(r)}>{$t('social.requests.request')}</button>
        {:else}<span class={cls[r.status]}>{label(r.status)}</span>{/if}
        {#if r.status !== 'verfuegbar'}<div style="margin-top:.4rem"><TrailerButton mediaType={r.mediaType} tmdbId={r.tmdbId} title={r.title} /></div>{/if}
      </div>
    </div>
  {/each}
</div>
<h2 style="margin-top:2rem">{$t('social.requests.mine')}</h2>
{#if mineErr}<p class="err" role="alert">{mineErr} <button type="button" class="sec" on:click={loadMine}>{$t('social.tryAgain')}</button></p>{:else if !mine.length}<p class="muted">{$t('social.requests.nothingYet')}</p>{/if}
<table><tbody>{#each mine as m}<tr><td>{m.title}{#if m.seasons?.length}<small class="muted seas">{$t('home.wish.seasons.list', { n: m.seasons.length, list: seasonRanges(m.seasons) })}</small>{/if}</td><td>{kindLabel(m.mediaType)}</td><td class={cls[m.status]}>{label(m.status)}</td><td class="muted">{day(m.createdAt)}</td></tr>{/each}</tbody></table>
{:else}<div role="status">{#if msg}<p class="warn">{msg}</p>{/if}</div>{/if}
<h2 style="margin-top:2rem">{$t('social.requests.reminders')}</h2>
{#if !reminders.length}<p class="muted">{$t('social.requests.noReminders')}</p>{/if}
<table><tbody>{#each reminders as r (r.id)}<tr><td>{r.title}</td><td>{r.kind === 'episode' ? $t('social.kind.episode') : kindLabel(r.mediaType)}</td><td class="muted">{r.releaseDate ? day(r.releaseDate) : $t('social.requests.dateOpen')}</td><td><button class="sec" aria-label={$t('social.requests.removeReminder', { title: r.title })} on:click={() => unremind(r)}>{$t('social.remove')}</button></td></tr>{/each}</tbody></table>

<style>
  .offer { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; margin: .4rem 0 0; }
  .offer button { min-height: 44px; }
  .seas { display: block; }
</style>
