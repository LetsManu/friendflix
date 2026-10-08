<script lang="ts">
  import { backdrop, fmtMin, logoUrl, type Item } from '$lib/api';
  import Icon from '$lib/Icon.svelte';
  import Logo from '$lib/Logo.svelte';
  import { openModal } from '$lib/modal';
  import { listIds, toggleList } from '$lib/stores';

  /** Billboard at the top of the home page / detail page. */
  export let item: Item | null;
  export let playHref = '';
  export let playLabel = 'Abspielen';
  export let more = true;
  /** position in a ranking (1-10); shows the "#n" line like a Top-10 billboard. 0 = none */
  export let rank = 0;
  export let rankLabel = 'in den Top 10 nach Bewertung';
  let loaded = false, logoFailed = false;
  $: item, (logoFailed = false);
  $: listId = item ? (item.seriesId ?? item.id) : '';
  $: inList = listId ? $listIds.has(listId) : false;
  $: kind = item?.type === 'Series' ? 'Serie' : item?.type === 'Episode' ? 'Folge' : 'Film';
  $: tagline = item ? item.genres.slice(0, 3).join(' · ') : '';
</script>

<section class="hero" aria-label="Empfehlung">
  {#if item}
    {#if item.backdrop}<img class="bg" class:loaded src={backdrop(item.id)} alt="" fetchpriority="high" on:load={() => (loaded = true)} />{/if}
    <div class="shade"></div>
    <div class="content">
      <p class="eyebrow"><Logo size={22} label="" /><span>{kind}</span></p>
      {#if item.logo && !logoFailed}
        <h1 class="logoh"><img class="tlogo" src={logoUrl(item.id)} alt={item.name} on:error={() => (logoFailed = true)} /></h1>
      {:else}<h1>{item.name}</h1>{/if}
      {#if rank > 0}
        <p class="rankline"><span class="top10" aria-hidden="true"><small>TOP</small>10</span>#{rank} {rankLabel}</p>
      {:else if tagline}<p class="rankline plain">{tagline}</p>{/if}
      <p class="meta">
        {#if item.communityRating}<span class="match">{Math.round(item.communityRating * 10)}% Match</span>{/if}
        {#if item.year}<span>{item.year}</span>{/if}
        {#if item.runtimeTicks && item.type !== 'Series'}<span>{fmtMin(item.runtimeTicks)}</span>{/if}
      </p>
      {#if item.overview}<p class="ov">{item.overview}</p>{/if}
      <div class="btns">
        <a class="btn light" data-autofocus href={playHref || (item.type === 'Series' ? `/item/${item.id}` : `/watch/${item.id}`)}><Icon name="play" size={24} />{playLabel}</a>
        <button class="btn grey" aria-pressed={inList} on:click={() => toggleList(listId, inList)}><Icon name={inList ? 'check' : 'plus'} size={24} />Meine Liste</button>
        {#if more}<a class="btn grey round" href="/item/{item.id}" aria-label="Mehr Infos" title="Mehr Infos" on:click={(e) => openModal(e, `/item/${item.id}`)}><Icon name="info" size={24} /></a>{/if}
      </div>
    </div>
    {#if item.rating}<div class="agebox" aria-label="Altersfreigabe {item.rating}"><span>{item.rating}</span></div>{/if}
  {:else}
    <div class="skeleton fill"></div>
  {/if}
</section>

<style>
  .hero { position: relative; height: clamp(460px, 88vh, 940px); margin-bottom: -9vw; overflow: hidden; background: var(--bg); }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; opacity: 0; transition: opacity .8s var(--ease); }
  .bg.loaded { opacity: 1; }
  .fill { position: absolute; inset: 0; border-radius: 0; }
  .shade { position: absolute; inset: 0; background:
      linear-gradient(77deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.5) 30%, transparent 62%),
      linear-gradient(to top, var(--bg) 0%, rgba(20,20,20,.9) 9%, transparent 42%),
      linear-gradient(to bottom, rgba(0,0,0,.65), transparent 24%); }
  .content { position: absolute; left: var(--pad-x); bottom: 25%; max-width: min(42rem, 88vw); z-index: 2; }
  .eyebrow { display: flex; align-items: center; gap: .55rem; margin: 0 0 .5rem; font-size: .78rem; font-weight: 700; letter-spacing: .4em; text-transform: uppercase; color: #d9d9d9; text-shadow: 0 1px 6px rgba(0,0,0,.7); }
  h1 { font-size: clamp(2.2rem, 5.6vw, 4.8rem); font-weight: 800; margin: 0 0 .8rem; text-shadow: 0 2px 18px rgba(0,0,0,.6); letter-spacing: -.02em; line-height: 1.02; }
  .logoh { margin: 0 0 1rem; }
  .tlogo { display: block; max-width: min(100%, 28rem); max-height: 10rem; object-fit: contain; object-position: left bottom; filter: drop-shadow(0 4px 18px rgba(0,0,0,.6)); }
  .rankline { display: flex; align-items: center; gap: .6rem; margin: 0 0 .5rem; font-size: clamp(1.1rem, 1.9vw, 1.6rem); font-weight: 700; text-shadow: 0 1px 8px rgba(0,0,0,.7); }
  .rankline.plain { font-weight: 600; font-size: clamp(1rem, 1.5vw, 1.25rem); color: #e8e8e8; }
  .top10 { display: inline-grid; place-items: center; width: 1.9rem; height: 1.9rem; background: var(--acc); border-radius: 4px; font-size: 1rem; font-weight: 900; line-height: .85; padding-top: .1rem; } .top10 small { font-size: .5rem; letter-spacing: .08em; display: block; }
  .meta { display: flex; flex-wrap: wrap; gap: .8rem; align-items: center; color: #d2d2d2; margin: 0 0 .7rem; font-weight: 500; }
  .match { color: var(--ok); font-weight: 700; }
  .ov { font-size: clamp(1rem, 1.45vw, 1.28rem); line-height: 1.5; margin: 0 0 1.4rem; max-width: 38rem; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 1px 8px rgba(0,0,0,.8); }
  .btns { display: flex; gap: .8rem; flex-wrap: wrap; align-items: center; }
  .btns .btn { font-size: 1.15rem; font-weight: 600; padding: .55rem 1.9rem .55rem 1.5rem; min-height: 52px; border-radius: 4px; }
  .btn.grey { background: rgba(109,109,110,.7); color: #fff; padding-left: 1.4rem; }
  .btn.grey:hover:not(:disabled) { background: rgba(109,109,110,.45); }
  .btn.round { width: 52px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.55); }
  .btn.round:hover { background: rgba(42,42,42,.9); border-color: #fff; }
  /* age rating box on the right edge, like a TV network bug */
  .agebox { position: absolute; right: 0; bottom: calc(25% + .35rem); z-index: 2; display: flex; align-items: center; min-height: 52px; padding: 0 var(--pad-x) 0 1.1rem; background: rgba(51,51,51,.6); border-left: 3px solid #dcdcdc; font-size: 1.1rem; font-weight: 600; letter-spacing: .02em; backdrop-filter: blur(4px); }
  @media (max-width: 460px) { .btn.round { display: none; } }
  @media (max-width: 700px) { .hero { height: 68vh; margin-bottom: -5vh; } .content { bottom: 17%; } .btns .btn { padding: .5rem 1.1rem; font-size: 1rem; min-height: 46px; } .btn.round { width: 46px; } .agebox { display: none; } .eyebrow { letter-spacing: .3em; } }
</style>
