<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Branding (branding spec; stage A Task 4): the tabs Identität, Logo & Symbol and Farben & Stimmung (Texte, Rechtliches & Hilfe
   * and Teilen & E-Mails come with stage B) beside a live preview (Desktop, Telefon, TV, Anmeldung) of the staged values.
   * - Edits are staged (lib/admin/branding/model.ts). A field's message shows once the field was left (blur) or a save was tried, and
   *   then follows the typing; never on the first keystroke. The save bar (the rights' SaveBar) saves only the changed fields with the
   *   rev the page loaded (`PUT /api/admin/brand`). A field error opens its tab and focuses the field instead. While a save runs the
   *   form and the reset are disabled, so no edit is made that the answer would overwrite.
   * - A 409 `brand_conflict` (another admin saved meanwhile) loads the newer brand, keeps this admin's edits on top of it and says so in
   *   the bar (or that nothing is left to save, or that the newer brand could not be loaded); a 400 `invalid` names its field (an image
   *   swept before the save: upload it again) and focuses it (the image row's *Hochladen*, a choice's chosen segment).
   * - Uploads are prepared in the browser (imageResize.ts: the symbol cropped to 512 × 512, the others fitted; re-encoded, so a JPEG is
   *   sent as PNG), uploaded at once (`PUT /api/admin/brand/image/:kind`) and their hash is staged; the save sets them.
   * - After a save or a reset the page's own brand reloads (lib/brand.ts loadBrand), so this tab shows it at once.
   * - *Auf Standard zurücksetzen* asks first, then `POST /api/admin/brand/reset` with the rev. Leaving the page with edits asks too.
   * Nothing jumps: every message line keeps its room (two lines under a text field, clamped, the whole text in `title` and read through
   * aria-describedby), the two-column fields follow the form column's width (a container query), the preview frame has a fixed size,
   * the page end keeps the save bar's room.
   */
  import { onMount, tick } from 'svelte';
  import { api, apiCode, ApiError } from '#lib/api';
  import { loadBrand, DEFAULT_BRAND, type BrandGlow, type BrandHeader, type BrandSignInBg, type PublicBrand } from '#lib/brand';
  import { t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { leaveGuard, leavesRoute } from '#lib/admin/leaveGuard';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import SaveBar from '#lib/admin/rights/SaveBar.svelte';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { toast } from '#lib/ui/toast';
  import ImageField from '#lib/admin/branding/ImageField.svelte';
  import Mark from '#lib/admin/branding/Mark.svelte';
  import Preview, { PREVIEW_VIEWS, type PreviewView } from '#lib/admin/branding/Preview.svelte';
  import Seg from '#lib/admin/branding/Seg.svelte';
  import Swatches from '#lib/admin/branding/Swatches.svelte';
  import { prepareImage, type BrandImageKind } from '#lib/admin/branding/imageResize';
  import {
    BRAND_TABS, FIELD_TAB, LIMITS, charCount, dirtyTabs, fieldError, firstError, normalizeAccent, previewBrand, previewVars, serverFieldError, stagedDiff,
    uploadErrorText, validate, type BrandTab, type FieldKey, type ImageField as ImageFieldKey, type ImageUrls,
  } from '#lib/admin/branding/model';

  interface AdminAnswer { rev: number; brand: PublicBrand; images: { logo?: string; symbol?: string; signIn?: string }; updatedAt: string | null }

  let saved: PublicBrand = { ...DEFAULT_BRAND };
  let staged: PublicBrand = { ...DEFAULT_BRAND };
  let rev = 0;
  let loaded = false, loadFailed = false;
  let urls: ImageUrls = {};
  /** the server's word on a field (400 invalid), until that field is edited */
  let serverErrors: Partial<Record<FieldKey, string>> = {};
  let tab: BrandTab = 'identity';
  let view: PreviewView = 'desktop';
  let saving = false, barError: string | null = null;
  /** the fields whose message shows (left once, or every field after a save was tried) */
  let shown = new Set<FieldKey>();
  let attempted = false;
  let lastAccent = DEFAULT_BRAND.accent;
  /** per upload: working, its note, or its error */
  let uploads: Partial<Record<BrandImageKind, { busy: boolean; text: string; error: boolean }>> = {};

  const KINDS: Record<ImageFieldKey, BrandImageKind> = { logo: 'logo', symbol: 'symbol', signInImage: 'signIn' };
  const fields = (b: PublicBrand): PublicBrand => ({
    name: b.name, byline: b.byline, shortName: b.shortName, website: b.website, about: b.about, header: b.header, accent: b.accent, glow: b.glow,
    signInBg: b.signInBg, logo: b.logo, symbol: b.symbol, signInImage: b.signInImage,
  });

  $: { const n = normalizeAccent(staged.accent); if (n) lastAccent = n; }
  $: diff = stagedDiff(saved, staged);
  $: count = Object.keys(diff).length;
  $: dirty = dirtyTabs(diff);
  $: local = validate(staged);
  $: errors = { ...visible(local, shown, attempted), ...serverErrors } as Partial<Record<FieldKey, string>>;
  $: pb = previewBrand(staged, urls, lastAccent);
  $: barText = $t('admin.branding.saveBar', { n: count });

  leaveGuard((nav) => leavesRoute(nav) && count > 0, () => ({
    title: tr('admin.branding.leave.title'), body: tr('admin.branding.leave.body'), danger: true, confirmLabel: tr('admin.branding.leave.confirm'),
  }));

  /** the local errors the admin is shown: a field's once it was left, all of them once a save was tried */
  function visible(e: Partial<Record<FieldKey, string>>, sh: Set<FieldKey>, all: boolean): Partial<Record<FieldKey, string>> {
    return all ? e : Object.fromEntries(Object.entries(e).filter(([k]) => sh.has(k as FieldKey)));
  }
  const leave = (k: FieldKey) => { if (!shown.has(k)) shown = new Set([...shown, k]); };

  /** the answer's images by field (the URLs carry the stored type's extension) */
  function take(a: AdminAnswer, keepEdits: Partial<PublicBrand> | null) {
    const before = { ...urls };
    urls = { ...before, ...(a.images.logo ? { logo: a.images.logo } : {}), ...(a.images.symbol ? { symbol: a.images.symbol } : {}), ...(a.images.signIn ? { signInImage: a.images.signIn } : {}) };
    saved = fields(a.brand);
    rev = a.rev;
    staged = { ...saved, ...(keepEdits ?? {}) };
  }

  async function load(keepEdits: Partial<PublicBrand> | null = null): Promise<boolean> {
    try {
      take(await api<AdminAnswer>('/api/admin/brand'), keepEdits);
      loaded = true;
      loadFailed = false;
      return true;
    } catch {
      if (!loaded) loadFailed = true;
      return false;
    }
  }
  onMount(() => { void load(); });

  function set<K extends FieldKey>(k: K, v: PublicBrand[K]) {
    staged = { ...staged, [k]: v };
    if (serverErrors[k]) { const { [k]: _gone, ...rest } = serverErrors; serverErrors = rest; }
    if (barError && !saving) barError = null;
  }
  const textValue = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;

  // ---- tabs (roving tabindex, arrows / Home / End; the focus follows the choice) ----
  function tabKey(e: KeyboardEvent, list: readonly string[], cur: string, pick: (v: string) => void, prefix: string) {
    const i = list.indexOf(cur), last = list.length - 1;
    const n = e.key === 'ArrowRight' ? (i + 1) % list.length : e.key === 'ArrowLeft' ? (i + last) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (n < 0) return;
    e.preventDefault();
    pick(list[n]!);
    void tick().then(() => { const el = document.getElementById(`${prefix}${list[n]!}`); el?.focus(); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  }
  const selectTab = (v: string) => { tab = v as BrandTab; };
  const selectView = (v: string) => { view = v as PreviewView; };
  function showTab(v: BrandTab, el: HTMLElement) { tab = v; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }

  /** opens a field's tab and focuses it: the input, an image row's *Hochladen*, a choice's chosen segment (else its first) */
  async function reveal(k: FieldKey) {
    tab = FIELD_TAB[k];
    await tick();
    const el = document.getElementById(`bf-${k}`)
      ?? document.querySelector<HTMLElement>(`[data-field="${k}"] [aria-checked="true"]`)
      ?? document.querySelector<HTMLElement>(`[data-field="${k}"] button`);
    el?.focus();
  }

  // ---- save, conflict, reset ----
  async function save() {
    if (saving || count === 0) return;
    attempted = true;
    const first = firstError(validate(staged));
    if (first) { barError = null; await reveal(first); return; }
    const sent = diff;
    saving = true;
    barError = null;
    /** the field the server named: focused once the form is enabled again */
    let named: FieldKey | null = null;
    try {
      take(await api<AdminAnswer>('/api/admin/brand', { method: 'PUT', body: { rev, brand: sent } }), null);
      serverErrors = {};
      uploads = {};
      shown = new Set();
      attempted = false;
      toast.success(tr('admin.branding.saved'));
      void loadBrand(); // this tab's own brand (and the other tabs on their next visibility check)
    } catch (e) {
      const code = apiCode(e);
      if (code === 'brand_conflict') {
        // another admin saved: their brand underneath, these edits on top (fields they both changed keep this admin's value);
        // the same changes as theirs leave nothing to save; a failed reload keeps the old rev and says so
        if (!(await load(sent))) barError = tr('admin.branding.conflictLoadFailed');
        else barError = tr(Object.keys(stagedDiff(saved, staged)).length ? 'admin.branding.conflict' : 'admin.branding.conflictNone');
      } else if (code === 'invalid' && e instanceof ApiError && typeof e.body?.field === 'string' && serverFieldError(e.body.field)) {
        const fe = serverFieldError(e.body.field)!;
        serverErrors = { ...serverErrors, [fe.field]: fe.text };
        named = fe.field;
      } else {
        barError = tr('admin.branding.saveFailed');
      }
    } finally {
      saving = false;
    }
    if (named) await reveal(named);
  }

  function discard() {
    staged = { ...saved };
    serverErrors = {};
    uploads = {};
    barError = null;
    shown = new Set();
    attempted = false;
  }

  async function reset() {
    const ok = await confirm({ title: tr('admin.branding.resetTitle'), body: tr('admin.branding.resetBody'), danger: true, confirmLabel: tr('admin.branding.resetConfirm') });
    if (!ok || saving) return;
    saving = true;
    try {
      take(await api<AdminAnswer>('/api/admin/brand/reset', { method: 'POST', body: { rev } }), null);
      serverErrors = {};
      uploads = {};
      barError = null;
      shown = new Set();
      attempted = false;
      toast.success(tr('admin.branding.resetDone'));
      void loadBrand();
    } catch (e) {
      if (apiCode(e) === 'brand_conflict') {
        await load(null);
        toast.error(tr('admin.branding.conflictReset'));
      } else toast.error(tr('admin.branding.resetFailed'));
    } finally {
      saving = false;
    }
  }

  // ---- uploads ----
  async function pick(field: ImageFieldKey, file: File) {
    const kind = KINDS[field];
    uploads = { ...uploads, [kind]: { busy: true, text: tr('admin.branding.logo.uploading'), error: false } };
    const p = await prepareImage(file, kind);
    if (!p.ok) {
      uploads = { ...uploads, [kind]: { busy: false, text: uploadErrorText(p.error, p), error: true } };
      return;
    }
    try {
      const r = await api<{ hash: string; url: string }>(`/api/admin/brand/image/${kind}`, { method: 'PUT', raw: p.blob });
      urls = { ...urls, [field]: r.url };
      set(field, r.hash);
      uploads = { ...uploads, [kind]: { busy: false, text: tr('admin.branding.logo.uploaded'), error: false } };
    } catch (e) {
      uploads = { ...uploads, [kind]: { busy: false, text: uploadErrorText(apiCode(e) ?? ''), error: true } };
    }
  }
  function removeImage(field: ImageFieldKey) {
    set(field, null);
    uploads = { ...uploads, [KINDS[field]]: undefined };
  }
  /** an image row's status line: the server's word on its field wins, then the upload's own */
  const imageStatus = (field: ImageFieldKey, u: typeof uploads, se: typeof serverErrors) => {
    if (se[field]) return { text: se[field]!, error: true };
    const s = u[KINDS[field]];
    return s ? { text: s.text, error: s.error } : { text: '', error: false };
  };

  const TEXTS = [
    { k: 'name', label: 'admin.branding.identity.name' },
    { k: 'byline', label: 'admin.branding.identity.byline', placeholder: 'admin.branding.identity.bylinePlaceholder' },
    { k: 'shortName', label: 'admin.branding.identity.shortName', hint: 'admin.branding.identity.shortNameHint' },
    { k: 'website', label: 'admin.branding.identity.website', placeholder: 'admin.branding.identity.websitePlaceholder', type: 'url' },
  ] as const;
  const headerOptions = (_: unknown) => (['wordmark', 'symbol', 'logo'] as const).map((value) => ({ value, label: tr(`admin.branding.logo.headers.${value}`) }));
  const glowOptions = (_: unknown) => (['accent', 'accentViolet', 'neutral', 'off'] as const).map((value) => ({ value, label: tr(`admin.branding.colors.glows.${value}`) }));
  const signInOptions = (_: unknown) => (['posters', 'image', 'color'] as const).map((value) => ({ value, label: tr(`admin.branding.colors.signIns.${value}`) }));
  const tabLabel = (k: BrandTab) => `admin.branding.tabs.${k}` as const;
  const viewLabel = (k: PreviewView) => `admin.branding.preview.tabs.${k}` as const;
  let tabEls: Record<string, HTMLElement> = {};
  const MASKS = ['round', 'rounded', 'square'] as const;
  $: ls = imageStatus('logo', uploads, serverErrors);
  $: ss = imageStatus('symbol', uploads, serverErrors);
  $: si = imageStatus('signInImage', uploads, serverErrors);
</script>

<div class="brand-page">
  <p class="intro">{$t('admin.branding.intro')}</p>
  {#if loadFailed}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('admin.branding.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={() => load()}>{$t('ui.retry')}</Button></div>
  {:else if !loaded}
    <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="12rem" h="2rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
  {:else}
    <div class="cols">
      <div class="form">
        <div class="tabs" role="tablist" aria-label={$t('admin.branding.tabsLabel')}>
          {#each BRAND_TABS as k (k)}
            <!-- the dot's place is always kept: a tab never changes width when it gets an edit -->
            <button type="button" role="tab" id="bt-{k}" class="tab" class:on={tab === k} aria-selected={tab === k} aria-controls="bp-panel" tabindex={tab === k ? 0 : -1}
              bind:this={tabEls[k]} on:click={() => showTab(k, tabEls[k]!)} on:keydown={(e) => tabKey(e, BRAND_TABS, tab, selectTab, 'bt-')}>{$t(tabLabel(k))}<span class="dot" class:on={dirty.has(k)} aria-hidden="true"></span>{#if dirty.has(k)}<span class="sr-only"> ({$t('admin.branding.unsaved')})</span>{/if}</button>
          {/each}
        </div>
        <div id="bp-panel" role="tabpanel" aria-labelledby="bt-{tab}" class="panel-wrap">
          {#key tab}
          <fieldset class="pane" disabled={saving}>
          {#if tab === 'identity'}
            <AdminCard title={$t('admin.branding.identity.title')}>
              <div class="grid">
                {#each TEXTS as f (f.k)}
                  {@const val = staged[f.k]}
                  {@const err = errors[f.k] ?? ''}
                  <div class="field fld" class:has-err={!!err} class:half={f.k === 'shortName' || f.k === 'website'}>
                    <label for="bf-{f.k}">{$t(f.label)}</label>
                    <input id="bf-{f.k}" type={'type' in f ? f.type : 'text'} value={val} maxlength={LIMITS[f.k] * 4} autocomplete="off" spellcheck={f.k !== 'website'}
                      placeholder={'placeholder' in f ? $t(f.placeholder) : undefined} aria-invalid={err ? 'true' : undefined} aria-describedby="bf-{f.k}-m"
                      on:input={(e) => set(f.k, textValue(e))} on:blur={() => leave(f.k)} />
                    <p class="msg" id="bf-{f.k}-m">
                      {#if err}<span class="err" role="alert" title={err}>{err}</span>
                      {:else}<span>{'hint' in f ? $t(f.hint) : ''}</span>{#if f.k !== 'website'}<span class="cnt">{$t('admin.branding.identity.count', { n: charCount(String(val).trim()), max: LIMITS[f.k] })}</span>{/if}{/if}
                    </p>
                  </div>
                {/each}
                <div class="field fld" class:has-err={!!errors.about}>
                  <label for="bf-about">{$t('admin.branding.identity.about')}</label>
                  <textarea id="bf-about" rows="3" value={staged.about} maxlength={LIMITS.about * 4} aria-invalid={errors.about ? 'true' : undefined} aria-describedby="bf-about-m"
                    on:input={(e) => set('about', textValue(e))} on:blur={() => leave('about')}></textarea>
                  <p class="msg" id="bf-about-m">
                    {#if errors.about}<span class="err" role="alert" title={errors.about}>{errors.about}</span>{:else}<span></span><span class="cnt">{$t('admin.branding.identity.count', { n: charCount(staged.about.trim()), max: LIMITS.about })}</span>{/if}
                  </p>
                </div>
              </div>
              <p class="help">{$t('admin.branding.identity.help')}</p>
            </AdminCard>
          {:else if tab === 'logo'}
            <AdminCard title={$t('admin.branding.logo.title')}>
              <div class="stack">
                <div data-field="header">
                  <Seg label={$t('admin.branding.logo.header')} options={headerOptions($t)} value={staged.header}
                    on:change={(e) => { set('header', e.detail as BrandHeader); view = 'desktop'; }} />
                  <p class="msg">{staged.header === 'logo' && !staged.logo ? $t('admin.branding.logo.headerLogoMissing') : ''}</p>
                </div>
                <ImageField kind="logo" uploadId="bf-logo" wide title={$t('admin.branding.logo.logoTitle')} help={$t('admin.branding.logo.logoHelp')} url={staged.logo ? urls.logo ?? null : null}
                  busy={uploads.logo?.busy ?? false} status={ls.text} error={ls.error} on:pick={(e) => pick('logo', e.detail)} on:remove={() => removeImage('logo')} />
                <ImageField kind="symbol" uploadId="bf-symbol" title={$t('admin.branding.logo.symbolTitle')} help={$t('admin.branding.logo.symbolHelp')} url={pb.images.symbol ?? null}
                  busy={uploads.symbol?.busy ?? false} status={ss.text || (pb.images.symbol ? '' : $t('admin.branding.logo.symbolNone'))} error={ss.error}
                  on:pick={(e) => pick('symbol', e.detail)} on:remove={() => removeImage('symbol')} />
                <div class="crop" role="group" aria-label={$t('admin.branding.logo.crop')} style={previewVars(pb)}>
                  <span class="crop-l" aria-hidden="true">{$t('admin.branding.logo.crop')}</span>
                  <span class="masks">
                    {#each MASKS as m (m)}
                      <span class="mask {m}" class:own={!pb.images.symbol} title={$t(`admin.branding.logo.masks.${m}`)}><Mark b={pb} size={44} bleed /></span>
                    {/each}
                  </span>
                </div>
              </div>
            </AdminCard>
          {:else}
            <AdminCard title={$t('admin.branding.colors.title')}>
              <div class="stack">
                <div data-field="accent">
                  <Swatches value={staged.accent} tokens={pb.tokens} error={errors.accent ?? ''} on:change={(e) => set('accent', e.detail)} on:leave={() => leave('accent')} />
                </div>
                <div data-field="glow"><Seg label={$t('admin.branding.colors.glow')} options={glowOptions($t)} value={staged.glow} on:change={(e) => set('glow', e.detail as BrandGlow)} /></div>
                <div data-field="signInBg">
                  <Seg label={$t('admin.branding.colors.signIn')} options={signInOptions($t)} value={staged.signInBg}
                    on:change={(e) => { set('signInBg', e.detail as BrandSignInBg); view = 'signIn'; }} />
                </div>
                <ImageField kind="signIn" uploadId="bf-signInImage" wide title={$t('admin.branding.colors.signInImage')} help={$t('admin.branding.colors.signInImageHelp')}
                  url={staged.signInImage ? urls.signInImage ?? null : null} busy={uploads.signIn?.busy ?? false}
                  status={si.text || (staged.signInBg === 'image' && !staged.signInImage ? $t('admin.branding.colors.signInImageMissing') : '')} error={si.error}
                  on:pick={(e) => { view = 'signIn'; void pick('signInImage', e.detail); }} on:remove={() => removeImage('signInImage')} />
                <p class="help">{$t('admin.branding.colors.help')}</p>
              </div>
            </AdminCard>
          {/if}
          </fieldset>
          {/key}
        </div>
      </div>

      <section class="pv" aria-labelledby="bp-pv-h">
        <div class="pv-head">
          <h2 id="bp-pv-h" class="cap">{$t('admin.branding.preview.title')}</h2>
          <div class="pts" role="tablist" aria-label={$t('admin.branding.preview.title')}>
            {#each PREVIEW_VIEWS as k (k)}
              <button type="button" role="tab" id="bv-{k}" class="pt" class:on={view === k} aria-selected={view === k} aria-controls="bp-pv-frame" tabindex={view === k ? 0 : -1}
                on:click={() => (view = k)} on:keydown={(e) => tabKey(e, PREVIEW_VIEWS, view, selectView, 'bv-')}>{$t(viewLabel(k))}</button>
            {/each}
          </div>
        </div>
        <Preview b={pb} {view} id="bp-pv-frame" labelledby="bv-{view}" />
        <div class="reset"><Button variant="ghost" icon="refresh" disabled={saving} on:click={reset}>{$t('admin.branding.reset')}</Button></div>
      </section>
    </div>
    <SaveBar count={count} text={barText} busy={saving} progress={null} error={barError} saveLabel={$t('admin.branding.save')}
      retry={false} on:discard={discard} on:review={save} />
  {/if}
</div>

<style>
  /* the page end keeps the save bar's room (SaveBar sets --savebar-h before it rises in): nothing is ever covered or moves */
  .brand-page { padding-bottom: var(--savebar-h, 0px); min-width: 0; }
  .intro { margin: 0 0 1rem; color: var(--mut); max-width: 60ch; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
  @media (min-width: 1180px) { .cols { grid-template-columns: minmax(0, 480px) minmax(0, 1fr); gap: 1.75rem; align-items: start; } }
  /* the identity grid follows this column's width, not the window's (beside the preview it is 480 px wide on any desktop) */
  .form { min-width: 0; container: bform / inline-size; }

  /* the tabs as in the mockup: pills, the chosen one light; on a phone the row scrolls sideways inside itself */
  .tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin-bottom: .9rem; padding: 2px; max-width: 100%; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { position: relative; flex: none; display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; padding: 0 14px; border-radius: var(--fr-r-pill);
    border: 1px solid var(--fr-line, rgba(255, 255, 255, .2)); background: rgba(255, 255, 255, .06); color: rgba(255, 255, 255, .85); font-weight: 600; font-size: .94rem; white-space: nowrap; }
  .tab:hover:not(.on) { background: rgba(255, 255, 255, .12); }
  .tab.on { background: #f5f5f5; color: #101418; border-color: #f5f5f5; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); opacity: 0; transition: opacity .2s ease; }
  .dot.on { opacity: 1; }
  .tab.on .dot { background: #8a5a00; }
  .panel-wrap { outline: none; min-width: 0; }
  .pane { animation: bp-in 160ms linear both; margin: 0; padding: 0; border: 0; min-width: 0; }
  @keyframes bp-in { from { opacity: 0; } to { opacity: 1; } }

  .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: .3rem 12px; }
  @container bform (min-width: 640px) { .grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .grid > .fld:not(.half) { grid-column: 1 / -1; } }
  .fld { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
  .fld label { font-weight: 700; color: rgba(255, 255, 255, .85); }
  .fld input, .fld textarea { width: 100%; }
  textarea { resize: vertical; min-height: 5.5rem; line-height: 1.4; }
  /* a field's line keeps its room: the counter (or a hint) until an error takes its place. Two lines are always kept (the longest
     message in the narrowest column), a longer one is clamped (its whole text in `title`, and read in full through aria-describedby) */
  .msg { margin: 0; height: 2.7em; line-height: 1.35; overflow: hidden; display: flex; align-items: flex-start; justify-content: space-between; gap: .6rem; font-size: .82rem; color: rgba(255, 255, 255, .72); }
  .cnt { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .err { color: var(--err); font-weight: 600; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
  .help { margin: .6rem 0 0; font-size: .88rem; color: rgba(255, 255, 255, .78); line-height: 1.45; }
  .stack { display: grid; gap: 1rem; min-width: 0; }
  .stack .msg { margin-top: .4rem; }

  /* the symbol's crop: the round, rounded and square cuts Android and iOS make */
  .crop { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .6rem 1rem; min-height: 44px; font-size: .9rem; }
  .masks { display: flex; gap: 12px; }
  .mask { width: 44px; height: 44px; overflow: hidden; display: grid; place-items: center; }
  .mask.own { background: var(--acc-fill); }
  .mask.round { border-radius: 50%; }
  .mask.rounded { border-radius: 12px; }
  .mask.square { border-radius: 4px; }

  /* the preview column */
  .pv { min-width: 0; display: grid; gap: .75rem; align-content: start; }
  .pv-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem 1rem; }
  .cap { margin: 0; font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--mut); }
  .pts { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; max-width: 100%; padding: 2px; }
  .pts::-webkit-scrollbar { display: none; }
  .pt { flex: none; min-height: 44px; min-width: 44px; padding: 0 14px; border-radius: var(--fr-r-pill); border: 1px solid rgba(255, 255, 255, .14); background: transparent; color: rgba(255, 255, 255, .78); font-weight: 600; font-size: .88rem; white-space: nowrap; }
  .pt:hover:not(.on) { background: rgba(255, 255, 255, .08); }
  .pt.on { background: rgba(255, 255, 255, .14); color: #fff; border-color: rgba(255, 255, 255, .3); }
  .reset { display: flex; justify-content: flex-end; }

  .sk { display: grid; gap: 1rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--fr-r-panel); }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
  :global(html.m-still) .pane, :global(html.m-still) .dot { animation: none; transition: none; }
  @media (prefers-reduced-motion: reduce) { .pane { animation: none; } .dot { transition: none; } }
</style>
