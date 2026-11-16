<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" context="module">
  export type PreviewView = 'desktop' | 'phone' | 'tv' | 'signIn';
  export const PREVIEW_VIEWS: readonly PreviewView[] = ['desktop', 'phone', 'tv', 'signIn'];
</script>

<script lang="ts">
  /**
   * Admin → Branding's live preview (the mockup's four panes): a faithful mini rendering of the desktop start page, the phone with its
   * home-screen symbol, the TV / Chromecast start screen and the sign-in, all from the staged brand (`b`, model.ts previewBrand). The
   * shell's own mark is reused (Mark → lib/Logo.svelte with the staged brand); the colours come from custom properties set on the frame
   * (model.ts previewVars: derived colour values only), the glow is app.css's per mode (model.ts glowBackground). The frame has a fixed
   * size, so switching panes moves nothing; a pane fades in (opacity only). Nothing in it is interactive.
   */
  import { brandPalette, headerParts, type LoadedBrand } from '#lib/brand';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Mark from './Mark.svelte';
  import { glowBackground, previewVars } from './model';

  export let b: LoadedBrand;
  export let view: PreviewView;
  /** the id of the tab that labels this panel */
  export let labelledby: string;
  /** the frame's id (the preview tabs' aria-controls) */
  export let id: string | undefined = undefined;

  $: vars = previewVars(b);
  $: glow = glowBackground(b.brand.glow, b.tokens);
  $: parts = headerParts(b);
  $: byline = b.brand.byline.trim();
  $: pal = brandPalette(b.tokens);
  $: signInShown = b.brand.signInBg === 'image' && b.images.signIn ? 'image' : b.brand.signInBg === 'color' ? 'color' : 'posters';
  /** the cover wall's stand-in: the generated tiles' colours and the dark poster tones of the mockup */
  $: tiles = Array.from({ length: 18 }, (_, i) => (i % 3 === 0 ? pal.art[i % pal.art.length] : ['#2b3f4c', '#3d2a3f', '#2f3a2c', '#43352a', '#2a3a45', '#3a2f45'][i % 6]));
</script>

