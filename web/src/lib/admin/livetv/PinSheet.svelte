<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Programm zuordnen…* (extra-guides plan Task 8): what the channel is mapped to now ("Hafenkanal aus „Sternwarte Guide“", *Automatisch*,
   * *Kein Programm*; a pin to a switched-off guide says "Programmführer ausgeschaltet"), *Automatisch* (`null`, matched at once) and *Kein
   * Programm* (`{ none: true }`), and the pin itself: a guide picker (lists with a guide and the enabled extra guides, `pinGuides`), a name
   * search over that guide's XMLTV channels (`GET /epg/channels`, at most 50, typed text sent after a short pause, a late answer of an
   * older search dropped) and the hits, each a button that pins the channel (`PUT /channels/:id/epg`). The sheet stays open after a
   * change; every answer goes to the list through `changed`. The hit list reserves its room, so nothing jumps while a search runs.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { SourceView } from './api';
  import { failText, pinGuides, pinLine, PIN_Q_MAX, searchEpg, setEpgPin, startGuide, type AdminChannel, type EpgHit, type EpgPinBody } from './channels';
  import SheetFrame from './SheetFrame.svelte';

  export let channel: AdminChannel;
  export let sources: SourceView[];
  export let returnTo: (() => HTMLElement | null) | null = null;

  /** typed text is searched after this pause */
  const DEBOUNCE_MS = 250;
  const dispatch = createEventDispatcher<{ close: void; changed: AdminChannel }>();
  const id = uid('pin');
  let c = channel;
  $: key = `ltv-ch-pin:${c.id}`;
  $: busy = $busyKeys.has(key);
  $: guides = pinGuides(sources);
  $: guideOptions = guides.map((g) => ({ value: g.id, label: g.name }));
  let guide: string | null = null;
  // the sources may arrive after the sheet opened: the first guide is chosen once they are there
  $: if (guide === null && guides.length) { guide = startGuide(c, guides); void search(); }

  let q = '';
  let hits: EpgHit[] | null = null;
  let more = false;
  let failed = false;
  let seq = 0;
  let ctl: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;

  async function search() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const g = guide;
    if (!g || gone) return;
    const mine = ++seq;
    ctl?.abort();
    ctl = new AbortController();
    try {
      const r = await searchEpg(g, q, ctl.signal);
      if (mine !== seq || gone) return;
      hits = r.channels; more = r.more; failed = false;
    } catch (e) {
      if (mine !== seq || gone || (e instanceof DOMException && e.name === 'AbortError')) return;
      failed = true;
    }
  }
  function typed() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void search(), DEBOUNCE_MS);
  }
  function pickGuide(v: string) {
    guide = v || null;
    hits = null; more = false; failed = false;
    void search();
  }
  onDestroy(() => { gone = true; ctl?.abort(); if (timer) clearTimeout(timer); });

  /** the hit the channel is pinned to in the shown guide */
  $: pinnedId = c.epgPin && c.epgPin.sourceId === guide ? c.epgPin.xmlId : null;
  const title = (h: EpgHit) => h.names[0] ?? h.xmlId;

  async function send(body: EpgPinBody, done: string) {
    const r = await runAction({ key, run: () => setEpgPin(c.id, body), success: done, error: failText });
    if (!r.ok || !r.value) return;
    c = r.value;
    dispatch('changed', c);
  }
</script>

