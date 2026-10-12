<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, backdrop, srcset, HERO_WIDTHS, MODAL_WIDTHS, logoUrl, fmtMin, type Item } from '#lib/api';
  import { castToTv, refreshTvOnline, tvOnline } from '#lib/remote';
  import { listIds, toggleList, prefs, SAVE_FAILED } from '#lib/stores';
  import { playPreview, previewFailed, previewOwner, stopPreview, toggleSound } from '#lib/preview';
  import { isSpoiler } from '#lib/spoiler';
  import { langLine } from '#lib/langs';
  import { lengthLabel, ratingBadge } from '#lib/hover';
  import { byType, moodTags, remainingLabel, type Person } from '#lib/detail/format';
  import Icon from '#lib/Icon.svelte';
  import ListMenu from '#lib/ListMenu.svelte';
  import DownloadButton from '#lib/DownloadButton.svelte';
  import StatusPicker from '#lib/StatusPicker.svelte';
  import FriendsStrip from '#lib/FriendsStrip.svelte';
  import CastRow from '#lib/CastRow.svelte';
  import Reactions from '#lib/Reactions.svelte';
  import LangPick from '#lib/LangPick.svelte';
  import EpisodeList from '#lib/detail/EpisodeList.svelte';
  import MoreLikeThis from '#lib/detail/MoreLikeThis.svelte';
  import InfoBlock from '#lib/detail/InfoBlock.svelte';

  /** Unified detail view: used inside the popup (ItemModal) and as the full page (/item/[id]). */
  export let id: string;
  export let variant: 'modal' | 'page' = 'page';
  /** loaded title (read-only for the parent: bind:item) */
  export let item: Item | null = null;
  /** id of the heading (the dialog is labelled by it) */
  export let titleId = 'detail-title';
  export let failed = false;
  const dispatch = createEventDispatcher<{ loaded: Item }>();

  let thumb = 0, extras: Item[] = [], more: Item[] | null = null, people: Person[] = [];
  let friends: Array<{ id: string; name: string }> = [], recOpen = false, recTo = new Set<string>(), recNote = '', recMsg = '';
  let seasons: Item[] = [], episodes: Item[] | null = null, season = '', next: Item | null = null;
  let ratings: any[] = [], avg: number | null = null, stars = 0, review = '', followed = false;
  let logoFailed = false, saveMsg = '', saveT: ReturnType<typeof setTimeout>, castMsg = '', castT: ReturnType<typeof setTimeout>;
  let lgA = '', lgS = '';

  let loadSeq = 0, epSeq = 0;
  async function load(want: string) {
    const my = ++loadSeq;
    stopHero();
    item = null; failed = false; episodes = null; thumb = 0; next = null; seasons = []; ratings = []; avg = null; stars = 0; review = ''; followed = false; season = '';
    extras = []; more = null; people = []; logoFailed = false; heroLoaded = false; heroTried = ''; recOpen = false; castMsg = ''; saveMsg = '';
    let it: Item, th = 0;
    try { const r = await api(`/api/items/${want}`); it = r.item; th = r.thumb === 1 || r.thumb === -1 ? r.thumb : 0; } catch { if (my === loadSeq) failed = true; return; }
    if (my !== loadSeq) return;
    item = it; thumb = th;
    dispatch('loaded', it);
    // every secondary request fails on its own: the view works without ratings, follow state, seasons, people or next-up
    void (async () => {
      try { const p = (await api(`/api/items/${want}/people`)).people as Person[]; if (my === loadSeq) people = p ?? []; } catch { /* optional */ }
    })();
    void (async () => {
      try { const x = (await api(`/api/items/${want}/extras`)).items as Item[]; if (my === loadSeq) extras = x ?? []; } catch { /* optional */ }
    })();
    void loadSimilar(it).then((l) => { if (my === loadSeq) more = l.slice(0, 12); });
    try {
      const rr = await api(`/api/items/${want}/ratings`);
      if (my !== loadSeq) return;
      ratings = rr.ratings; avg = rr.average;
      const mine = ratings.find((x) => x.mine); stars = mine?.stars ?? 0; review = mine?.review ?? '';
    } catch { /* optional */ }
    if (my !== loadSeq || it.type !== 'Series') return;
    try { const f = (await api(`/api/series/${want}/follow`)).followed; if (my === loadSeq) followed = f; } catch { /* optional */ }
    let list: Item[] = [];
    try { list = (await api(`/api/items/${want}/seasons`)).items; } catch { /* optional */ }
    if (my !== loadSeq) return;
    seasons = list;
    let first = list[0]?.id ?? '';
    try {
      const n = ((await api('/api/library/nextup')).items as Item[]).find((e) => e.seriesId === want) ?? null;
      if (my !== loadSeq) return;
      next = n;
      if (n?.seasonId && list.some((x) => x.id === n.seasonId)) first = n.seasonId;
    } catch { /* optional */ }
    if (my !== loadSeq) return;
    season = first;
  }
  $: if (id) void load(id);
  $: if (item?.type === 'Series' && season) loadEpisodes(item.id, season);
  function loadEpisodes(seriesId: string, seasonId: string) {
    const my = ++epSeq;
    episodes = null;
    api(`/api/items/${seriesId}/episodes?seasonId=${seasonId}`).then((r) => { if (my === epSeq) episodes = r.items; }).catch(() => { if (my === epSeq) episodes = []; });
  }
  async function loadSimilar(it: Item): Promise<Item[]> {
    const genre = async () => it.genres.length
      ? (await api(`/api/library/items?types=${it.type}&genre=${encodeURIComponent(it.genres[0]!)}&sort=Random&limit=24`)).items.filter((i: Item) => i.id !== it.id) as Item[]
      : [];
    try { const l = (await api(`/api/items/${it.id}/similar`)).items as Item[]; return l.length ? l : await genre(); } catch { try { return await genre(); } catch { return []; } }
  }

  // ---- derived ----
  $: inList = item ? $listIds.has(item.id) : false;
  $: qs = [lgA && `audio=${encodeURIComponent(lgA)}`, lgS && `sub=${encodeURIComponent(lgS)}`].filter(Boolean).join('&');
  $: playBase = item ? (item.type === 'Series' ? (next ? `/watch/${next.id}` : episodes?.[0] ? `/watch/${episodes[0].id}` : '') : `/watch/${item.id}`) : '';
  $: playHref = playBase ? (qs ? `${playBase}?${qs}` : playBase) : item ? `/item/${item.id}` : '';
  $: playTarget = playBase.split('/').pop() ?? '';
  $: resumeFrom = item ? (item.type === 'Series' ? next : item) : null;
  $: remaining = resumeFrom ? remainingLabel(resumeFrom.positionTicks, resumeFrom.runtimeTicks) : '';
  $: playLabel = item ? (item.type === 'Series' ? (next ? (next.positionTicks ? 'Fortsetzen' : 'Weiter') : 'Abspielen') : item.positionTicks ? 'Fortsetzen' : 'Abspielen') : 'Abspielen';
  $: resumeLine = item?.type === 'Series' && next ? [`S${next.parentIndexNumber ?? '?'}:E${next.indexNumber ?? '?'}`, remaining].filter(Boolean).join(' · ') : remaining;
  $: actors = byType(people, 'Actor', 'GuestStar');
  $: castList = actors.length ? actors : people.filter((p) => p.type !== 'Director' && p.type !== 'Writer');
  $: moods = item ? moodTags(item.genres) : [];
  $: len = item ? lengthLabel(item) : '';
  $: badge = item ? ratingBadge(item, Date.now()) : '';
  $: overview = item ? (isSpoiler(item, $prefs) ? 'Beschreibung ausgeblendet (Spoilerschutz).' : (item.overview ?? '')) : '';
  $: langs = item ? langLine(item.langs) : '';
  $: heroOwner = item ? 'detail:' + item.id : '';

  function failSave() { saveMsg = SAVE_FAILED; clearTimeout(saveT); saveT = setTimeout(() => (saveMsg = ''), 5000); }
  async function toggleMine() { if (item && !(await toggleList(item.id, inList))) failSave(); }
  async function toggleFav() { if (!item) return; const on = item.favorite; try { await api(`/api/items/${item.id}/favorite`, { method: on ? 'DELETE' : 'POST' }); item.favorite = !on; } catch { failSave(); } }
  async function togglePlayed() { if (!item) return; const on = item.played; try { await api(`/api/items/${item.id}/played`, { method: on ? 'DELETE' : 'POST' }); item.played = !on; } catch { failSave(); } }
  let thumbBusy = false;
  async function setThumb(v: 1 | -1) {
    if (!item || thumbBusy) return;
    const prev = thumb, nv = thumb === v ? 0 : v, itemId = item.id;
    thumb = nv; thumbBusy = true;
    try { await api(`/api/items/${itemId}/thumb`, { method: 'PUT', body: { value: nv } }); }
    catch { if (item?.id === itemId) thumb = prev; failSave(); }
    thumbBusy = false;
  }
  async function toggleFollow() { try { await api(`/api/series/${item!.id}/follow`, { method: followed ? 'DELETE' : 'POST' }); followed = !followed; } catch { failSave(); } }
  async function startParty() { try { void goto(`/party/${(await api('/api/party', { method: 'POST', body: { itemId: item!.id } })).id}`); } catch { castMsg = 'Party konnte nicht erstellt werden.'; } }
  async function castHere() {
    const t = playTarget;
    if (!t) return;
    castMsg = (await castToTv(t)) ? 'Wird auf dem Fernseher gestartet …' : 'Der Fernseher ist nicht erreichbar.';
    clearTimeout(castT); castT = setTimeout(() => (castMsg = ''), 3500);
  }
  async function openRec() { recOpen = true; recMsg = ''; if (!friends.length) friends = (await api('/api/friends').catch(() => ({ friends: [] }))).friends; }
  async function sendRec() {
    try { const r = await api('/api/recommend', { method: 'POST', body: { itemId: item!.id, toUserIds: [...recTo], note: recNote || undefined } }); recMsg = `An ${r.sent} Freund(e) gesendet.`; recTo = new Set(); recNote = ''; setTimeout(() => (recOpen = false), 1200); }
    catch (e: any) { recMsg = e?.body?.error === 'already_recommended' ? 'Diesen Titel hast du ihnen diese Woche schon empfohlen.' : 'Senden fehlgeschlagen.'; }
  }
  function toggleTo(uid: string) { const n = new Set(recTo); if (n.has(uid)) n.delete(uid); else n.add(uid); recTo = n; }
  async function rate() {
    if (!item || !stars) return;
    try {
      await api(`/api/items/${item.id}/rating`, { method: 'PUT', body: { stars, review: review || undefined } });
      const rr = await api(`/api/items/${item.id}/ratings`); ratings = rr.ratings; avg = rr.average;
    } catch { failSave(); }
  }
  function toInfo() {
    const t = document.getElementById('dv-info');
    t?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    t?.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
  }

  // ---- hero trailer: the still image fades into a muted preview clip (like the billboard) ----
  let hv: HTMLVideoElement, heroPlaying = false, hmuted = true, heroT: ReturnType<typeof setTimeout>, heroLoaded = false, heroTried = '';
  $: if (item && (heroLoaded || !item.backdrop) && item.id !== heroTried) scheduleHero(item.id);
  $: if (heroPlaying && $previewOwner !== heroOwner) heroPlaying = false;
  $: canPreview = Boolean(item && !previewFailed(item.id) && (item.trailers || (item.type === 'Movie' || item.type === 'Series')));
  function eligible() {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    return $prefs.hoverTrailers && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.documentElement.classList.contains('tv') && !nav.connection?.saveData && !(item?.trailers === 0 && !$prefs.hoverClip);
  }
  function scheduleHero(itemId: string) {
    heroTried = itemId;
    clearTimeout(heroT);
    heroT = setTimeout(() => { if (item?.id === itemId && eligible() && !$previewOwner) void startHero(); }, 1500);
  }
  async function startHero(forced = false) {
    if (!item || (!forced && !eligible())) return;
    heroPlaying = true;
    if (!(await playPreview(item.id, () => hv, heroOwner))) heroPlaying = false;
  }
  function stopHero() { clearTimeout(heroT); if (heroOwner && $previewOwner === heroOwner) stopPreview(heroOwner); heroPlaying = false; }
  function onScroll() { if (variant === 'page' && heroPlaying && scrollY > innerHeight * 0.6) stopHero(); }
  const onVisibility = () => { if (document.hidden) stopHero(); };
  onMount(() => {
    void refreshTvOnline();
    addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
  });
  onDestroy(() => {
    if (typeof window === 'undefined') return;
    removeEventListener('scroll', onScroll); document.removeEventListener('visibilitychange', onVisibility);
    clearTimeout(saveT); clearTimeout(castT); stopHero();
  });
  const heroTitleTag = () => (variant === 'modal' ? 'h2' : 'h1');