<div class="frame" {id} data-pv-frame role="tabpanel" aria-labelledby={labelledby} style={vars}>
  <div class="glow" style:background={glow}></div>
  {#key view}
    <div class="pane">
      {#if view === 'desktop'}
        <div class="desk">
          <div class="chrome"><span class="ctab"><Mark {b} size={14} /><span class="ct">{$t('common.pageTitle', { page: $t('admin.branding.preview.navHome'), app: b.name })}</span></span></div>
          <div class="bar">
            {#if parts.logo}
              <img class="logo" data-pv="logo" src={parts.logo} alt="" draggable="false" />
            {:else}
              {#if parts.mark}<Mark {b} size={28} />{/if}
              {#if parts.name}<span class="nm" data-pv="name">{b.name}</span>{/if}
            {/if}
            <span class="nav on">{$t('admin.branding.preview.navHome')}</span>
            <span class="nav">{$t('admin.branding.preview.navMovies')}</span>
            <span class="nav">{$t('admin.branding.preview.navLive')}</span>
            <span class="sp"></span><Icon name="search" size={18} />
          </div>
          <div class="hero">
            <span class="ht">{$t('admin.branding.preview.heroTitle')}</span>
            <span class="hm">{$t('admin.branding.preview.heroMeta')}</span>
            <span class="btns"><span class="fill-btn" data-pv="play">{$t('admin.branding.preview.play')}</span><span class="ghost-btn">{$t('admin.branding.preview.watchlist')}</span></span>
          </div>
          <div class="foot" data-pv="byline">{byline ? `${b.name} · ${byline}` : b.name}</div>
        </div>
      {:else if view === 'phone'}
        <div class="phone-wrap">
          <div class="phone">
            <div class="ph-top">
              {#if parts.logo}
                <img class="ph-logo" src={parts.logo} alt="" draggable="false" />
              {:else}
                <span class="ph-brand">{#if parts.mark}<Mark {b} size={22} />{/if}{#if parts.name}<span class="ph-nm" data-pv="name">{b.name}</span>{/if}</span>
              {/if}
              <span class="avatar"></span>
            </div>
            <div class="ph-card">
              <span class="ph-title">{$t('admin.branding.preview.phoneTitle')}</span>
              <span class="fill-btn small">{$t('admin.branding.preview.resume')}</span>
            </div>
            <div class="ph-tabs">
              <span class="on">{$t('admin.branding.preview.navHome')}</span><span>{$t('admin.branding.preview.navNew')}</span><span>{$t('admin.branding.preview.watchlist')}</span>
            </div>
          </div>
          <div class="home">
            <span class="home-ic"><Mark {b} size={60} /></span>
            <span class="home-nm" data-pv="short">{b.shortName}</span>
            <span class="cap">{$t('admin.branding.preview.homeScreen')}</span>
          </div>
        </div>
      {:else if view === 'tv'}
        <div class="tv-wrap">
          <div class="tv">
            <div class="tv-glow"></div>
            <Mark {b} size={60} />
            <span class="tv-nm" data-pv="name">{b.name}</span>
            <span class="tv-by">{byline}</span>
            <span class="tv-load"><i></i></span>
          </div>
          <span class="cap">{$t('admin.branding.preview.tvCaption')}</span>
        </div>
      {:else}
        <div class="signin">
          {#if signInShown === 'posters'}
            <div class="posters" data-pv="posters">{#each tiles as c, i (i)}<i style:background={c}></i>{/each}</div>
          {:else if signInShown === 'image'}
            <img class="own" data-pv="signin-image" src={b.images.signIn} alt="" draggable="false" />
          {/if}
          <div class="dim"></div>
          <div class="card">
            <Mark {b} size={48} />
            <span class="si-nm" data-pv="name">{b.name}</span>
            <span class="si-by">{byline}</span>
            <span class="si-hi">{$t('admin.branding.preview.greeting')}</span>
            <span class="fill-btn block">{$t('admin.branding.preview.signIn')}</span>
          </div>
        </div>
      {/if}
    </div>
  {/key}
</div>

<style>
  /* the frame: a fixed size whatever the pane (desktop 520 px high, a phone 460 px), the glass radius */
  .frame { position: relative; height: 520px; border-radius: var(--fr-r-panel); overflow: hidden; border: 1px solid rgba(255, 255, 255, .12); background: #0a090d; color: #f5f5f5; isolation: isolate; }
  @media (max-width: 720px) { .frame { height: 460px; } }
  .glow { position: absolute; inset: 0; pointer-events: none; }
  .pane { position: relative; height: 100%; animation: pv-in 160ms linear both; }
  @keyframes pv-in { from { opacity: 0; } to { opacity: 1; } }
  :global(html.m-still) .pane { animation: none; }
  @media (prefers-reduced-motion: reduce) { .pane { animation: none; } }
  .cap { font-size: .82rem; color: rgba(255, 255, 255, .78); text-align: center; }
  span { min-width: 0; }

  .fill-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 0 16px; border-radius: 999px; background: var(--acc-fill); color: #fff; font-weight: 700; font-size: .85rem; white-space: nowrap; }
  .fill-btn.small { min-height: 30px; font-size: .75rem; }
  .fill-btn.block { width: 100%; }
  .ghost-btn { display: inline-flex; align-items: center; min-height: 36px; padding: 0 16px; border-radius: 999px; background: rgba(255, 255, 255, .1); border: 1px solid rgba(255, 255, 255, .18); font-weight: 700; font-size: .85rem; white-space: nowrap; }

  /* desktop */
  .desk { display: flex; flex-direction: column; height: 100%; }
  .chrome { height: 34px; flex: none; display: flex; align-items: flex-end; padding: 0 12px; background: #1b1f25; }
  .ctab { display: inline-flex; align-items: center; gap: 7px; height: 26px; max-width: 70%; padding: 0 12px; border-radius: 8px 8px 0 0; background: #101418; font-size: .72rem; font-weight: 600; }
  .ct { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 56px; flex: none; display: flex; align-items: center; gap: 14px; padding: 0 18px; font-size: .82rem; font-weight: 600; }
  .logo { height: 28px; width: 112px; object-fit: contain; object-position: left center; flex: none; }
  .nm { font-weight: 800; font-size: 1.05rem; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 9em; flex: 0 1 auto; }
  .nav { color: rgba(255, 255, 255, .72); white-space: nowrap; padding: 6px 0 4px; border-bottom: 2px solid transparent; }
  .nav.on { color: #fff; border-bottom-color: var(--acc); }
  .sp { flex: 1; }
  .hero { margin: 4px 18px 0; height: 230px; flex: none; border-radius: 16px; background: linear-gradient(160deg, #2b3f4c, #1d2a33); display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; padding: 18px; }
  .ht { font-weight: 800; font-size: 1.35rem; line-height: 1.15; }
  .hm { font-weight: 600; font-size: .8rem; color: var(--acc-text); }
  .btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .foot { margin: auto 18px 0; padding: 12px 0 16px; border-top: 1px solid rgba(255, 255, 255, .08); font-size: .8rem; color: rgba(255, 255, 255, .78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* phone */
  .phone-wrap { height: 100%; display: flex; align-items: center; justify-content: center; gap: 28px; padding: 0 12px; }
  .phone { position: relative; flex: none; width: 200px; height: 410px; border-radius: 32px; border: 6px solid #2a2f36; background: #101418; overflow: hidden; }
  @media (max-width: 720px) { .phone { width: 180px; height: 380px; } }
  .ph-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 26px 12px 8px; }
  .ph-brand { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .ph-nm { font-weight: 800; font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ph-logo { height: 22px; width: 88px; object-fit: contain; object-position: left center; }
  .avatar { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--acc-fill); }
  .ph-card { margin: 4px 10px; height: 200px; border-radius: 14px; background: linear-gradient(160deg, #3d2a3f, #24192a); display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; padding: 10px; }
  .ph-title { font-weight: 800; font-size: .9rem; }
  .ph-tabs { position: absolute; left: 8px; right: 8px; bottom: 10px; height: 40px; border-radius: 20px; background: rgba(30, 32, 40, .92); display: flex; align-items: center; justify-content: space-around; font-size: .62rem; font-weight: 700; color: rgba(255, 255, 255, .72); }
  .ph-tabs .on { color: var(--acc-text); }
  .home { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 96px; }
  .home-ic { display: grid; place-items: center; width: 60px; height: 60px; border-radius: 16px; overflow: hidden; }
  .home-nm { font-weight: 600; font-size: .8rem; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* TV / Chromecast */
  .tv-wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 0 14px; }
  .tv { position: relative; width: 100%; max-width: 560px; aspect-ratio: 16 / 9; border-radius: 12px; border: 6px solid #22262c; background: #050608; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
  .tv-glow { position: absolute; inset: 0; background: radial-gradient(50% 60% at 50% 55%, rgba(var(--acc-rgb), .28), transparent 70%); }
  .tv > :global(*) { position: relative; }
  .tv-nm { font-weight: 800; font-size: 1.5rem; max-width: 90%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-by { font-weight: 600; font-size: .8rem; color: rgba(255, 255, 255, .72); min-height: 1.2em; }
  .tv-load { width: 100px; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .12); overflow: hidden; margin-top: 10px; }
  .tv-load i { display: block; width: 45%; height: 100%; background: var(--acc); }

  /* sign-in */
  .signin { position: relative; height: 100%; display: grid; place-items: center; padding: 0 16px; }
  .posters { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); grid-auto-rows: 1fr; gap: 8px; padding: 8px; }
  .posters i { border-radius: 8px; opacity: .75; }
  .own { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .dim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(10, 12, 16, .55), rgba(10, 12, 16, .85)); }
  .card { position: relative; width: min(320px, 100%); border-radius: var(--fr-r-panel); padding: 24px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
    border: 1px solid rgba(255, 255, 255, .2); background: linear-gradient(180deg, rgba(240, 236, 248, .17), rgba(236, 232, 244, .11)), rgba(18, 16, 24, .62); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .26), 0 18px 40px rgba(0, 0, 0, .45); }
  .si-nm { font-weight: 800; font-size: 1.4rem; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .si-by { font-weight: 600; font-size: .8rem; color: rgba(255, 255, 255, .78); min-height: 1.2em; margin-top: -4px; }
  .si-hi { font-weight: 600; font-size: .9rem; margin: 6px 0 4px; }
</style>
