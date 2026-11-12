<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Quelle hinzufügen* / *Quelle bearbeiten* (spec §9.1): a right-hand glass sheet (`sheetSlide`, the page dimmed behind). Adding
   * first asks the kind (*Anbieterliste* / *Eigene Streams*; own streams hand over to the stream sheet). A list has a name, the M3U
   * URL in a password-type field with *anzeigen* (on edit it starts empty, "unverändert lassen", with the stored `urlHint`), an
   * optional XMLTV URL (likewise; *Programmführer entfernen* sends `epgUrl: null`), *Heimnetz erlauben*, the interval, and under
   * *Erweitert* the user agent and the provider's channel limit. The *Import* section and the group picker are Task 22's: the
   * `import` slot below the form is kept empty for them. *Prüfen* runs `POST /sources/test` and shows "412 Sender in 18 Gruppen ·
   * EPG: 398 Kanäle" plus five sample names, or the error, in a box that keeps its height; *Speichern* waits for a good *Prüfen*
   * whenever the address, the LAN switch or the user agent changed (a new source always). A modal dialog: Tab stays inside, Escape
   * or a press on the dimmed page closes it (unsaved input asks first) and the focus goes back to `trigger`.
   */
  import { beforeNavigate, goto } from '$app/navigation';
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { ApiError } from '#lib/api';
  import { dialogKeys } from '#lib/actions';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import Select from '#lib/ui/Select.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { createSource, REFRESHES, testSource, updateSource, type Refresh, type SourceBody, type SourcePatch, type SourceTest, type SourceView } from './api';
  import { count, sourceError, urlShapeOk } from './sources';

  /** null = a new source */
  export let source: SourceView | null = null;
  /** the element the focus returns to on close */
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ close: void; saved: SourceView; own: void }>();
  const id = uid('ss');
  const HTTP = ['http:', 'https:'];
  let panel: HTMLDivElement | undefined;

  // ---- the form (an edit starts from the stored values; the URLs always start empty)
  let name = source?.name ?? '';
  let url = '', epgUrl = '', showUrl = false, epgRemove = false;
  let allowLan = source?.allowLan ?? false;
  let refresh: Refresh = source?.refresh ?? '24h';
  let userAgent = source?.userAgent ?? '';
  let maxStreams: string = source?.maxStreams != null ? String(source.maxStreams) : '';
  const start = JSON.stringify({ name, allowLan, refresh, userAgent, maxStreams });
  $: dirty = Boolean(url || epgUrl || epgRemove) || JSON.stringify({ name, allowLan, refresh, userAgent, maxStreams }) !== start;

  // ---- Prüfen: a result counts only for the inputs it was made with
  let test: SourceTest | null = null, testErr = '', testing = false, testedSig = '';
  $: sig = JSON.stringify([url.trim(), epgUrl.trim(), allowLan, userAgent.trim()]);
  $: fetchChanged = !source || Boolean(url.trim() || epgUrl.trim()) || allowLan !== source.allowLan || userAgent.trim() !== (source.userAgent ?? '');
  $: tested = Boolean(test) && testedSig === sig;
  $: needsTest = fetchChanged && !tested;

  let nameErr = '', urlErr = '', epgErr = '', maxErr = '', saveErr = '', saving = false;

  function validate(forTest: boolean): boolean {
    nameErr = !forTest && !name.trim() ? tr('adminLive.src.nameMissing') : '';
    urlErr = !source && !url.trim() ? tr('adminLive.src.urlMissing') : url.trim() && !urlShapeOk(url, HTTP) ? tr('adminLive.src.urlBad') : '';
    epgErr = epgUrl.trim() && !urlShapeOk(epgUrl, HTTP) ? tr('adminLive.src.urlBad') : '';
    const m = maxStreams.trim();
    maxErr = !forTest && m && !(/^\d+$/.test(m) && Number(m) >= 1 && Number(m) <= 50) ? '1–50' : '';
    return !nameErr && !urlErr && !epgErr && !maxErr;
  }

  const code = (e: unknown): string | null => (e instanceof ApiError && typeof e.body?.error === 'string' ? e.body.error : null);

  async function runTest() {
    if (testing || !validate(true)) return;
    testing = true; testErr = '';
    const mySig = sig;
    try {
      test = await testSource({
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(epgUrl.trim() ? { epgUrl: epgUrl.trim() } : {}),
        ...(userAgent.trim() ? { userAgent: userAgent.trim() } : {}),
        allowLan,
        ...(source ? { sourceId: source.id } : {}),
      });
      testedSig = mySig;
    } catch (e) {
      test = null; testedSig = '';
      // 400 names the field (`invalid`: not a URL / wrong scheme; `refused`: a single-label host or an internal address)
      const c = code(e), field = e instanceof ApiError && e.status === 400 ? e.body?.field : null;
      const text = c === 'invalid' ? tr('adminLive.src.urlBad') : sourceError(c ?? 'unreachable');
      if (field === 'url') urlErr = text; else if (field === 'epgUrl') epgErr = text; else testErr = text;
    } finally { testing = false; }
  }

  function patchOf(s: SourceView): SourcePatch {
    const p: SourcePatch = {};
    if (name.trim() !== s.name) p.name = name.trim();
    if (url.trim()) p.url = url.trim();
    if (epgRemove) p.epgUrl = null; else if (epgUrl.trim()) p.epgUrl = epgUrl.trim();
    if (allowLan !== s.allowLan) p.allowLan = allowLan;
    if (refresh !== s.refresh) p.refresh = refresh;
    if (userAgent.trim() !== (s.userAgent ?? '')) p.userAgent = userAgent.trim() || null;
    const max = maxStreams.trim() ? Number(maxStreams) : null;
    if (max !== s.maxStreams) p.maxStreams = max;
    return p;
  }
  function bodyOf(): SourceBody {
    return {
      name: name.trim(), url: url.trim(), ...(epgUrl.trim() ? { epgUrl: epgUrl.trim() } : {}), userAgent: userAgent.trim() || null,
      allowLan, refresh, skipGroups: [], numbering: 'chno', numberBase: 1, logoPref: 'm3u', epgShiftMin: 0,
      maxStreams: maxStreams.trim() ? Number(maxStreams) : null, enabled: true,
    };
  }

  async function save() {
    if (saving || needsTest || !validate(false)) return;
    saving = true; saveErr = '';
    try {
      const v = source ? await updateSource(source.id, patchOf(source)) : await createSource(bodyOf());
      done = true;
      dispatch('saved', v);
      close(true);
    } catch (e) {
      const c = code(e), field = e instanceof ApiError ? e.body?.field : null;
      const text = c === 'invalid' ? tr('adminLive.src.urlBad') : c ? sourceError(c) : sourceError('unreachable');
      if (field === 'url') urlErr = text; else if (field === 'epgUrl') epgErr = text; else if (field === 'name') nameErr = tr('adminLive.src.nameMissing'); else saveErr = text;
    } finally { saving = false; }
  }

  // ---- closing: unsaved input asks first
  let done = false;
  async function close(force = false) {
    if (!force && dirty && !done) {
      const ok = await confirm({ title: tr('adminLive.src.discardTitle'), body: tr('adminLive.src.discardBody'), danger: true, confirmLabel: tr('adminLive.src.discard') });
      if (!ok) return;
    }
    done = true;
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  beforeNavigate((nav) => {
    if (done || !dirty) return;
    nav.cancel();
    if (nav.willUnload || !nav.to) return;
    const to = nav.to.url;
    void confirm({ title: tr('adminLive.src.discardTitle'), body: tr('adminLive.src.discardBody'), danger: true, confirmLabel: tr('adminLive.src.discard') })
      .then((ok) => { if (ok) { done = true; void goto(to); } });
  });

  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, side: 'right' }));
  onMount(() => { document.getElementById(`${id}-name`)?.focus({ preventScroll: true }); });

  // ---- the kind (a new source only): own streams have their own sheet
  let kindBtns: HTMLButtonElement[] = [];
  function kindKey(e: KeyboardEvent) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    kindBtns[1]?.focus();
    dispatch('own');
  }

  $: intervals = REFRESHES.map((r) => ({ value: r, label: $t(`adminLive.src.interval.${r}`) }));
  $: testLine = test ? $t('adminLive.src.testResult', { n: count(test.channels), g: count(test.groups.length) }) + (test.epgChannels !== null ? ` · ${$t('adminLive.src.testEpg', { n: count(test.epgChannels) })}` : '') : '';
  /** the list came back but its guide failed: said under the result, the list can still be saved */
  $: epgFail = test?.epgError ? $t('adminLive.src.stateEpgErr', { err: sourceError(test.epgError) }) : '';
