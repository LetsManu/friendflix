<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Programmführer hinzufügen* / *Programmführer bearbeiten* (extra-guides spec, Admin UI): the right-hand glass sheet of an extra
   * guide. Adding shows the kind choice with *Programmführer* ticked (*Anbieterliste* / *Eigene Streams* hand over to their sheets, as
   * the list sheet does). Fields: name, the XMLTV link (password-type with *anzeigen*; on edit empty = unchanged, the stored `epgHint`
   * as hint), *Heimnetz erlauben* and the user agent (adding only: the guide PATCH does not take them), the interval, the programme-time
   * offset, and **Gilt für**: *Alle Sender* or *Nur diese Quellen* with a checklist of the lists and *Eigene Streams* (at least one
   * ticked). The checklist is always there (disabled for *Alle Sender*), so choosing never moves the form. *Prüfen* runs `POST
   * /sources/test` with `kind: 'guide'` and shows "{n} Sender im Programmführer" and up to eight names in a box that keeps its height;
   * *Speichern* waits for a good *Prüfen* whenever the link (or, adding, the LAN switch / user agent) changed. Closing with unsaved input
   * asks first; the focus goes back to `trigger`.
   *
   * Stage 2: a new guide chooses *Link* / *Datei*. *Datei* has a file picker (`.xml,.xml.gz,.gz`) with the chosen name and size, no link,
   * no interval and no *Prüfen*; *Speichern* creates the guide, then PUTs the file (an indeterminate bar in a reserved line: fetch has no
   * upload progress). A failed upload keeps the created guide: the sheet stays, the next *Speichern* only uploads again. Editing a file
   * guide can pick a new file too.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { ApiError } from '#lib/api';
  import { dialogKeys } from '#lib/actions';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import Select from '#lib/ui/Select.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { createFileGuide, createGuide, REFRESHES, testGuide, updateGuide, uploadGuideFile, type GuidePatch, type GuideTest, type Refresh, type SourceView } from './api';
  import { confirmDiscard, guardLeave } from './discard';
  import { SHIFT_MAX, SHIFT_MIN, shiftLabel, stepShift } from './picker';
  import SecretInput from './SecretInput.svelte';
  import { fileFailText, fileLine, GUIDE_FILE_MAX, isFileGuide, scopeOptions, sourceFailText, urlShapeOk } from './sources';
  import { fmtBytes } from '#lib/ui/format';

  /** null = a new guide */
  export let source: SourceView | null = null;
  /** every source of the page: *Gilt für* lists the lists and the own streams */
  export let sources: SourceView[] = [];
  export let trigger: HTMLElement | null = null;
  /** opened by *Aktivieren* on a guide left without a scope: saving the new scope turns it on too */
  export let enable = false;

  const dispatch = createEventDispatcher<{ close: void; saved: SourceView; list: void; own: void; created: SourceView; uploaded: SourceView }>();
  const id = uid('gs');
  const HTTP = ['http:', 'https:'];
  const SAMPLES = 8;

  let name = source?.name ?? '';
  let epgUrl = '';
  /** where a new guide comes from; an existing one keeps its provider */
  let mode: 'link' | 'file' = source && isFileGuide(source) ? 'file' : 'link';
  $: isFile = mode === 'file';
  let file: File | null = null, fileInput: HTMLInputElement | undefined, fileErr = '', uploading = false;
  /** the guide a failed upload left behind: the next save uploads again instead of creating a second one */
  let made: SourceView | null = null;
  let allowLan = source?.allowLan ?? false;
  let userAgent = source?.userAgent ?? '';
  let refresh: Refresh = source?.refresh ?? '24h';
  let epgShiftMin = source?.epgShiftMin ?? 0;
  const options = scopeOptions(sources);
  let scopeAll = !source || source.guideScope === null;
  /** the ticked sources (kept while *Alle Sender* is chosen, so switching back loses nothing) */
  let picked = new Set((source?.guideScope ?? []).filter((x) => options.some((o) => o.id === x)));
  $: scope = scopeAll ? null : options.filter((o) => picked.has(o.id)).map((o) => o.id);
  const scopeKey = (s: string[] | null) => (s === null ? '*' : [...s].sort().join(','));
  const start = JSON.stringify({ name, allowLan, userAgent, refresh, epgShiftMin, scope: scopeKey(source ? source.guideScope : null) });
  $: dirty = Boolean(epgUrl) || Boolean(file) || JSON.stringify({ name, allowLan, userAgent, refresh, epgShiftMin, scope: scopeKey(scope) }) !== start;

  // ---- Prüfen: a result counts only for the inputs it was made with
  let test: GuideTest | null = null, testErr = '', testing = false, testedSig = '';
  $: sig = JSON.stringify([epgUrl.trim(), allowLan, userAgent.trim()]);
  $: fetchChanged = !isFile && (!source || Boolean(epgUrl.trim()));
  $: tested = Boolean(test) && testedSig === sig;
  $: needsTest = fetchChanged && !tested;

  let nameErr = '', urlErr = '', scopeErr = '', saveErr = '', saving = false;
  function validate(forTest: boolean): boolean {
    nameErr = !forTest && !name.trim() ? tr('adminLive.src.nameMissing') : '';
    urlErr = isFile ? '' : !source && !epgUrl.trim() ? tr('adminLive.src.guide.urlMissing') : epgUrl.trim() && !urlShapeOk(epgUrl, HTTP) ? tr('adminLive.src.urlBad') : '';
    scopeErr = !forTest && scope !== null && scope.length === 0 ? tr('adminLive.src.guide.scopeMissing') : '';
    const noFile = !forTest && isFile && !file && !source?.fileName && !made;
    if (!forTest) fileErr = noFile ? tr('adminLive.src.guide.fileMissing') : '';
    return !nameErr && !urlErr && !scopeErr && !noFile;
  }
  $: if (scopeErr && (scope === null || scope.length > 0)) scopeErr = '';

  const code = (e: unknown): string | null => (e instanceof ApiError && typeof e.body?.error === 'string' ? e.body.error : null);
  const fieldOf = (e: unknown): unknown => (e instanceof ApiError && e.status === 400 ? e.body?.field : null);

  async function runTest() {
    if (testing || !validate(true)) return;
    testing = true; testErr = '';
    const mySig = sig;
    try {
      test = await testGuide({
        kind: 'guide',
        ...(epgUrl.trim() ? { epgUrl: epgUrl.trim() } : {}),
        ...(userAgent.trim() ? { userAgent: userAgent.trim() } : {}),
        allowLan,
        ...(source ? { sourceId: source.id } : {}),
      });
      testedSig = mySig;
    } catch (e) {
      const text = code(e) === 'test_running' ? tr('adminLive.src.testRunning') : sourceFailText(e);
      if (fieldOf(e) === 'epgUrl') urlErr = text; else testErr = text;
    } finally { testing = false; }
  }

  function patchOf(s: SourceView): GuidePatch {
    const p: GuidePatch = {};
    if (name.trim() !== s.name) p.name = name.trim();
    // a file guide has no link and no interval (the backend refuses both)
    if (!isFile && epgUrl.trim()) p.epgUrl = epgUrl.trim();
    if (!isFile && refresh !== s.refresh) p.refresh = refresh;
    if (epgShiftMin !== s.epgShiftMin) p.epgShiftMin = epgShiftMin;
    if (scopeKey(scope) !== scopeKey(s.guideScope)) p.guideScope = scope;
    if (enable && !s.enabled) p.enabled = true;
    return p;
  }

  function pickFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
    if (!f) return;
    file = f;
    fileErr = f.size > GUIDE_FILE_MAX ? tr('adminLive.src.guide.tooLarge') : '';
  }

  async function save() {
    if (saving || needsTest || !validate(false)) return;
    if (isFile && file && file.size > GUIDE_FILE_MAX) { fileErr = tr('adminLive.src.guide.tooLarge'); return; }
    saving = true; saveErr = ''; fileErr = '';
    try {
      let v: SourceView;
      if (made) v = made;
      else if (source) v = await updateGuide(source.id, patchOf(source));
      else if (isFile) v = await createFileGuide({ kind: 'guide', guideProvider: 'xmltv_file', name: name.trim(), guideScope: scope, epgShiftMin, enabled: true });
      else v = await createGuide({ kind: 'guide', name: name.trim(), epgUrl: epgUrl.trim(), userAgent: userAgent.trim() || null, allowLan, refresh, epgShiftMin, guideScope: scope, enabled: true });
      if (isFile && file) {
        made = v;
        dispatch('created', v);
        uploading = true;
        try { await uploadGuideFile(v.id, file); } finally { uploading = false; }
        // 202: the import runs on the server; the page follows the list and shows name, size and outcome when it is done
        dispatch('uploaded', v);
      }
      done = true;
      dispatch('saved', v);
      close(true);
    } catch (e) {
      if (made && isFile) { fileErr = fileFailText(e); saveErr = source ? '' : tr('adminLive.src.guide.fileLater'); }
      else {
        const field = e instanceof ApiError ? e.body?.field : null;
        const text = sourceFailText(e);
        if (field === 'epgUrl') urlErr = text; else if (field === 'name') nameErr = tr('adminLive.src.nameMissing'); else if (field === 'guideScope') scopeErr = text; else saveErr = text;
      }
    } finally { saving = false; }
  }

  // ---- closing: unsaved input asks first
  let done = false;
  async function mayLeave(): Promise<boolean> {
    if (done || !dirty) return true;
    return confirmDiscard();
  }
  async function close(force = false) {
    if (!force && !(await mayLeave())) return;
    done = true;
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  guardLeave(() => !done && dirty, () => { done = true; });

  // ---- the kind (a new source only): the list and own streams have their own sheets
  let kindBtns: HTMLButtonElement[] = [];
  async function toKind(k: 'list' | 'own') {
    if (!(await mayLeave())) { kindBtns[1]?.focus(); return; }
    done = true;
    dispatch(k);
  }
  function kindKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    kindBtns[d === 1 ? 2 : 0]?.focus();
    void toKind(d === 1 ? 'own' : 'list');
  }
  /** *Alle Sender* / *Nur diese Quellen*: a radio group (the arrow keys move the choice) */
  function scopeArrow(e: KeyboardEvent) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const group = e.currentTarget instanceof HTMLElement ? e.currentTarget.parentElement : null;
    scopeAll = !scopeAll;
    void tick().then(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  }
  function modeArrow(e: KeyboardEvent) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const group = e.currentTarget instanceof HTMLElement ? e.currentTarget.parentElement : null;
    mode = mode === 'file' ? 'link' : 'file';
    void tick().then(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  }
  function tickSource(sid: string, on: boolean) {
    const n = new Set(picked);
    if (on) n.add(sid); else n.delete(sid);
    picked = n;
  }

  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, side: 'right' }));
  onMount(() => { document.getElementById(`${id}-name`)?.focus({ preventScroll: true }); });

  $: intervals = REFRESHES.map((r) => ({ value: r, label: $t(`adminLive.src.interval.${r}`) }));
