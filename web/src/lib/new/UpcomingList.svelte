<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** "Demnächst": announced releases as glass cards (date, poster, title, release) with the reminder button; the heading links to the calendar. */
  import { onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { dateBlock, releaseLabel } from '#lib/mobile';
  import type { Up } from '#lib/newpage';
  import { loadReminders, movieKey, remindKeys, toggleReminder } from '#lib/reminders';

  export let items: Up[];
  let msg = '';
  let availNow = new Set<number>();
  onMount(() => { void loadReminders(); });

  async function remind(it: Up) {
    const r = await toggleReminder(movieKey(it.mediaType, it.tmdbId), { mediaType: it.mediaType, tmdbId: it.tmdbId });
    if (r === 'busy') return;
    if (r === 'available') { availNow.add(it.tmdbId); availNow = availNow; msg = tr('home.upcoming.isAvailable', { title: it.title }); }
    else if (r === 'error') msg = tr('home.upcoming.remindFailed');
    else msg = r === 'on' ? tr('home.upcoming.remindSet', { title: it.title }) : tr('home.upcoming.remindRemoved');
  }
</script>

<section class="up" aria-labelledby="np-up">
  <div class="hd">
    <h2 id="np-up">{$t('home.new.upcoming')}</h2>
    <a class="cal" href="/calendar"><Icon name="calendar" size={16} />{$t('home.new.toCalendar')}</a>
  </div>
  <ul>
    {#each items as it (it.mediaType + it.tmdbId)}
      {@const db = dateBlock(it.releaseDate)}
      {@const on = $remindKeys[movieKey(it.mediaType, it.tmdbId)] !== undefined}
      <li class="frost frost-panel frost-safe">
        <div class="date" aria-hidden={db ? undefined : 'true'}>{#if db}<span class="mo">{db.month}</span><span class="dy">{db.day}</span>{/if}</div>
        <div class="pst">{#if it.poster}<img loading="lazy" src={it.poster} alt="" />{/if}</div>
        <div class="tx">
          <h3>{it.title}</h3>
          <p>{it.mediaType === 'tv' ? $t('home.meta.series') : $t('home.meta.movie')} · {releaseLabel(it.releaseDate)}</p>
        </div>
        <div class="act">
          {#if it.status === 'verfuegbar'}<span class="ok">{$t('home.upcoming.available')}</span>
          {:else if availNow.has(it.tmdbId)}<span class="ok">{$t('home.upcoming.alreadyAvailable')}</span>
          {:else}<button type="button" class="rem" class:on aria-pressed={on} aria-label={`${on ? $t('home.upcoming.reminderOn') : $t('home.upcoming.remind')}: ${it.title}`} on:click={() => remind(it)}><Icon name="bell" size={18} /><span>{on ? $t('home.upcoming.reminderOn') : $t('home.upcoming.remind')}</span></button>{/if}
        </div>
      </li>
    {/each}
  </ul>
  <p class="msg" role="status">{msg}</p>
</section>

<style>
  .up { min-width: 0; margin-top: 1.6rem; }
  .hd { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 0 0 .6rem; }
  h2 { margin: 0; font-size: 20px; font-weight: 700; line-height: 28px; letter-spacing: -.01em; }
  .cal { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; padding: 0 .3rem; color: var(--acc-text); font-weight: 600; font-size: .9rem; }
  .cal:hover { text-decoration: underline; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
  li { display: grid; grid-template-columns: 3.2rem 3rem minmax(0, 1fr) auto; align-items: center; gap: .9rem; padding: .7rem .9rem; border-radius: var(--fr-r-panel, 18px); }
  .date { display: flex; flex-direction: column; align-items: center; line-height: 1; }
  .mo { font-size: .7rem; font-weight: 700; letter-spacing: .06em; color: var(--mut); }
  .dy { font-size: 1.7rem; font-weight: 800; margin-top: .2rem; }
  .pst { width: 3rem; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; background: #1c2228; }
  .pst img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tx { min-width: 0; }
  h3 { margin: 0; font-size: 1.02rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  p { margin: .15rem 0 0; font-size: .85rem; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act { display: flex; align-items: center; }
  .ok { color: var(--ok, #4ade80); font-weight: 600; font-size: .9rem; }
  .rem { min-height: 44px; padding: 0 1.1rem; border-radius: 999px; font-size: .92rem; }
  .rem.on { background: #fff; color: #111; }
  .rem.on:hover:not(:disabled) { background: #e9e9ee; }
  .msg { min-height: 0; margin: .4rem 0 0; white-space: normal; }
  .msg:empty { display: none; }
  @media (max-width: 720px) {
    li { grid-template-columns: 2.6rem 2.6rem minmax(0, 1fr); gap: .7rem; }
    .pst { width: 2.6rem; }
    .act { grid-column: 1 / -1; justify-content: flex-end; margin-top: -.2rem; }
    h3, p { white-space: normal; }
  }
  :global(html.tv) li { padding: 1rem 1.2rem; }
  :global(html.tv) h3 { font-size: 1.5rem; }
  :global(html.tv) p { font-size: 1.125rem; color: var(--tv-white-78); }
  :global(html.tv) .rem { min-height: 56px; }
  :global(html.tv) .cal { min-height: 56px; font-size: 1.125rem; }
  :global(html.tv) .ok { font-size: 1.125rem; }
</style>
