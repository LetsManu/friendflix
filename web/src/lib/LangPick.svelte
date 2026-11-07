<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { tick } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { isKnownLang, langLabel } from '#lib/langs';
  import { isBackKey } from '#lib/spatial';
  /** movie or episode that would be played (for a series: the next episode) */
  export let targetId: string;
  /** remembers the choice per title/series on this device */
  export let storeKey: string;
  /** chosen audio language ('' = default) and subtitles ('' = my default, 'off' = none) */
  export let audio = '';
  export let sub = '';
  /**
   * TV detail page: a labelled `.tv-btn` row instead of the two selects. OK opens two vertical lists (audio, subtitles) right
   * next to the button; the D-pad stays inside them, OK applies at once, Back closes and returns to the button.
   */
  export let tv = false;
  /** (read-only, bind:available) there is something to choose: more than one audio track or any subtitles */
  export let available = false;
  $: available = !!tr && (tr.audio.length > 1 || tr.subtitles.length > 0);
  type Tr = { audio: Array<{ language: string; title: string }>; subtitles: Array<{ language: string; title: string }> };
  let tr: Tr | null = null, loadedFor = '';
  /** language name in the UI language; unknown codes keep the track title from Jellyfin */
  const name = (l: { language: string; title: string }, unknown: string) => (l.language === 'und' ? unknown : isKnownLang(l.language) ? langLabel(l.language) : l.title);

  async function load(id: string) {
    if (!id || id === loadedFor) return;
    loadedFor = id;
    try { tr = await api<Tr>(`/api/items/${id}/tracks`); } catch { tr = null; }
    try { const s = JSON.parse(localStorage.getItem(`ff_lang:${storeKey}`) ?? '{}'); audio = tr?.audio.some((a) => a.language === s.audio) ? s.audio : ''; sub = s.sub === 'off' || tr?.subtitles.some((a) => a.language === s.sub) ? s.sub : ''; } catch { /* none saved */ }
  }
  $: load(targetId);
  const save = () => { try { localStorage.setItem(`ff_lang:${storeKey}`, JSON.stringify({ audio, sub })); } catch { /* private mode */ } };

  // ---- TV: the in-place lists ----
  let open = false, trig: HTMLButtonElement | undefined, panel: HTMLDivElement | undefined, place = '';
  /** the lists live on <body> (no clipping by the scrolling button list, no transformed ancestor), placed next to the button */
  const portal = (n: HTMLElement) => { document.body.appendChild(n); return { destroy: () => n.remove() }; };
  async function show() {
    if (!trig) return;
    const r = trig.getBoundingClientRect(), gap = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.5;
    place = `left:${Math.round(r.right + gap)}px;top:${Math.round(r.top)}px`;
    open = true;
    await tick();
    if (!panel) return;
    // keep it on screen: the bottom edge stays inside the 5 vh safe area
    const h = panel.getBoundingClientRect().height, max = innerHeight * 0.95 - h;
    if (r.top > max) place = `left:${Math.round(r.right + gap)}px;top:${Math.round(Math.max(innerHeight * 0.05, max))}px`;
    (panel.querySelector<HTMLElement>('[aria-checked="true"]') ?? panel.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }
  function hide(refocus: boolean) { if (!open) return; open = false; if (refocus) trig?.focus({ preventScroll: true }); }
  function pick(kind: 'audio' | 'sub', v: string) { if (kind === 'audio') audio = v; else sub = v; save(); }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' || isBackKey(e)) { e.preventDefault(); e.stopPropagation(); hide(true); }
  }
  function onOut(e: FocusEvent) { const to = e.relatedTarget as Node | null; if (to && !panel?.contains(to)) hide(false); }
  const onDoc = (e: Event) => { if (open && !panel?.contains(e.target as Node) && e.target !== trig) hide(false); };
  $: chosen = [audio ? name({ language: audio, title: audio }, audio) : '', sub === 'off' ? $t('detail.langPick.off') : sub ? name({ language: sub, title: sub }, sub) : ''].filter(Boolean).join(' · ');
</script>

<svelte:document on:pointerdown|capture={onDoc} />

