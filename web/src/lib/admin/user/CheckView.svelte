<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * User detail, Sicht prüfen tab (spec §6.4): what one profile can see, read-only. Profile chips on top (the owner first, kids profiles marked),
   * then *Kurzfassung* (sentences from the profile's effective rights, `GET …/rights?profile=`), *Bibliotheken* (shared or not, how many titles
   * the profile sees of the library, `GET …/check?profile=`) and *Titel prüfen* (a search, debounced 300 ms, at least 2 characters, `POST …/check`:
   * each hit is visible or hidden with the reason). It only reads: no right, profile or setting changes. It never signs in to
   * FriendFlix as the person; the backend may sign in to the media server as the profile's media-server user for the probe (which updates that
   * user's last-login time there; docs/security.md, "The check view"). The backend audits every view (`user.check_viewed`).
   * *Live-TV* (only when the server answers it: Live TV installed and the profile may use it): every channel group with ✓ or – and why a
   * hidden one is hidden (not kid-friendly, not released for the role, blocked for this person, not released yet), and how many channels the
   * profile sees. The answer is null otherwise and the section is not there.
   */
  import { onDestroy } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { fmtNumber, locale, t, tr, trDynamic } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Icon from '#lib/Icon.svelte';
  import { uid } from '#lib/ui/ids';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { CHECK_HITS, summarySentences } from './checkText';
  import type { DetailProfile } from './detail';
  import type { RightsView } from './rights';
  import type { LivetvCheck } from '#lib/admin/livetv/groups';

  export let userId: string;
  /** the person's profiles (the detail answer) */
  export let profiles: DetailProfile[];
  /** the person's role as shown ("für Gast nicht freigegeben"); the role key when empty */
  export let role = '';

  interface LibraryCount { id: string; name: string; visible: boolean; seen: number | null; total: number }
  type Why = 'library' | 'rating' | 'unrated' | 'unrated_kids' | null;
  interface Hit { id: string; name: string; year?: number; type: 'Movie' | 'Series'; visible: boolean; why: Why; rating: string | null; library: string }

  const id = uid('ck');
  const MIN = 2, DEBOUNCE = 300;
  /** the owner first, the others in the given order */
  $: chips = [...profiles].sort((a, b) => Number(b.isOwner) - Number(a.isOwner));
  let pid = '';
  $: if (!chips.some((p) => p.id === pid)) { pid = chips[0]?.id ?? ''; }

  let view: RightsView | null = null, libs: LibraryCount[] | null = null, livetv: LivetvCheck | null = null, error: string | null = null;
  let seq = 0;
  async function load(profile: string) {
    const my = ++seq;
    view = null; libs = null; livetv = null; error = null; hits = null; searchError = null;
    try {
      const [v, c] = await Promise.all([
        api<RightsView>(`/api/admin/users/${userId}/rights?profile=${profile}`),
        api<{ libraries: LibraryCount[]; livetv?: LivetvCheck | null }>(`/api/admin/users/${userId}/check?profile=${profile}`),
      ]);
      if (my !== seq) return;
      view = v; libs = c.libraries; livetv = c.livetv ?? null;
      void search();
    } catch (e) {
      // the library counts share the check's 30-a-minute limit: that says so, not "could not load"
      if (my === seq) error = tr(e instanceof ApiError && e.status === 429 ? 'adminPeople.check.tooMany' : 'adminPeople.loadFailed');
    }
  }
  // a profile (re)selected: its view is read again, the open search is asked again for it
  $: if (pid) void load(pid);

  $: profile = chips.find((p) => p.id === pid);
  /** the profile's effective age limit (the kids overlay included); null: none */
  $: capValue = ((v: unknown): number | null => (typeof v === 'number' ? v : null))(view?.rows.find((r) => r.key === 'maxParentalRating')?.value);
  // a kids profile's sentence says its effective limit as the row has it, and says so when there is none (never a guessed one)
  $: kids = view?.profile?.kids ? { maxRating: capValue } : null;
  $: sentences = view && libs && profile && $locale ? summarySentences(profile.name, view.rows, { visible: libs.filter((l) => l.visible).length, total: libs.length }, kids) : [];
  const num = (n: number) => fmtNumber(n);
  $: cap = capValue === null ? '–' : tr('adminPeople.check.capName', { n: capValue });
  const reason = (h: Hit): string => {
    switch (h.why) {
      case 'rating': return tr('adminPeople.check.hiddenRating', { r: h.rating ?? '–', cap });
      case 'library': return tr('adminPeople.check.hiddenLibrary');
      case 'unrated_kids': return tr('adminPeople.check.hiddenUnrated');
      case 'unrated': return tr('adminPeople.check.hiddenUnratedAdult');
      default: return tr('adminPeople.check.hidden');
    }
  };

  const livetvReason = (r: NonNullable<LivetvCheck['groups'][number]['reason']>): string => {
    switch (r) {
      case 'notReleased': return tr('adminPeople.check.livetvNotReleased');
      case 'notKidFriendly': return tr('adminPeople.check.livetvNotKids');
      case 'denied': return tr('adminPeople.check.livetvDenied');
      default: return tr('adminPeople.check.livetvNotRole', { role: role || view?.role || '' });
    }
  };

  // ---- Titel prüfen ----
  let q = '', hits: Hit[] | null = null, searching = false, searchError: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, sseq = 0;
  $: term = q.trim();
  $: short = term.length > 0 && term.length < MIN;
  // typing: wait for 300 ms of quiet; fewer than 2 characters sends nothing and clears the list
  $: onTerm(term);
  function onTerm(v: string) {
    clearTimeout(timer);
    if (v.length < MIN) { sseq++; hits = null; searching = false; searchError = null; return; }
    timer = setTimeout(() => void search(), DEBOUNCE);
  }
  async function search() {
    const v = term;
    // the profile's view is still loading: its load asks again
    if (v.length < MIN || !view) return;
    const my = ++sseq, asked = pid;
    searching = true; searchError = null;
    try {
      const r = await api<{ hits: Hit[] }>(`/api/admin/users/${userId}/check`, { method: 'POST', body: { profileId: asked, query: v } });
      if (my === sseq) hits = r.hits;
    } catch (e) {
      // the check is limited to 30 a minute: that says so, not "try again"
      if (my === sseq) { hits = null; searchError = tr(e instanceof ApiError && e.status === 429 ? 'adminPeople.check.tooMany' : 'adminPeople.check.searchFailed'); }
    } finally {
      if (my === sseq) searching = false;
    }
  }
  onDestroy(() => { clearTimeout(timer); sseq++; seq++; });