</script>

<div class="gs-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={() => close()} transition:scrimFade|global></div>
  <div class="gs frost frost-safe frost-sheet" role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close: () => close() }} transition:slide|global data-guide-sheet>
    <header>
      <h2 id="{id}-t">{source ? $t('adminLive.src.guide.edit') : $t('adminLive.src.guide.add')}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={() => close()}><Icon name="x" size={20} /></button>
    </header>
    <form class="frm" novalidate on:submit|preventDefault={save}>
     <div class="body">
      {#if !source}
        <div class="ctl" role="group" aria-labelledby="{id}-k">
          <span class="lbl" id="{id}-k">{$t('adminLive.src.kind')}</span>
          <div class="seg" role="radiogroup" aria-labelledby="{id}-k">
            <button type="button" role="radio" aria-checked="false" tabindex="-1" bind:this={kindBtns[0]} on:click={() => toKind('list')}>{$t('adminLive.src.kindList')}</button>
            <button type="button" role="radio" aria-checked="true" tabindex="0" class="on" bind:this={kindBtns[1]} on:keydown={kindKey}>{$t('adminLive.src.kindGuide')}</button>
            <button type="button" role="radio" aria-checked="false" tabindex="-1" bind:this={kindBtns[2]} on:click={() => toKind('own')}>{$t('adminLive.src.kindOwn')}</button>
          </div>
          <p class="help">{$t('adminLive.src.guide.fillHint')}</p>
        </div>
      {/if}

      {#if !source}
        <div class="ctl" role="group" aria-labelledby="{id}-m">
          <span class="lbl" id="{id}-m">{$t('adminLive.src.guide.from')}</span>
          <div class="seg" role="radiogroup" aria-labelledby="{id}-m">
            <button type="button" role="radio" aria-checked={!isFile} tabindex={isFile ? -1 : 0} class:on={!isFile} disabled={saving || Boolean(made)} on:click={() => (mode = 'link')} on:keydown={modeArrow}>{$t('adminLive.src.guide.fromLink')}</button>
            <button type="button" role="radio" aria-checked={isFile} tabindex={isFile ? 0 : -1} class:on={isFile} disabled={saving || Boolean(made)} on:click={() => (mode = 'file')} on:keydown={modeArrow}>{$t('adminLive.src.guide.fromFile')}</button>
          </div>
        </div>
      {/if}

      <Field label={$t('adminLive.src.name')} id="{id}-name" bind:value={name} maxlength={60} required error={nameErr} />

      {#if isFile}
        <div class="ctl file" role="group" aria-labelledby="{id}-f" data-file-pick>
          <span class="lbl" id="{id}-f">{$t('adminLive.src.guide.fromFile')}</span>
          <input type="file" class="pick" accept=".xml,.xml.gz,.gz" bind:this={fileInput} on:change={pickFile} tabindex="-1" aria-hidden="true" data-file-input />
          <div class="fbox">
            <Button variant="secondary" icon="arrow-up" disabled={saving || uploading} on:click={() => fileInput?.click()}>{file || source?.fileName ? $t('adminLive.src.guide.pickOther') : $t('adminLive.src.guide.pickFile')}</Button>
            <p class="fname" data-file-name>{#if file}{$t('adminLive.src.guide.fileLine', { name: file.name, size: fmtBytes(file.size) })}{:else if source}{fileLine(source)}{:else}{$t('adminLive.src.guide.noFile')}{/if}</p>
          </div>
          <p class="help">{$t('adminLive.src.guide.fileHint')}</p>
          <p class="ferr" role={fileErr ? 'alert' : undefined} data-file-error>{#if fileErr}<Icon name="alert" size={16} /><span>{fileErr}</span>{/if}</p>
        </div>
      {:else}
        <Field label={$t('adminLive.src.epg')} id="{id}-url" required={!source} error={urlErr} hint={source?.epgHint ? $t('adminLive.src.current', { hint: source.epgHint }) : ''} let:describedby let:invalid>
          <SecretInput id="{id}-url" bind:value={epgUrl} placeholder={source ? $t('adminLive.src.unchanged') : 'https://epg.example.com/…'} {describedby} {invalid} />
        </Field>

        {#if !source}<Toggle label={$t('adminLive.src.lan')} hint={$t('adminLive.src.lanHint')} bind:checked={allowLan} />{/if}
        <Select label={$t('adminLive.src.interval.label')} bind:value={refresh} options={intervals} />
      {/if}

      <div class="ctl" role="group" aria-labelledby="{id}-s">
        <span class="lbl" id="{id}-s">{$t('adminLive.src.epgShift')}</span>
        <div class="step">
          <button type="button" class="sb" aria-label={$t('adminLive.src.shiftLess')} title={$t('adminLive.src.shiftLess')} disabled={epgShiftMin <= SHIFT_MIN}
            on:click={() => (epgShiftMin = stepShift(epgShiftMin, -1))}><span aria-hidden="true">−</span></button>
          <output class="val" data-shift aria-live="polite">{shiftLabel(epgShiftMin)}</output>
          <button type="button" class="sb" aria-label={$t('adminLive.src.shiftMore')} title={$t('adminLive.src.shiftMore')} disabled={epgShiftMin >= SHIFT_MAX}
            on:click={() => (epgShiftMin = stepShift(epgShiftMin, 1))}><span aria-hidden="true">+</span></button>
        </div>
      </div>

      <section class="scope" aria-labelledby="{id}-g">
        <span class="lbl" id="{id}-g">{$t('adminLive.src.guide.scope')}</span>
        <div class="seg" role="radiogroup" aria-labelledby="{id}-g">
          <button type="button" role="radio" aria-checked={scopeAll} tabindex={scopeAll ? 0 : -1} class:on={scopeAll} on:click={() => (scopeAll = true)} on:keydown={scopeArrow}>{$t('adminLive.src.guide.scopeAll')}</button>
          <button type="button" role="radio" aria-checked={!scopeAll} tabindex={scopeAll ? -1 : 0} class:on={!scopeAll} on:click={() => (scopeAll = false)} on:keydown={scopeArrow}>{$t('adminLive.src.guide.scopeSome')}</button>
        </div>
        <!-- always there (disabled for Alle Sender) with a fixed height: choosing never moves what is below -->
        <div class="list" class:off={scopeAll} role="group" aria-label={$t('adminLive.src.guide.scopeSome')} aria-describedby="{id}-se" data-scope-list>
          {#each options as o (o.id)}
            <label class="row"><input type="checkbox" checked={picked.has(o.id)} disabled={scopeAll} on:change={(e) => tickSource(o.id, e.currentTarget.checked)} /><span>{o.name}</span></label>
          {:else}
            <p class="none">{$t('adminLive.src.guide.scopeEmpty')}</p>
          {/each}
        </div>
        <p class="serr" id="{id}-se" role={scopeErr ? 'alert' : undefined}>{#if scopeErr}<Icon name="alert" size={16} /><span>{scopeErr}</span>{/if}</p>
      </section>

      {#if !source && !isFile}
        <details class="adv">
          <summary><Icon name="chevron-down" size={18} /><span>{$t('adminLive.src.advanced')}</span></summary>
          <div class="adv-body">
            <Field label={$t('adminLive.src.userAgent')} bind:value={userAgent} maxlength={200} hint={$t('adminLive.src.userAgentHint')} />
          </div>
        </details>
      {/if}

      <!-- the Prüfen outcome keeps its box, so the buttons below never move -->
      <div class="result" aria-live="polite">
        {#if isFile}
          <!-- the upload line keeps its place whether it runs or not -->
          <div class="up" class:run={uploading} data-upload>
            <p class="msg muted">{#if uploading}<Icon name="arrow-up" size={18} /><span>{$t('adminLive.src.guide.uploading')}</span>{/if}</p>
            <div class="bar" role={uploading ? 'progressbar' : undefined} aria-label={uploading ? $t('adminLive.src.guide.uploading') : undefined} aria-busy={uploading}><i></i></div>
          </div>
        {:else if testErr}
          <p class="msg err" role="alert"><Icon name="alert" size={18} /><span>{testErr}</span></p>
        {:else if test && tested}
          <p class="msg ok" data-test-result><Icon name="check" size={18} /><span>{$t('adminLive.src.guide.testResult', { n: test.epgChannels })}</span></p>
          {#if test.samples.length}<p class="samples">{$t('adminLive.src.samples', { names: test.samples.slice(0, SAMPLES).join(', ') })}</p>{/if}
        {:else if needsTest}
          <p class="msg muted"><Icon name="info" size={18} /><span>{$t('adminLive.src.testFirst')}</span></p>
        {/if}
        {#if saveErr}<p class="msg err" role="alert"><Icon name="alert" size={18} /><span>{saveErr}</span></p>{/if}
      </div>
     </div>

      <div class="foot">
        {#if !isFile}<Button variant="secondary" icon="search" pending={testing} on:click={runTest}>{$t('adminLive.src.test')}</Button>{/if}
        <Button type="submit" icon="check" pending={saving} disabled={needsTest}>{$t('adminLive.src.save')}</Button>
        <Button variant="ghost" on:click={() => close()}>{$t('adminLive.src.cancel')}</Button>
      </div>
    </form>
  </div>
</div>

<style>
  .gs-wrap { position: fixed; inset: 0; z-index: 90; }
  .gs { position: absolute; top: 0; right: 0; bottom: 0; box-sizing: border-box; width: min(480px, 100%); display: flex; flex-direction: column; outline: none; color: #fff;
    border-right: 0; border-radius: var(--fr-r-sheet) 0 0 var(--fr-r-sheet); padding: 14px 0 0; }
  header { flex: none; display: flex; align-items: center; gap: .5rem; padding: 0 18px .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; overflow-wrap: anywhere; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .frm { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: .4rem 18px 1rem; display: flex; flex-direction: column; gap: 1rem; }
  .ctl { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
  .lbl { display: block; font-size: .9rem; font-weight: 600; margin-bottom: .35rem; }
  .help { margin: .4rem 0 0; font-size: .85rem; color: rgba(255, 255, 255, .85); overflow-wrap: anywhere; }
  .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid rgba(255, 255, 255, .2); border-radius: 22px; padding: 3px; gap: 3px; max-width: 100%; box-sizing: border-box; }
  .seg button { min-height: 44px; padding: .3rem 1rem; border-radius: 999px; background: transparent; border: 0; color: rgba(255, 255, 255, .8); font-weight: 600; }
  .seg button.on { background: #fff; color: #101418; }
  .seg button:not(.on):hover { color: #fff; }
  .step { display: inline-flex; align-items: center; gap: .3rem; border: 1px solid rgba(255, 255, 255, .2); border-radius: 22px; padding: 3px; }
  .sb { width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; border: 0; color: #fff; font-size: 1.4rem; font-weight: 700; line-height: 1; }
  .sb:hover:not(:disabled) { background: rgba(255, 255, 255, .12); }
  .sb:disabled { opacity: .4; }
  .val { min-width: 5.5rem; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
  .scope { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; min-width: 0; }
  .list { box-sizing: border-box; width: 100%; height: 10rem; overflow-y: auto; overscroll-behavior: contain; border: 1px solid rgba(255, 255, 255, .2); border-radius: 12px; padding: 4px 10px;
    transition: opacity var(--t-fast, .15s); }
  .list.off { opacity: .5; }
  .row { display: flex; align-items: center; gap: .7rem; min-height: 44px; cursor: pointer; min-width: 0; }
  .row span { min-width: 0; overflow-wrap: anywhere; }
  .list.off .row { cursor: default; }
  .none { margin: .8rem 0; color: rgba(255, 255, 255, .85); }
  /* one line is reserved for the "at least one" error */
  .serr { display: flex; gap: .35rem; align-items: flex-start; margin: 0; min-height: 1.4em; font-size: .88rem; font-weight: 600; overflow-wrap: anywhere; }
  .serr :global(svg) { flex: none; margin-top: .15rem; color: var(--err); }
  .pick { display: none; }
  .fbox { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .9rem; min-width: 0; max-width: 100%; }
  .fname { margin: 0; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
  .ferr { display: flex; gap: .35rem; align-items: flex-start; margin: .3rem 0 0; min-height: 1.4em; font-size: .88rem; font-weight: 600; overflow-wrap: anywhere; }
  .ferr :global(svg) { flex: none; margin-top: .15rem; color: var(--err); }
  .up { display: flex; flex-direction: column; gap: .4rem; min-height: 2.6rem; }
  .up .msg { min-height: 1.4em; }
  .bar { position: relative; height: 6px; border-radius: 3px; overflow: hidden; background: rgba(255, 255, 255, .12); opacity: 0; }
  .up.run .bar { opacity: 1; }
  .bar i { position: absolute; inset: 0; width: 40%; border-radius: 3px; background: #fff; transform: translateX(-100%); }
  .up.run .bar i { animation: gs-indet 1.2s ease-in-out infinite; }
  @keyframes gs-indet { to { transform: translateX(250%); } }
  .adv { border-top: 1px solid rgba(255, 255, 255, .12); padding-top: .4rem; }
  .adv summary { list-style: none; display: flex; align-items: center; gap: .4rem; min-height: 44px; cursor: pointer; font-weight: 600; }
  .adv summary::-webkit-details-marker { display: none; }
  .adv summary :global(svg) { transition: transform var(--t-fast, .15s); }
  .adv[open] summary :global(svg) { transform: rotate(180deg); }
  .adv-body { display: flex; flex-direction: column; gap: 1rem; padding: .4rem 0 .2rem; }
  /* the Prüfen box holds its lines whatever it shows (result, samples, error) */
  .result { min-height: 6.4rem; display: flex; flex-direction: column; gap: .3rem; }
  .msg { display: flex; gap: .45rem; align-items: flex-start; margin: 0; overflow-wrap: anywhere; min-width: 0; }
  .msg :global(svg) { flex: none; margin-top: .15rem; }
  .msg.ok { font-weight: 600; }
  .msg.err :global(svg) { color: var(--err); }
  .msg.muted { color: rgba(255, 255, 255, .85); font-size: .9rem; }
  .samples { margin: 0; font-size: .88rem; color: rgba(255, 255, 255, .85); overflow-wrap: anywhere; }
  .foot { flex: none; display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; padding: .7rem 18px calc(14px + var(--safe-bottom, 0px)); border-top: 1px solid rgba(255, 255, 255, .12); }
  .foot :global(.spinner) { width: 18px; height: 18px; }
  :global(html.m-still) .gs-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .gs-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
