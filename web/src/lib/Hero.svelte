<script lang="ts">
  import { backdrop, fmtMin, type Item } from '$lib/api';
  import Icon from '$lib/Icon.svelte';

  /** Billboard at the top of the home page / detail page. */
  export let item: Item | null;
  export let playHref = '';
  export let playLabel = 'Abspielen';
  export let more = true;
  let loaded = false;
</script>

<section class="hero" aria-label="Empfehlung">
  {#if item}
    {#if item.backdrop}<img class="bg" class:loaded src={backdrop(item.id)} alt="" fetchpriority="high" on:load={() => (loaded = true)} />{/if}
    <div class="shade"></div>
    <div class="content">
      <h1>{item.name}</h1>
      <p class="meta">
        {#if item.communityRating}<span class="match">{Math.round(item.communityRating * 10)}% Match</span>{/if}
        {#if item.year}<span>{item.year}</span>{/if}
        {#if item.rating}<span class="age">{item.rating}</span>{/if}
        {#if item.runtimeTicks && item.type !== 'Series'}<span>{fmtMin(item.runtimeTicks)}</span>{/if}
        {#if item.type === 'Series'}<span>Serie</span>{/if}
      </p>
      {#if item.overview}<p class="ov">{item.overview}</p>{/if}
      <div class="btns">
        <a class="btn light" href={playHref || (item.type === 'Series' ? `/item/${item.id}` : `/watch/${item.id}`)}><Icon name="play" size={22} />{playLabel}</a>
        {#if more}<a class="btn sec" href="/item/{item.id}"><Icon name="info" size={22} />Mehr Infos</a>{/if}
      </div>
    </div>
  {:else}
    <div class="skeleton fill"></div>
  {/if}
</section>

<style>
  .hero { position: relative; height: clamp(420px, 78vh, 860px); margin-bottom: -7vw; overflow: hidden; background: var(--bg); }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; opacity: 0; transition: opacity .8s var(--ease); }
  .bg.loaded { opacity: 1; }
  .fill { position: absolute; inset: 0; border-radius: 0; }
  .shade { position: absolute; inset: 0; background:
      linear-gradient(77deg, rgba(0,0,0,.85) 0%, rgba(0,0,0,.45) 35%, transparent 65%),
      linear-gradient(to top, var(--bg) 0%, rgba(20,20,20,.88) 10%, transparent 46%),
      linear-gradient(to bottom, rgba(0,0,0,.55), transparent 22%); }
  .content { position: absolute; left: var(--pad-x); bottom: 22%; max-width: min(40rem, 88vw); z-index: 2; }
  h1 { font-size: clamp(2rem, 5.2vw, 4.4rem); font-weight: 800; margin: 0 0 .6rem; text-shadow: 0 2px 18px rgba(0,0,0,.6); letter-spacing: -.02em; }
  .meta { display: flex; flex-wrap: wrap; gap: .8rem; align-items: center; color: #d2d2d2; margin: 0 0 .8rem; font-weight: 500; }
  .match { color: var(--ok); font-weight: 700; }
  .age { border: 1px solid rgba(255,255,255,.5); padding: 0 .4rem; font-size: .85rem; }
  .ov { font-size: clamp(.95rem, 1.35vw, 1.2rem); margin: 0 0 1.2rem; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 1px 8px rgba(0,0,0,.7); }
  .btns { display: flex; gap: .8rem; flex-wrap: wrap; }
  .btns .btn { font-size: 1.05rem; padding: .7rem 1.7rem; }
  @media (max-width: 700px) { .hero { height: 66vh; margin-bottom: -5vh; } .content { bottom: 18%; } .btns .btn { padding: .6rem 1.1rem; } }
</style>