<SheetFrame title={tr('adminLive.ch.pin.title', { name: c.name })} {returnTo} on:close={() => dispatch('close')}>
  <div class="eff">
    <span class="lbl">{$t('adminLive.ch.pin.current')}</span>
    <p class="val" data-pin-state aria-live="polite">{pinLine(c)}</p>
    <!-- the warning line keeps its room: a change of state never moves the buttons below -->
    <div class="warn" data-guide-off={c.epgPin?.guideDisabled ? '' : undefined}>
      {#if c.epgPin?.guideDisabled}<StatusPill tone="warn" label={$t('adminLive.ch.pin.guideOff')} />{/if}
    </div>
  </div>

  <div class="foot">
    <Button variant="secondary" disabled={c.epgMatch === 'auto' || busy} on:click={() => send(null, tr('adminLive.ch.pin.autoDone'))}>{$t('adminLive.ch.pin.auto')}</Button>
    <Button variant="secondary" disabled={c.epgMatch === 'none' || busy} on:click={() => send({ none: true }, tr('adminLive.ch.pin.noneDone'))}>{$t('adminLive.ch.pin.none')}</Button>
  </div>

  {#if guides.length === 0}
    <p class="hint" data-no-guides>{$t('adminLive.ch.pin.noGuides')}</p>
  {:else}
    <Select id="{id}-g" label={$t('adminLive.ch.pin.guide')} value={guide ?? ''} options={guideOptions} on:change={(e) => pickGuide((e.target as HTMLSelectElement).value)} />
    <Field label={$t('adminLive.ch.pin.search')} type="search" placeholder={$t('adminLive.ch.pin.search')} maxlength={PIN_Q_MAX} autocomplete="off" bind:value={q} on:input={typed} />

    <section class="res" aria-labelledby="{id}-r" aria-busy={hits === null && !failed ? 'true' : undefined}>
      <h3 class="lbl" id="{id}-r">{$t('adminLive.ch.pin.results')}</h3>
      {#if failed}
        <div class="msg"><p>{$t('adminLive.ch.pin.loadFailed')}</p><Button variant="ghost" size="sm" icon="refresh" on:click={search}>{$t('ui.retry')}</Button></div>
      {:else if hits === null}
        <p class="sr-only" role="status">{$t('common.loading')}</p>
      {:else if hits.length === 0}
        <p class="msg" data-pin-empty>{$t('adminLive.ch.pin.empty')}</p>
      {:else}
        <ul class="hits" data-pin-hits>
          {#each hits as h (h.xmlId)}
            <li>
              <button type="button" class="hit" class:on={h.xmlId === pinnedId} aria-pressed={h.xmlId === pinnedId ? 'true' : 'false'} aria-label={tr('adminLive.ch.pin.choose', { name: title(h) })} disabled={busy}
                on:click={() => guide && send({ sourceId: guide, xmlId: h.xmlId }, tr('adminLive.ch.pin.pinned'))}>
                <span class="nm">{title(h)}</span>
                <span class="sub">{[h.xmlId, ...h.names.slice(1, 3)].join(' · ')}</span>
                {#if h.xmlId === pinnedId}<span class="chosen">{$t('adminLive.ch.pin.chosen')}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
        {#if more}<p class="hint" data-pin-more>{$t('adminLive.ch.pin.more')}</p>{/if}
      {/if}
    </section>
  {/if}
</SheetFrame>

<style>
  .lbl { display: block; margin: 0 0 .2rem; font-size: .85rem; font-weight: 700; color: rgba(255, 255, 255, .8); }
  .val { margin: 0; font-weight: 600; overflow-wrap: anywhere; min-height: 1.5em; }
  .warn { min-height: 28px; margin-top: .3rem; display: flex; align-items: center; }
  .foot { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
  .foot :global(.spinner) { width: 18px; height: 18px; }
  .hint { margin: 0; font-size: .9rem; color: rgba(255, 255, 255, .8); }
  /* the hit list keeps a few rows' room while the first answer is on its way, so the sheet does not jump */
  .res { min-height: calc(4 * 52px + 1.6rem); display: flex; flex-direction: column; gap: .3rem; }
  .msg { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; color: rgba(255, 255, 255, .85); }
  .msg p { margin: 0; }
  .hits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .hit { width: 100%; min-height: 48px; padding: .35rem .7rem; display: grid; grid-template-columns: 1fr auto; grid-template-areas: 'nm chosen' 'sub chosen'; align-items: center;
    gap: 0 .6rem; text-align: left; border-radius: 10px; background: rgba(255, 255, 255, .06); color: #fff; }
  .hit:hover:not(:disabled) { background: rgba(255, 255, 255, .12); }
  .hit.on { box-shadow: inset 0 0 0 2px var(--acc); }
  .hit:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
  .nm { grid-area: nm; font-weight: 600; overflow-wrap: anywhere; }
  .sub { grid-area: sub; font-size: .8rem; color: rgba(255, 255, 255, .7); overflow-wrap: anywhere; }
  .chosen { grid-area: chosen; font-size: .8rem; font-weight: 700; color: var(--acc); }
</style>
