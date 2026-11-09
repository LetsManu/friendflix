<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { backdrop, img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { motionAllowed } from '#lib/preview';
  import { stagger } from '#lib/tv/motion';
  import { springAt } from '#lib/player/desk/grow';
  import { CHIP_MS, creditPicks, type CreditsBeat } from '#lib/player/desk/logic';
  import { ringOffset } from '#lib/player/nextup';
  import type { PostplayRow } from '#lib/postplay';
  import type { PhoneOrient } from '#lib/player/phone/logic';

  /**
   * Credits sequence (spec 2026-11-08 §4, desktop, TV and phones) in three beats instead of a cut. The watch page owns the timing
   * (`creditsBeat`) and the countdown; the Player glides the picture (stage `.cred`).
   * - 'chip': "Watch credits" and "Next episode" (filling over CHIP_MS) rise in at the bottom right; a film offers "More like this".
   * - 'corner': the picture sits small in the top-left corner; the next episode (title, synopsis, Play with a countdown ring)
   *   rises in at the right - for a film or the last episode the post-play headline instead, without a countdown - and below it
   *   "More like this" (the first post-play row, five titles), 40 ms apart once the picture has glided (250 ms).
   * Phones (`phone`: the orientation): the chip sits at the end-side bottom above the home indicator; in the corner beat the next
   *   episode and the suggestions form one column right of the small picture (landscape) or below it (portrait, the suggestions as
   *   a row), each scrolling when short, everything inside the safe areas and every button at least 44 px.
   * TV: everything is a `data-nav` focusable; on entering 'corner' Play (a film: the first suggestion) takes the focus once.
   * 'off': the page keeps this component mounted, so backing out plays the layer's outro (opacity / transform, 200 ms).
   */
  export let beat: CreditsBeat;
  export let kind: 'episode' | 'movie';
  export let next: Item | null;
  export let rows: PostplayRow[] | null;
  export let headline: string;
  /** countdown seconds left; `total` 0 = no countdown running (autoplay off, sleep after this episode) */
  export let seconds: number;
  export let total: number;
  export let tv: boolean;
  /** the phone player's orientation ('off': desktop / TV) */
  export let phone: 'off' | PhoneOrient = 'off';
  /** px kept free at the bottom (phones, portrait: the page's post-play card sits there) */
  export let reserve = 0;

  const dispatch = createEventDispatcher<{ play: void; credits: void; pick: { item: Item }; more: void }>();
  const RING = 2 * Math.PI * 10;
  const motion = motionAllowed();
  const rise = (el: Element) => fly(el, { y: 16, duration: motion ? 300 : 0, easing: springAt });
  const out = (el: Element) => fade(el, { duration: motion ? 150 : 0 });
  /** back-out (beat -> 'off'): everything fades and sinks 8 px while the Player springs the picture back (never a cut) */
  const leave = (_el: Element) => ({ duration: motion ? 200 : 0, css: (k: number) => `opacity: ${k}; transform: translate3d(0, ${(1 - k) * 8}px, 0)` });

  $: picks = creditPicks(rows, next) as Item[];
  $: episode = kind === 'episode' && next !== null;
  $: elapsed = total > 0 ? (total - seconds) * 1000 : 0;

  let up: HTMLElement | undefined, sugg: HTMLElement | undefined, wc: HTMLElement | undefined;
  let entered = false, focused = false;
  $: if (beat === 'corner' && !entered) { entered = true; void tick().then(enterCorner); } else if (beat !== 'corner') entered = false;
  $: if (beat === 'off') focused = false; // a new entry into the credits (after seeking back) focuses once more
  /** the parts rise in after the picture's glide; TV: Play (a film: the first suggestion) takes the focus once */
  function enterCorner() {
    const parts = [...(up?.children ?? []), ...(sugg ? [sugg.querySelector('small'), ...sugg.querySelectorAll('li')] : []), wc]
      .filter((p): p is HTMLElement => p instanceof HTMLElement);
    stagger(parts, { delay: 250, gap: 40 });
    if (tv && !focused) focusOnce();
  }
  function focusOnce() {
    const a = document.activeElement;
    if (a && a.closest('[data-scope], .tvov, .dlg, .help')) return; // the viewer is in an overlay
    if (document.querySelector('.ctl.seeking')) return; // a seek preview is running
    const el = (episode ? up?.querySelector<HTMLElement>('.go') : null) ?? sugg?.querySelector<HTMLElement>('a') ?? up?.querySelector<HTMLElement>('button');
    if (!el) return;
    focused = true;
    el.focus({ preventScroll: true });
  }
  // TV chip: "Next episode" (a film: "More like this") takes the focus once, so OK plays it rather than the outro's skip button
  let chipFocused = false, chipEl: HTMLElement | undefined;
  $: if (tv && beat === 'chip' && !chipFocused) { chipFocused = true; void tick().then(focusChip); }
  $: if (beat === 'off') chipFocused = false;
  function focusChip() {
    const a = document.activeElement;
    if (a && a.closest('[data-scope], .tvov, .dlg, .help')) return;
    if (document.querySelector('.ctl.seeking')) return;
    chipEl?.querySelector<HTMLElement>('.go')?.focus({ preventScroll: true });
  }
  // a film's suggestions can arrive after the corner beat: they still take the focus once (TV)
  $: if (tv && beat === 'corner' && entered && !focused && picks.length) void tick().then(focusOnce);

  const epLine = (i: Item) => `S${i.parentIndexNumber ?? 1}:E${i.indexNumber ?? ''} · ${i.name}`;
  function pick(e: MouseEvent, item: Item) { e.preventDefault(); dispatch('pick', { item }); }
</script>

<!-- mounted by the watch page for the whole title (desktop / TV / phones): beat 'off' takes the layer away with an outro, never a cut -->
{#if beat !== 'off'}
<div class="cs" class:tv class:ph={phone !== 'off'} class:ph-land={phone === 'landscape'} class:ph-port={phone === 'portrait'} class:mo={motion} style:--cs-res="{reserve}px" data-beat={beat} out:leave>
  {#if beat === 'chip'}
    <div class="chip" bind:this={chipEl} data-nav role="group" aria-label={episode ? $t('player.watch.next') : $t('player.watch.more')} in:rise out:out>
      <button type="button" class="sec" on:click|stopPropagation={() => dispatch('credits')}>{$t('player.watch.watchCredits')}</button>
      {#if episode}
        <button type="button" class="go" on:click|stopPropagation={() => dispatch('play')}><i class="fill" class:run={motion} style:animation-duration="{CHIP_MS}ms" aria-hidden="true"></i><span>{$t('player.watch.next')}</span><Icon name="play" size={18} /></button>
      {:else}
        <button type="button" class="go" on:click|stopPropagation={() => dispatch('more')}><span>{$t('player.watch.more')}</span></button>
      {/if}
    </div>
  {:else if beat === 'corner'}
    <button type="button" class="wc" data-nav bind:this={wc} on:click|stopPropagation={() => dispatch('credits')}>{$t('player.watch.watchCredits')}</button>
    <!-- desktop / TV: no box of its own (display: contents); phones: the scrolling column beside / below the small picture -->
    <div class="col">
    <section class="up" data-nav bind:this={up} aria-label={episode ? $t('player.credits.upNext') : headline} out:out>
      {#if episode && next}
        <small>{$t('player.credits.upNext')}</small>
        <h3>{epLine(next)}</h3>
        {#if next.overview}<p>{next.overview}</p>{/if}
        <div class="acts">
          <button type="button" class="go" on:click|stopPropagation={() => dispatch('play')}>
            {#if total > 0}<svg class="ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="bg" cx="12" cy="12" r="10" /><circle class="fg" cx="12" cy="12" r="10" stroke-dasharray={RING} stroke-dashoffset={ringOffset(elapsed, RING, total * 1000)} transform="rotate(-90 12 12)" /></svg>{:else}<Icon name="play" size={20} />{/if}
            <span>{$t('player.watch.next')}{total > 0 ? $t('player.watch.inSeconds', { n: seconds }) : ''}</span>
          </button>
        </div>
      {:else if headline}
        <h3 class="hl">{headline}</h3>
      {/if}
    </section>
    {#if picks.length}
      <section class="sugg" data-nav bind:this={sugg} aria-label={$t('player.watch.more')} out:out>
        <small>{$t('player.watch.more')}</small>
        <ul>{#each picks as m (m.id)}
          <li><a href="/item/{m.id}" on:click|stopPropagation={(e) => pick(e, m)}>
            {#if m.backdrop}<img src={backdrop(m.id, 480)} alt="" loading="lazy" />{:else if m.image}<img src={img(m.id, 320)} alt="" loading="lazy" />{:else}<span class="ph"><Icon name="film" size={24} /></span>{/if}
            <span class="mt">{m.name}</span></a></li>{/each}</ul>
      </section>
    {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  /* above the picture, below the Player's menus; only the buttons and cards take the pointer (a click on the small picture backs out) */
  .cs { position: absolute; inset: 0; z-index: 9; pointer-events: none; color: #fff; }
  .cs :is(button, a) { pointer-events: auto; }
  /* beat 1: two buttons bottom right, above the skip button and the bar (--ctl-h: the bar's measured height, set by the Player) */
  .chip { position: absolute; right: max(clamp(1.5rem, 3vw, 3rem), var(--safe-right, 0px)); bottom: calc(var(--ctl-h, 8rem) + 4.5rem); display: flex; gap: .5rem; }
  .chip button { min-height: 44px; border-radius: 8px; font-weight: 700; }
  .chip .sec { background: rgba(30, 30, 34, .8); border: 1px solid rgba(255, 255, 255, .2); }
  .go { position: relative; overflow: hidden; background: #fff; color: #111; border-radius: 8px; font-weight: 700; }
  .go:hover:not(:disabled) { background: #e9e9ee; }
  .go > :not(.fill) { position: relative; }
  .fill { position: absolute; inset: 0; background: rgba(255, 79, 109, .35); transform-origin: left; transform: scaleX(0); }
  .fill.run { animation: cs-fill linear forwards; }
  @keyframes cs-fill { to { transform: scaleX(1); } }
  /* beat 3: the picture sits in the top-left corner (Player: translate(-27%, -24%) scale(.42) = 2–44 % x, 5–47 % y) */
  .wc { position: absolute; left: calc(2% + .9rem); top: calc(5% + .9rem); min-height: 0; padding: .3rem .8rem; border-radius: 99px; font-size: .8rem; font-weight: 600;
    background: rgba(0, 0, 0, .55); border: 1px solid rgba(255, 255, 255, .25); }
  .wc:hover:not(:disabled) { background: rgba(0, 0, 0, .75); }
  .up { position: absolute; right: clamp(1.5rem, 4vw, 3.5rem); top: 5%; width: min(40%, 34rem); display: grid; gap: .6rem; justify-items: start; }
  .up small, .sugg small { color: rgba(255, 255, 255, .65); font-weight: 600; font-size: .9rem; }
  .up h3 { margin: 0; font-size: clamp(1.4rem, 2.4vw, 2.2rem); line-height: 1.1; font-weight: 800; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .up p { margin: 0; color: #cfcfd6; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .acts { margin-top: .3rem; }
  .acts .go { padding: .6rem 1.2rem; gap: .55rem; }
  .ring { width: 22px; height: 22px; flex: none; }
  .ring circle { fill: none; stroke-width: 3; }
  .ring .bg { stroke: rgba(0, 0, 0, .18); }
  .ring .fg { stroke: var(--acc, #ff4f6d); stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
  .sugg { position: absolute; left: clamp(1.5rem, 3vw, 3rem); right: clamp(1.5rem, 3vw, 3rem); bottom: clamp(1.25rem, 4vh, 2.5rem); display: grid; gap: .5rem; }
  .sugg ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .7rem; }
  .sugg a { display: grid; gap: .35rem; color: #fff; text-decoration: none; border-radius: 8px; outline-offset: 3px; }
  .sugg img, .sugg .ph { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; display: grid; place-items: center; background: #1c2228; color: var(--mut); }
  .sugg a:hover img, .sugg a:focus-visible img { box-shadow: 0 0 0 2px #fff; }
  .mt { font-size: .85rem; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (prefers-reduced-motion: reduce) { .fill.run { animation: none; } .ring .fg { transition: none; } }
  /* TV: inside the safe area, white fill on focus (no ring), the spatial navigation moves between Play and the cards */
  .tv .chip { right: var(--tv-safe-x, 5vw); bottom: calc(var(--ctl-h, 8rem) + var(--tv-safe-y, 5vh) + 5.5rem); }
  .tv .up { right: var(--tv-safe-x, 5vw); }
  .tv .sugg { left: var(--tv-safe-x, 5vw); right: var(--tv-safe-x, 5vw); bottom: var(--tv-safe-y, 5vh); }
  .tv :is(.sec, .wc, .go) { border-radius: var(--tv-radius, 8px); transition: transform var(--tv-d-s, 150ms) var(--tv-emph-out, ease-out); }
  .tv :is(.sec, .wc, .go):focus-visible { outline: none; background: #fff; color: #000; transform: scale(1.05); }
  .tv .go:not(:focus-visible) { background: var(--tv-btn-rest, rgba(255, 255, 255, .2)); color: #fff; }
  .tv .sugg a:focus-visible { outline: none; }
  .tv .sugg a:focus-visible img { box-shadow: 0 0 0 4px #fff; }
  .col { display: contents; }
  /* ---- phones (spec 2026-11-08 §4): inside the safe areas, nothing over the small picture but the "Watch credits" pill ---- */
  /* beat 1: end-side bottom above the home indicator; while the dock shows (a tap) the chip rides above it, never on it */
  .ph .chip { right: calc(var(--safe-right) + 16px); bottom: calc(var(--safe-bottom) + 16px + var(--cs-res, 0px)); max-width: calc(100% - var(--safe-left) - var(--safe-right) - 32px); }
  /* (never above the top bar: on a short landscape phone it stops 8 px below it; --sh2: half the stage height, set by the Player) */
  :global(.stage:not(.idle)) .ph .chip { transform: translate3d(0, max(calc(var(--safe-bottom) + 8px - var(--ctl-h, 0px)),
    calc(var(--safe-top) + var(--safe-bottom) + 120px + var(--cs-res, 0px) - 2 * var(--sh2, 50vh))), 0); }
  .ph.mo .chip { transition: transform 250ms var(--m-emph-out, ease-out); }
  .ph .chip button { padding: .55rem 1rem; }
  /* "Watch credits" over the picture's top-start corner (landscape: the picture starts 12 px past safe-left, 12 px down; portrait:
     scale .92 leaves 4 % at the side, 12 px below the status bar) */
  .ph .wc { min-height: 44px; padding: .4rem 1rem; font-size: .85rem; }
  .ph-land .wc { left: calc(var(--safe-left) + 12px + 10px); top: calc(var(--safe-top) + 12px + 10px); }
  .ph-port .wc { left: calc(var(--safe-left) + 4% + 10px); top: calc(var(--safe-top) + 12px + 10px); }
  /* beat 3: one column, scrolls when short; only it takes the pointer (the small picture beside / above it backs out) */
  .ph .col { position: absolute; display: flex; flex-direction: column; gap: 1rem; overflow-y: auto; overscroll-behavior: contain; pointer-events: auto; scrollbar-width: none; }
  .ph .col::-webkit-scrollbar { display: none; }
  .ph .up, .ph .sugg { position: static; width: auto; inset: auto; flex: none; }
  .ph .up { gap: .45rem; }
  .ph .up h3 { font-size: 1.25rem; }
  .ph .up p { font-size: .9rem; }
  .ph .acts .go { min-height: 44px; }
  /* landscape: right of the picture (its end edge: safe-left + 12 px + .42 x the picture's width --pw, set by the Player; then 20 px)
     to the end-side inset */
  .ph-land .col { left: calc(var(--safe-left) + 32px + .42 * var(--pw, 100vw)); right: calc(var(--safe-right) + 16px); top: calc(var(--safe-top) + 12px); bottom: calc(var(--safe-bottom) + 16px); }
  .ph-land .sugg ul { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; }
  /* portrait: below the small picture (its bottom: safe-top + 12 px + the picture's height x .92), the suggestions as a row */
  .ph-port .col { left: calc(var(--safe-left) + 16px); right: calc(var(--safe-right) + 16px); top: calc(var(--safe-top) + 100vw / var(--va, 1.7778) * .92 + 28px);
    bottom: calc(var(--safe-bottom) + 16px + var(--cs-res, 0px)); }
  .ph-port .sugg ul { display: flex; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; gap: .6rem; }
  .ph-port .sugg ul::-webkit-scrollbar { display: none; }
  .ph-port .sugg li { flex: none; width: 42vw; }
</style>