</script>

<div class="check">
  <div class="chips" role="group" aria-label={$t('adminPeople.check.pick')}>
    {#each chips as p (p.id)}
      <button type="button" class="chip" class:on={p.id === pid} aria-pressed={p.id === pid} on:click={() => (pid = p.id)}>
        <span class="cn">{p.name}</span>{#if p.kids}<span class="mark">{$t('adminPeople.check.kids')}</span>{/if}
      </button>
    {/each}
  </div>

  {#if error}
    <div class="state" role="alert"><p>{error}</p><Button variant="secondary" icon="refresh" on:click={() => void load(pid)}>{$t('ui.retry')}</Button></div>
  {:else if !view || !libs}
    <div class="skel" aria-busy="true"><Skeleton w="40%" h="1.2rem" /><Skeleton w="100%" h="3rem" /><Skeleton w="100%" h="3rem" /></div>
  {:else}
    <section class="card sec" aria-labelledby="{id}-sum">
      <h3 id="{id}-sum">{$t('adminPeople.check.summary')}</h3>
      <ul class="sent">{#each sentences as s (s)}<li>{s}</li>{/each}</ul>
    </section>

    <section class="card sec" aria-labelledby="{id}-lib">
      <h3 id="{id}-lib">{$t('adminPeople.check.libraries')}</h3>
      {#if libs.length}
        <ul class="libs">
          {#each libs as l (l.id)}
            <li class:off={!l.visible}>
              <span class="mk" aria-hidden="true">{l.visible ? '✓' : '–'}</span>
              <span class="lt">{#if l.visible && l.seen !== null}{$t('adminPeople.check.libCount', { lib: l.name, n: num(l.seen), m: num(l.total) })}{:else}{$t('adminPeople.check.libHidden', { lib: l.name })}{/if}</span>
              {#if l.visible}<span class="sr-only">{$t('adminPeople.check.libShared')}</span>{/if}
            </li>
          {/each}
        </ul>
      {:else}<p class="mut">{$t('adminPeople.check.noLibs')}</p>{/if}
    </section>

    {#if livetv}
      <section class="card sec" aria-labelledby="{id}-ltv">
        <h3 id="{id}-ltv">{$t('adminPeople.check.livetv')}</h3>
        <p class="mut">{$t('adminPeople.check.livetvChannels', { n: num(livetv.channels) })}</p>
        {#if livetv.groups.length}
          <ul class="libs">
            {#each livetv.groups as gr (gr.id)}
              <li class:off={!gr.visible}>
                <span class="mk" aria-hidden="true">{gr.visible ? '✓' : '–'}</span>
                <span class="lt">{gr.name}{#if gr.reason}{' · '}{$locale && livetvReason(gr.reason)}{/if}</span>
                {#if gr.visible}<span class="sr-only">{$t('adminPeople.check.livetvVisible')}</span>{/if}
              </li>
            {/each}
          </ul>
        {:else}<p class="mut">{$t('adminPeople.check.livetvNoGroups')}</p>{/if}
      </section>
    {/if}

    <section class="card sec" aria-labelledby="{id}-tit">
      <h3 id="{id}-tit">{$t('adminPeople.check.titles')}</h3>
      <Field label={$t('adminPeople.check.titlesHint')} type="search" bind:value={q} maxlength={100} autocomplete="off" />
      <p class="mut small" role="status">
        {#if short}{$t('adminPeople.check.minChars')}{:else if searching}{$t('adminPeople.check.searching')}{:else if searchError}<span class="bad">{searchError}</span>{:else if hits && !hits.length}{$t('adminPeople.check.noHits')}{/if}
      </p>
      {#if hits?.length}
        <ul class="hits">
          {#each hits as h (h.id)}
            <li class="hit">
              <div class="ht">
                <span class="hn">{h.name}</span>
                <span class="hm">{[h.year, $locale && trDynamic(`adminPeople.check.type.${h.type}`), h.rating, h.library].filter(Boolean).join(' · ')}</span>
              </div>
              {#if h.visible}
                <span class="why ok"><Icon name="check" size={14} /><span>{$t('adminPeople.check.visible')}</span></span>
              {:else}
                <span class="why warn"><Icon name="alert" size={14} /><span>{$locale && reason(h)}</span></span>
              {/if}
            </li>
          {/each}
        </ul>
        {#if hits.length >= CHECK_HITS}<p class="mut small">{$t('adminPeople.check.hitsCapped', { n: CHECK_HITS })}</p>{/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .check { display: flex; flex-direction: column; gap: 1rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; }
  .chip { display: inline-flex; align-items: center; gap: .5rem; min-height: 44px; min-width: 44px; max-width: 100%; padding: 0 1rem; border-radius: 99px; background: rgba(var(--fr-scrim-rgb), .25); color: var(--fg); border: 0; box-shadow: inset 0 0 0 1px var(--fr-line, var(--line)); font-weight: 600; }
  .chip:hover:not(.on) { background: rgba(255,255,255,.08); }
  .chip.on { background: var(--acc); color: #1a1a1a; }
  .cn { overflow-wrap: anywhere; text-align: left; }
  .mark { font-size: .8rem; font-weight: 600; opacity: .85; }
  .skel { display: flex; flex-direction: column; gap: .8rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; }
  .sec { padding: 1rem; margin: 0; }
  .sec h3 { margin: 0 0 .6rem; font-size: 1rem; font-weight: 700; }
  .sent, .libs, .hits { list-style: none; margin: 0; padding: 0; }
  .sent { display: flex; flex-direction: column; gap: .35rem; }
  .sent li { overflow-wrap: anywhere; }
  .libs li { display: flex; align-items: baseline; gap: .6rem; min-height: 44px; padding: .4rem 0; border-top: 1px solid var(--line); }
  .libs li:first-child { border-top: 0; }
  .libs li.off { color: var(--mut); }
  .mk { flex: none; width: 1.2rem; text-align: center; font-weight: 700; }
  .lt { overflow-wrap: anywhere; }
  .mut { color: var(--mut); margin: .4rem 0 0; }
  .small { font-size: .85rem; min-height: 1.3em; }
  .bad { color: var(--err); font-weight: 600; }
  .hit { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: .4rem 1rem; min-height: 44px; padding: .55rem 0; border-top: 1px solid var(--line); }
  .hit:first-child { border-top: 0; }
  .ht { display: flex; flex-direction: column; min-width: 0; }
  .hn { font-weight: 600; overflow-wrap: anywhere; }
  .hm { color: var(--mut); font-size: .82rem; overflow-wrap: anywhere; }
  /* the tone of a status pill (same washes), but the reason may wrap */
  .why { display: inline-flex; align-items: flex-start; gap: .3rem; padding: .2rem .6rem .2rem .45rem; border-radius: 12px; font-size: .8rem; font-weight: 600; line-height: 1.4; max-width: 100%; }
  .why :global(svg) { flex: none; margin-top: .2em; }
  .why > span { overflow-wrap: anywhere; }
  .why.ok { background: var(--wash-ok); color: var(--ok); }
  .why.warn { background: var(--wash-warn); color: var(--warn); }
  @media (max-width: 600px) { .sec { padding: .8rem; } }
</style>