</script>

<div class="ss-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={() => close()} transition:scrimFade|global></div>
  <div class="ss frost frost-safe frost-sheet" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close: () => close() }} transition:slide|global>
    <header>
      <h2 id="{id}-t">{source ? $t('adminLive.src.edit') : $t('adminLive.src.add')}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={() => close()}><Icon name="x" size={20} /></button>
    </header>
    <form class="body" novalidate on:submit|preventDefault={save}>
      {#if !source}
        <div class="ctl" role="group" aria-labelledby="{id}-k">
          <span class="lbl" id="{id}-k">{$t('adminLive.src.kind')}</span>
          <div class="seg" role="radiogroup" aria-labelledby="{id}-k">
            <button type="button" role="radio" aria-checked="true" tabindex="0" class="on" bind:this={kindBtns[0]} on:keydown={kindKey}>{$t('adminLive.src.kindList')}</button>
            <button type="button" role="radio" aria-checked="false" tabindex="-1" bind:this={kindBtns[1]} on:click={() => dispatch('own')}>{$t('adminLive.src.kindOwn')}</button>
          </div>
        </div>
      {/if}

      <Field label={$t('adminLive.src.name')} id="{id}-name" bind:value={name} maxlength={60} required error={nameErr} />

      <Field label={$t('adminLive.src.m3u')} id="{id}-url" required={!source} error={urlErr} hint={source?.urlHint ? $t('adminLive.src.current', { hint: source.urlHint }) : ''} let:describedby let:invalid>
        <div class="secret">
          <input id="{id}-url" type={showUrl ? 'text' : 'password'} bind:value={url} maxlength={2048} autocomplete="off" spellcheck="false"
            placeholder={source ? $t('adminLive.src.unchanged') : 'https://iptv.example.com/…'} aria-describedby={describedby} aria-invalid={invalid} />
          <button type="button" class="eye" aria-pressed={showUrl} on:click={() => (showUrl = !showUrl)}>
            <Icon name={showUrl ? 'eye-off' : 'eye'} size={18} /><span>{showUrl ? $t('adminLive.src.hide') : $t('adminLive.src.show')}</span>
          </button>
        </div>
      </Field>

      <div class="epg">
        <Field label={$t('adminLive.src.epg')} id="{id}-epg" error={epgErr}
          hint={epgRemove ? $t('adminLive.src.epgRemoved') : source?.epgHint ? $t('adminLive.src.current', { hint: source.epgHint }) : $t('adminLive.src.optional')} let:describedby let:invalid>
          <input id="{id}-epg" type="url" bind:value={epgUrl} maxlength={2048} autocomplete="off" spellcheck="false" disabled={epgRemove}
            placeholder={source?.epgHint ? $t('adminLive.src.unchanged') : ''} aria-describedby={describedby} aria-invalid={invalid} />
        </Field>
        {#if source?.epgHint}
          <Button variant="ghost" size="sm" icon={epgRemove ? 'refresh' : 'x'} on:click={() => { epgRemove = !epgRemove; if (epgRemove) epgUrl = ''; }}>{epgRemove ? $t('adminLive.src.epgKeep') : $t('adminLive.src.epgRemove')}</Button>
        {/if}
      </div>

      <Toggle label={$t('adminLive.src.lan')} hint={$t('adminLive.src.lanHint')} bind:checked={allowLan} />
      <Select label={$t('adminLive.src.interval.label')} bind:value={refresh} options={intervals} />

      <details class="adv">
        <summary><Icon name="chevron-down" size={18} /><span>{$t('adminLive.src.advanced')}</span></summary>
        <div class="adv-body">
          <Field label={$t('adminLive.src.userAgent')} bind:value={userAgent} maxlength={200} hint={$t('adminLive.src.userAgentHint')} />
          <Field label={$t('adminLive.src.maxStreams')} type="number" bind:value={maxStreams} min={1} max={50} width="8rem" error={maxErr} hint={$t('adminLive.src.maxStreamsHint')} />
        </div>
      </details>

      <!-- Task 22: the Import section (numbers, logos, EPG shift) and the group picker after Prüfen go here -->
      <slot name="import" {test} />

      <!-- the Prüfen outcome keeps its box, so the buttons below never move -->
      <div class="result" aria-live="polite">
        {#if testErr}
          <p class="msg err" role="alert"><Icon name="alert" size={18} /><span>{testErr}</span></p>
        {:else if test && tested}
          <p class="msg ok" data-test-result><Icon name="check" size={18} /><span>{testLine}</span></p>
          {#if epgFail}<p class="msg epgerr" data-test-epg-error><Icon name="alert" size={18} /><span>{epgFail}</span></p>{/if}
          {#if test.samples.length}<p class="samples">{$t('adminLive.src.samples', { names: test.samples.slice(0, 5).join(', ') })}</p>{/if}
        {:else if needsTest}
          <p class="msg muted"><Icon name="info" size={18} /><span>{$t('adminLive.src.testFirst')}</span></p>
        {/if}
        {#if saveErr}<p class="msg err" role="alert"><Icon name="alert" size={18} /><span>{saveErr}</span></p>{/if}
      </div>

      <div class="foot">
        <Button variant="secondary" icon="search" pending={testing} on:click={runTest}>{$t('adminLive.src.test')}</Button>
        <Button type="submit" icon="check" pending={saving} disabled={needsTest}>{$t('adminLive.src.save')}</Button>
        <Button variant="ghost" on:click={() => close()}>{$t('adminLive.src.cancel')}</Button>
      </div>
    </form>
  </div>
</div>

<style>
  .ss-wrap { position: fixed; inset: 0; z-index: 90; }
  .ss { position: absolute; top: 0; right: 0; bottom: 0; box-sizing: border-box; width: min(480px, 100%); display: flex; flex-direction: column; outline: none; color: #fff;
    border-right: 0; border-radius: var(--fr-r-sheet) 0 0 var(--fr-r-sheet); padding: 14px 0 0; }
  header { flex: none; display: flex; align-items: center; gap: .5rem; padding: 0 18px .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; overflow-wrap: anywhere; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: .4rem 18px calc(18px + var(--safe-bottom, 0px)); display: flex; flex-direction: column; gap: 1rem; }
  .lbl { display: block; font-size: .9rem; font-weight: 600; margin-bottom: .35rem; }
  .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid rgba(255, 255, 255, .2); border-radius: 22px; padding: 3px; gap: 3px; max-width: 100%; }
  .seg button { min-height: 44px; padding: .3rem 1rem; border-radius: 999px; background: transparent; border: 0; color: rgba(255, 255, 255, .8); font-weight: 600; }
  .seg button.on { background: #fff; color: #101418; }
  .seg button:not(.on):hover { color: #fff; }
  .secret { display: flex; gap: .5rem; min-width: 0; }
  .secret input { flex: 1; min-width: 0; }
  .eye { flex: none; min-height: 44px; min-width: 44px; display: inline-flex; align-items: center; gap: .35rem; padding: 0 .8rem; border-radius: 12px; background: rgba(255, 255, 255, .08); color: #fff; border: 1px solid rgba(255, 255, 255, .2); font-weight: 600; }
  .epg { display: flex; flex-direction: column; gap: .3rem; align-items: flex-start; }
  .epg > :global(.field) { width: 100%; }
  .adv { border-top: 1px solid rgba(255, 255, 255, .12); padding-top: .4rem; }
  .adv summary { list-style: none; display: flex; align-items: center; gap: .4rem; min-height: 44px; cursor: pointer; font-weight: 600; }
  .adv summary::-webkit-details-marker { display: none; }
  .adv summary :global(svg) { transition: transform var(--t-fast, .15s); }
  .adv[open] summary :global(svg) { transform: rotate(180deg); }
  .adv-body { display: flex; flex-direction: column; gap: 1rem; padding: .4rem 0 .2rem; }
  /* the Prüfen box holds four lines whatever it shows (result, guide error, samples) */
  .result { min-height: 6.4rem; display: flex; flex-direction: column; gap: .3rem; }
  .msg { display: flex; gap: .45rem; align-items: flex-start; margin: 0; overflow-wrap: anywhere; min-width: 0; }
  .msg :global(svg) { flex: none; margin-top: .15rem; }
  .msg.ok { font-weight: 600; }
  .msg.err :global(svg), .msg.epgerr :global(svg) { color: var(--err); }
  .msg.muted { color: rgba(255, 255, 255, .85); font-size: .9rem; }
  .samples { margin: 0; font-size: .88rem; color: rgba(255, 255, 255, .85); overflow-wrap: anywhere; }
  .foot { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
  /* a pending button's spinner takes its icon's 18 px: the buttons keep their width */
  .foot :global(.spinner) { width: 18px; height: 18px; }
  :global(html.m-still) .ss-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .ss-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