{#if tv}
  <button type="button" class="tv-btn tvl" bind:this={trig} aria-haspopup="true" aria-expanded={open} on:click={() => (open ? hide(true) : void show())}>
    <Icon name="subtitles" size={24} /><span>{$t('player.controls.tracks')}</span>{#if chosen}<span class="val">{chosen}</span>{/if}
  </button>
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="tvlp" use:portal bind:this={panel} style={place} data-scope role="group" aria-label={$t('player.controls.tracks')} on:keydown={onKey} on:focusout={onOut}>
      <div class="col" role="radiogroup" aria-label={$t('detail.langPick.audio')}>
        <p class="hd">{$t('detail.langPick.audio')}</p>
        {#each [{ v: '', l: $t('detail.langPick.standard') }, ...(tr?.audio ?? []).map((a) => ({ v: a.language, l: name(a, $t('detail.langPick.unknown')) }))] as o (o.v)}
          <button type="button" class="tv-btn opt" role="radio" aria-checked={audio === o.v} on:click={() => pick('audio', o.v)}><span class="ck"><Icon name="check" size={24} /></span>{o.l}</button>
        {/each}
      </div>
      <div class="col" role="radiogroup" aria-label={$t('detail.langPick.subs')}>
        <p class="hd">{$t('detail.langPick.subs')}</p>
        {#each [{ v: '', l: $t('detail.langPick.standard') }, { v: 'off', l: $t('detail.langPick.off') }, ...(tr?.subtitles ?? []).map((a) => ({ v: a.language, l: name(a, $t('detail.langPick.unknown')) }))] as o (o.v)}
          <button type="button" class="tv-btn opt" role="radio" aria-checked={sub === o.v} on:click={() => pick('sub', o.v)}><span class="ck"><Icon name="check" size={24} /></span>{o.l}</button>
        {/each}
      </div>
    </div>
  {/if}
{:else if tr && (tr.audio.length > 1 || tr.subtitles.length)}
  <div class="lang flex">
    {#if tr.audio.length > 1}
      <label for="lg-a">{$t('detail.langPick.audio')}</label>
      <select id="lg-a" bind:value={audio} on:change={save}><option value="">{$t('detail.langPick.standard')}</option>{#each tr.audio as a}<option value={a.language}>{name(a, $t('detail.langPick.unknown'))}</option>{/each}</select>
    {/if}
    {#if tr.subtitles.length}
      <label for="lg-s">{$t('detail.langPick.subs')}</label>
      <select id="lg-s" bind:value={sub} on:change={save}><option value="">{$t('detail.langPick.standard')}</option><option value="off">{$t('detail.langPick.off')}</option>{#each tr.subtitles as a}<option value={a.language}>{name(a, $t('detail.langPick.unknown'))}</option>{/each}</select>
    {/if}
  </div>
{/if}

<style>
  .lang { margin: 0 0 1rem; gap: .5rem .8rem; } .lang label { color: var(--fg); }
  /* TV: the trigger is one row of the detail button list (look from app.css .tv-btn) */
  .tvl { width: 100%; justify-content: flex-start; transform-origin: left center; }
  .tvl[aria-expanded='true']:not(:focus-visible) { background: rgba(255, 255, 255, .28); }
  .tvl .val { margin-left: auto; padding-left: 1.5rem; font-weight: 500; color: var(--mut); white-space: nowrap; }
  .tvl:focus-visible .val { color: #3a3a3a; }
  /* the lists: a solid dark surface next to the button (no blur, no shadow-heavy card); they come in from the left */
  .tvlp { position: fixed; z-index: 40; display: flex; gap: 2.5rem; padding: 1.5rem 1.75rem; border-radius: var(--tv-radius); background: rgba(12, 12, 12, .94); animation: tvlp-in var(--tv-d-s) var(--tv-emph-out) both; }
  .col { display: flex; flex-direction: column; gap: .4rem; min-width: 15rem; max-height: 62vh; overflow-y: auto; scrollbar-width: none; padding: .35rem .6rem; margin: -.35rem -.6rem; }
  .col::-webkit-scrollbar { display: none; }
  .hd { margin: 0 0 .5rem; font-size: 1.1rem; font-weight: 500; color: var(--mut); }
  .tvlp .opt { justify-content: flex-start; flex: none; white-space: nowrap; background: transparent; min-height: 2.8rem; padding: 0 1.4rem; gap: .7rem; font-size: 1.1rem; color: var(--tv-white-78); }
  .tvlp .opt:focus-visible { background: #fff; color: #000; transform: scale(1.03); }
  .tvlp .opt[aria-checked='true']:not(:focus-visible) { color: #fff; }
  .opt .ck { display: grid; place-items: center; width: 1.5rem; opacity: 0; }
  .opt[aria-checked='true'] .ck { opacity: 1; color: var(--acc); }
  .opt[aria-checked='true']:focus-visible .ck { color: inherit; }
  @keyframes tvlp-in { from { opacity: 0; transform: translate3d(-12px, 0, 0); } }
</style>