</script>

<div class="dv" class:vm={variant === 'modal'} class:vp={variant === 'page'}>
  <!-- ================= hero ================= -->
  <div class="hero">
    {#if item}
      {#if item.backdrop}<img class="bg" class:loaded={heroLoaded} src={backdrop(item.id, variant === 'modal' ? 960 : 1280)} srcset={srcset('Backdrop', item.id, variant === 'modal' ? MODAL_WIDTHS : HERO_WIDTHS)} sizes={variant === 'modal' ? '(min-width: 890px) 850px, 100vw' : '100vw'} alt="" fetchpriority="high" on:load={() => (heroLoaded = true)} />{/if}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={hv} class="hv" class:on={heroPlaying} loop playsinline aria-hidden="true" tabindex="-1" on:volumechange={() => (hmuted = hv.muted)} on:playing={() => (hmuted = hv.muted)}></video>
      <div class="fade"></div>
      <div class="cap">
        <svelte:element this={heroTitleTag()} id={titleId} class:sr-only={item.logo && !logoFailed} class="ttl">{item.name}</svelte:element>
        {#if item.logo && !logoFailed}<img class="tlogo" src={logoUrl(item.id)} alt="" on:error={() => (logoFailed = true)} />{/if}
        <div class="btns">
          <a class="btn light play" data-autofocus href={playHref}><Icon name="play" size={24} />{playLabel}</a>
          <button type="button" class="rb" class:on={inList} aria-pressed={inList} aria-label={inList ? 'Von Meine Liste entfernen' : 'Zu Meine Liste hinzufügen'} title="Meine Liste" on:click={toggleMine}><Icon name={inList ? 'check' : 'plus'} size={22} /></button>
          <button type="button" class="rb" class:on={thumb === 1} aria-pressed={thumb === 1} aria-label="Gefällt mir" title="Gefällt mir" on:click={() => setThumb(1)}><Icon name="thumb-up" size={20} /></button>
          <button type="button" class="rb" class:on={thumb === -1} aria-pressed={thumb === -1} aria-label="Gefällt mir nicht" title="Nicht für mich" on:click={() => setThumb(-1)}><Icon name="thumb-down" size={20} /></button>
          <ListMenu itemId={item.id} variant="round" size={44} up={variant === 'modal'} />
          {#if item.type !== 'Series'}<DownloadButton itemId={item.id} compact />{/if}
          {#if canPreview && !heroPlaying}<button type="button" class="rb wide" title="Trailer abspielen" aria-label="Trailer abspielen" on:click={() => startHero(true)}><Icon name="film" size={18} /><span>Trailer</span></button>{/if}
        </div>
        {#if resumeLine}<p class="resume">{resumeLine}</p>{/if}
      </div>
      {#if heroPlaying}<button type="button" class="snd" aria-label={hmuted ? 'Ton einschalten' : 'Ton ausschalten'} aria-pressed={!hmuted} on:click={() => toggleSound(hv)}><Icon name={hmuted ? 'volume-off' : 'volume'} size={20} /></button>{/if}
    {:else if failed}
      <p class="err pad" role="alert">{variant === 'modal' ? 'Titel konnte nicht geladen werden.' : 'Titel nicht gefunden.'}</p>
      {#if variant === 'page'}<p class="pad"><a class="btn" href="/">Zur Startseite</a></p>{/if}
    {:else}
      <div class="skeleton fillsk" aria-hidden="true"></div>
    {/if}
  </div>

  {#if item}
    <div class="body">
      <!-- ================= info columns ================= -->
      <div class="cols">
        <div class="left">
          <p class="meta">
            {#if badge}<span class:match={badge.startsWith("★")} class:fresh={badge === "Neu"}>{badge}</span>{/if}
            {#if item.year}<span>{item.year}</span>{/if}
            {#if item.rating}<span class="age" title="Altersfreigabe">{item.rating}</span>{/if}
            {#if len}<span>{len}</span>{/if}
          </p>
          {#if langs}<p class="muted small">{langs}</p>{/if}
          <StatusPicker id={item.id} />
          <p class="ov">{overview || 'Keine Beschreibung vorhanden.'}</p>
          <FriendsStrip id={item.id} />
          {#if playTarget}<LangPick targetId={playTarget} storeKey={item.id} bind:audio={lgA} bind:sub={lgS} />{/if}
          <div class="tools">
            <button type="button" class="sec" class:on={item.favorite} aria-pressed={item.favorite} on:click={toggleFav}><Icon name="heart" size={19} fill={item.favorite} />Favorit</button>
            <button type="button" class="sec" class:on={item.played} aria-pressed={item.played} on:click={togglePlayed}><Icon name="check" size={19} />Gesehen</button>
            <button type="button" class="sec" aria-expanded={recOpen} on:click={openRec}><Icon name="send" size={19} />Empfehlen</button>
            {#if $tvOnline && playHref}<button type="button" class="sec" on:click={castHere}><Icon name="tv" size={19} />Auf Fernseher</button>{/if}
            {#if item.type !== 'Series'}<button type="button" class="sec" on:click={startParty}><Icon name="users" size={19} />Gemeinsam schauen</button>{/if}
            {#if item.type === 'Series'}<button type="button" class="sec" aria-pressed={followed} on:click={toggleFollow}><Icon name="bell" size={19} />{followed ? 'Du folgst dieser Serie' : 'Neue Folgen melden'}</button>{/if}
          </div>
          {#if castMsg}<p class="muted" role="status">{castMsg}</p>{/if}
          <div role="status">{#if saveMsg}<p class="err">{saveMsg}</p>{/if}</div>
          {#if recOpen}
            <div class="panel rec" role="group" aria-label="Empfehlen">
              <b>„{item.name}“ empfehlen an:</b>
              <div class="flex">{#each friends as f (f.id)}<label class="chk"><input type="checkbox" checked={recTo.has(f.id)} on:change={() => toggleTo(f.id)} />{f.name}</label>{:else}<span class="muted">Noch keine anderen Nutzer.</span>{/each}</div>
              <div class="flex"><input bind:value={recNote} maxlength="140" placeholder="Nachricht (optional)" aria-label="Nachricht" style="flex:1;min-width:200px" /><button type="button" disabled={!recTo.size} on:click={sendRec}>Senden</button><button type="button" class="sec" on:click={() => (recOpen = false)}>Abbrechen</button></div>
              {#if recMsg}<span class="muted" role="status">{recMsg}</span>{/if}
            </div>
          {/if}
        </div>
        <dl class="right">
          {#if castList.length}
            <div><dt>Besetzung:</dt><dd>{#each castList.slice(0, 3) as p, n (p.id + n)}{#if n}{', '}{/if}<a href="/person/{p.id}">{p.name}</a>{/each}{#if castList.length > 3}{', '}<button type="button" class="lnk" on:click={toInfo}>mehr</button>{/if}</dd></div>
          {/if}
          {#if item.genres.length}<div><dt>Genres:</dt><dd>{item.genres.join(', ')}</dd></div>{/if}
          {#if moods.length}<div><dt>Dieser Titel ist:</dt><dd>{moods.join(', ')}</dd></div>{/if}
        </dl>
      </div>

      {#if item.type === 'Series'}
        <EpisodeList seriesId={item.id} {seasons} bind:season {episodes} {next} {qs} />
      {/if}

      {#if extras.length}
        <section class="extras" aria-labelledby="ex-h"><h2 id="ex-h">Bonusmaterial</h2>
          <ul>{#each extras as x (x.id)}<li><a href="/watch/{x.id}"><span class="pl2"><Icon name="play" size={18} /></span><span>{x.name}</span><span class="muted">{fmtMin(x.runtimeTicks)}</span></a></li>{/each}</ul>
        </section>
      {/if}

      <MoreLikeThis items={more} {variant} />

      {#if item.type === 'Movie' || item.type === 'Episode'}<Reactions id={item.id} />{/if}

      <section class="rate panel" aria-labelledby="rt-h">
        <h2 id="rt-h">Bewertungen {#if avg}<span class="badge">Ø {avg.toFixed(1)} von 5</span>{/if}</h2>
        <div class="flex" role="group" aria-label="Sterne vergeben">
          {#each [1, 2, 3, 4, 5] as n}<button type="button" class="icon-btn star" class:on={stars >= n} aria-pressed={stars >= n} aria-label="{n} {n === 1 ? 'Stern' : 'Sterne'}" on:click={() => (stars = n)}><Icon name="star" size={24} fill={stars >= n} /></button>{/each}
          <input placeholder="Kurzreview (max. 280 Zeichen)" maxlength="280" bind:value={review} aria-label="Kurzreview" style="flex:1;min-width:200px" />
          <button type="button" disabled={!stars} on:click={rate}>Speichern</button>
        </div>
        {#each ratings as r}<p><b>{r.name}</b> <span class="warn">{'★'.repeat(r.stars)}</span> <span class="muted">{r.review ?? ''}</span></p>{/each}
      </section>

      <CastRow id={item.id} />
      <InfoBlock {item} {people} />
    </div>
  {:else if !failed}
    <div class="body" aria-hidden="true">
      <div class="cols">
        <div class="left"><div class="skeleton sl" style="width:55%"></div><div class="skeleton sl" style="width:100%;height:4.5rem"></div><div class="skeleton sl" style="width:80%"></div></div>
        <div class="right"><div class="skeleton sl" style="width:90%"></div><div class="skeleton sl" style="width:70%"></div></div>
      </div>
      <div class="skeleton sl" style="height:90px;margin-top:2rem"></div>
      <div class="skeleton sl" style="height:90px"></div>
    </div>
  {/if}
</div>

<style>
  .dv { --dv-bg: var(--bg); position: relative; color: var(--fg); }
  .dv.vm { --dv-bg: var(--surface); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }

  /* ---- hero ---- */
  .hero { position: relative; overflow: hidden; background: #0e0e0e; }
  .vm .hero { aspect-ratio: 16 / 9; }
  .vp .hero { height: clamp(440px, 56.25vw, 86vh); }
  .bg, .hv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; }
  .bg { opacity: 0; transition: opacity .6s var(--ease); }
  .bg.loaded { opacity: 1; }
  .hv { opacity: 0; transition: opacity 1s var(--ease); pointer-events: none; background: transparent; }
  .hv.on { opacity: 1; }
  .fade { position: absolute; inset: 0; background: linear-gradient(to top, var(--dv-bg) 1%, rgba(0, 0, 0, .0) 55%), linear-gradient(77deg, rgba(0, 0, 0, .55), transparent 55%), linear-gradient(to bottom, rgba(0, 0, 0, .5), transparent 22%); pointer-events: none; }
  .fillsk { position: absolute; inset: 0; border-radius: 0; }
  .cap { position: absolute; left: 2.2rem; right: 2rem; bottom: 1.6rem; z-index: 2; display: flex; flex-direction: column; gap: 1rem; align-items: flex-start; }
  .vp .cap { left: var(--pad-x); right: var(--pad-x); bottom: 2.2rem; }
  .ttl { margin: 0; font-size: clamp(1.8rem, 4.4vw, 3.4rem); font-weight: 800; letter-spacing: -.02em; line-height: 1.05; text-shadow: 0 2px 14px rgba(0, 0, 0, .7); }
  .tlogo { max-width: min(70%, 24rem); max-height: 8rem; object-fit: contain; object-position: left bottom; filter: drop-shadow(0 4px 14px rgba(0, 0, 0, .7)); }
  .vp .tlogo { max-width: min(80%, 30rem); max-height: 10rem; }
  .btns { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .btns :global(.btn.play) { font-size: 1.15rem; padding: .5rem 1.8rem .5rem 1.4rem; min-height: 48px; }
  .rb { width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; background: rgba(42, 42, 42, .7); border: 2px solid rgba(255, 255, 255, .55); color: #fff; }
  .rb:hover:not(:disabled) { border-color: #fff; background: rgba(42, 42, 42, .95); }
  .rb.on { color: var(--acc); border-color: var(--acc); }
  .rb.wide { width: auto; border-radius: 99px; padding: 0 1rem; font-size: .9rem; }
  .resume { margin: -.3rem 0 0; font-size: .95rem; font-weight: 600; color: #e8e8e8; text-shadow: 0 1px 8px #000; }
  .snd { position: absolute; right: 2rem; bottom: 1.6rem; z-index: 3; width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; background: rgba(42, 42, 42, .7); border: 2px solid rgba(255, 255, 255, .55); color: #fff; }
  .vp .snd { right: var(--pad-x); bottom: 2.2rem; }
  .snd:hover:not(:disabled) { border-color: #fff; background: rgba(42, 42, 42, .95); }
  .pad { padding: 5rem 2rem 1rem; margin: 0; }

  /* ---- body ---- */
  .body { position: relative; z-index: 3; padding: 0 2.2rem 2.4rem; background: var(--dv-bg); }
  .vp .body { padding: 0 var(--pad-x) 5rem; max-width: 1400px; }
  .cols { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 2rem; padding-top: .6rem; }
  .left { min-width: 0; }
  .meta { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; color: #d2d2d2; margin: .4rem 0 .6rem; font-size: 1.05rem; }
  .match { color: var(--ok); font-weight: 700; }
  .fresh { color: var(--ok); font-weight: 700; }
  .age { border: 1px solid rgba(255, 255, 255, .45); padding: 0 .4rem; font-size: .85rem; line-height: 1.5; }
  .small { font-size: .85rem; margin: -.2rem 0 .6rem; }
  .ov { margin: .8rem 0; line-height: 1.55; overflow-wrap: anywhere; }
  .tools { display: flex; gap: .5rem; flex-wrap: wrap; margin: 1rem 0 .4rem; }
  .tools .sec { font-size: .88rem; padding: .4rem .9rem; }
  .tools .sec.on :global(svg) { color: var(--acc); }
  .tools .sec[aria-pressed='true']:not(.on) { outline: 1px solid rgba(255, 255, 255, .35); }
  .rec { display: grid; gap: .8rem; margin-top: .8rem; }
  .chk { display: inline-flex; gap: .45rem; align-items: center; color: var(--fg); min-height: 44px; }
  .right { margin: 0; display: grid; gap: .7rem; align-content: start; font-size: .9rem; padding-top: .5rem; }
  .right dt { color: var(--mut); display: inline; margin-right: .35rem; }
  .right dd { margin: 0; display: inline; }
  .right dd a:hover, .right dd a:focus-visible { text-decoration: underline; }
  .lnk { background: none; border: 0; padding: 0 .1rem; min-height: 0; color: var(--fg); font: inherit; font-weight: 400; text-decoration: underline; cursor: pointer; display: inline; }
  .lnk:hover:not(:disabled) { background: none; }
  .sl { height: 1.1rem; margin: .8rem 0; }

  .extras { margin-top: 2rem; }
  .extras h2, .rate h2 { font-size: 1.4rem; }
  .extras ul { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: .3rem; max-width: 640px; }
  .extras a { display: flex; gap: .8rem; align-items: center; padding: .6rem .8rem; background: var(--surface-2); border-radius: 6px; }
  .extras a:hover { background: #333; }
  .extras .muted { margin-left: auto; }
  .pl2 { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: #3a3a3a; }
  .rate { margin-top: 2rem; }
  .star.on { color: #f5c518; }
  .dv :global(.reactions), .dv :global(.cast) { margin-top: 2rem; }

  @media (pointer: coarse) { .right dd a, .lnk { display: inline-flex; align-items: center; min-height: 44px; } }
  @media (max-width: 899px) {
    .cols { grid-template-columns: minmax(0, 1fr); gap: .6rem; }
    .right { padding-top: 0; }
  }
  @media (max-width: 640px) {
    .cap { left: 1.2rem; right: 1.2rem; bottom: 1rem; gap: .7rem; }
    .body { padding: 0 1.2rem 5rem; }
    .snd { right: 1.2rem; bottom: 1rem; }
    .vp .hero { height: clamp(380px, 70vh, 600px); }
    .btns :global(.btn.play) { font-size: 1.05rem; padding: .4rem 1.3rem .4rem 1.1rem; }
  }
</style>
