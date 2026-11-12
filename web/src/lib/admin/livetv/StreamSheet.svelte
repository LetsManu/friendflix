<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Stream hinzufügen* (spec §9.1, §3.5): a right-hand glass sheet with the segmented choice *FriendFlix holt den Stream* (pull) /
   * *Encoder sendet an FriendFlix* (push, SRT). Pull: name, URL (password-type with *anzeigen*;
   * kind detected from it as the backend does, until the admin picks one), *Heimnetz
   * erlauben*, number, group. Push: name, number, group; *Anlegen* reserves a port and the sheet turns into the **one-time result**:
   * *Server*, *Port*, *Stream-ID*, *Passphrase*, *SRT-Adresse*, each read-only with a copy button, "Die Passphrase wird nur jetzt
   * angezeigt.", the expandable *OBS/Encoder einrichten* hint and the firewall line. *Fertig* closes it; the values live only in this
   * component and are gone with it. Opened with `result` it shows only that part (*Zugangsdaten neu erzeugen*). Without a known host (neither
   * LIVETV_SRT_HOST nor PUBLIC_URL) *Server* and *SRT-Adresse* are left out and a line says what to set. A full UDP range
   * answers 409 `srt_ports_full` and the sheet says so. Closing with unsaved input asks first; the focus goes back to `trigger`.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { ApiError } from '#lib/api';
  import { dialogKeys } from '#lib/actions';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import Button from '#lib/ui/Button.svelte';
  import CopyField from '#lib/ui/CopyField.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import Select from '#lib/ui/Select.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { addStream, listGroups, type FeedChannel, type GroupOption, type NewStream, type PushResult, type StreamKind } from './api';
  import { confirmDiscard, guardLeave } from './discard';
  import SecretInput from './SecretInput.svelte';
  import { detectKind, sourceError, urlShapeOk } from './sources';

  /** show only the one-time result (new credentials of an existing feed) */
  export let result: { name: string; push: PushResult } | null = null;
  /** the element the focus returns to on close */
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ close: void; created: FeedChannel }>();
  const id = uid('st');
  const KINDS: readonly StreamKind[] = ['hls', 'ts', 'srt'];

  let mode: 'pull' | 'push' = 'pull';
  let name = '', url = '', number = '', groupId = '', allowLan = false;
  /** null = follow the URL */
  let pickedKind: StreamKind | null = null;
  $: kind = pickedKind ?? detectKind(url);
  $: dirty = !result && Boolean(name.trim() || url.trim() || number.trim() || groupId || allowLan || pickedKind);

  let groups: GroupOption[] = [];
  onMount(() => {
    if (!result) {
      document.getElementById(`${id}-name`)?.focus({ preventScroll: true });
      listGroups().then((g) => { groups = g; }).catch(() => undefined);
    } else panelEl?.focus({ preventScroll: true });
  });
  $: groupOptions = [{ value: '', label: $t('adminLive.push.noGroup') }, ...groups.map((g) => ({ value: g.id, label: g.name }))];
  $: kindOptions = KINDS.map((k) => ({ value: k, label: $t(`adminLive.push.kinds.${k}`) }));

  let nameErr = '', urlErr = '', kindErr = '', numErr = '', formErr = '', saving = false;
  function validate(): boolean {
    nameErr = name.trim() ? '' : tr('adminLive.push.nameMissing');
    urlErr = mode === 'pull' && !urlShapeOk(url, ['http:', 'https:', 'srt:']) ? tr('adminLive.push.urlBad') : '';
    const n = number.trim();
    numErr = n && !(/^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= 99_999) ? tr('adminLive.push.numberBad', { max: 99_999 }) : '';
    return !nameErr && !urlErr && !numErr;
  }

  async function create() {
    if (saving || !validate()) return;
    saving = true; formErr = '';
    const common = { name: name.trim(), ...(number.trim() ? { number: Number(number) } : {}), ...(groupId ? { groupId } : {}) };
    const body: NewStream = mode === 'pull' ? { ingest: 'pull', ...common, url: url.trim(), kind, allowLan } : { ingest: 'push', ...common };
    try {
      const r = await addStream(body);
      done = true;
      dispatch('created', r.channel);
      if (r.push) result = { name: r.channel.name, push: r.push };
      else close(true);
    } catch (e) {
      const b = e instanceof ApiError ? (e.body as { error?: unknown; n?: unknown; field?: unknown } | null) : null;
      if (b?.error === 'srt_ports_full') formErr = tr('adminLive.push.portsFull', { n: typeof b.n === 'number' ? b.n : 0 });
      else if (b?.field === 'url' || b?.error === 'lan_required' || b?.error === 'refused') urlErr = b.error === 'invalid' ? tr('adminLive.push.urlBad') : sourceError(String(b.error));
      else if (b?.field === 'name') nameErr = tr('adminLive.push.nameMissing');
      else if (b?.field === 'kind') kindErr = tr('adminLive.push.urlBad'); // srt only with an srt:// address (backend createFeed)
      else if (b?.field === 'number') numErr = tr('adminLive.push.numberBad', { max: 99_999 });
      else formErr = typeof b?.error === 'string' ? sourceError(b.error) : sourceError('unreachable');
    } finally { saving = false; }
  }

  let done = false;
  async function close(force = false) {
    if (!force && dirty && !done && !(await confirmDiscard())) return;
    done = true;
    result = null; // the one-time values leave with the sheet
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  guardLeave(() => !done && dirty, () => { done = true; });

  // the result replaces the form: the focus moves to its heading
  let panelEl: HTMLDivElement | undefined, resultHead: HTMLHeadingElement | undefined;
  $: if (result && resultHead) void tick().then(() => resultHead?.focus({ preventScroll: true }));

  let modeBtns: HTMLButtonElement[] = [];
  const MODES = ['pull', 'push'] as const;
  function modeKey(e: KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + MODES.length) % MODES.length;
    mode = MODES[j]!;
    modeBtns[j]?.focus();
  }

  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, side: 'right' }));
</script>

<div class="st-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={() => close()} transition:scrimFade|global></div>
  <div class="st frost frost-safe frost-sheet" bind:this={panelEl} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close: () => close() }} transition:slide|global>
    {#if result}
      <header>
        <h2 id="{id}-t" tabindex="-1" bind:this={resultHead}>{$t('adminLive.push.resultTitle', { name: result.name })}</h2>
        <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={() => close(true)}><Icon name="x" size={20} /></button>
      </header>
      <div class="body" data-push-result>
        <p class="warn" role="note"><Icon name="alert" size={18} /><span>{$t('adminLive.push.onceWarning')}</span></p>
        {#if result.push.host}<CopyField label={$t('adminLive.push.host')} value={result.push.host} />
        {:else}<p class="fw" data-no-host><Icon name="info" size={18} /><span>{$t('adminLive.push.noHost')}</span></p>{/if}
        <CopyField label={$t('adminLive.push.port')} value={String(result.push.port)} />
        <CopyField label={$t('adminLive.push.streamId')} value={result.push.streamId} />
        <CopyField label={$t('adminLive.push.passphrase')} value={result.push.passphrase} />
        {#if result.push.url}<CopyField label={$t('adminLive.push.url')} value={result.push.url} />{/if}
        <details class="adv">
          <summary><Icon name="chevron-down" size={18} /><span>{$t('adminLive.push.obsTitle')}</span></summary>
          <p class="obs"><Rich key="adminLive.push.obsBody" /></p>
        </details>
        <p class="fw"><Icon name="info" size={18} /><span>{$t('adminLive.push.firewall', { port: String(result.push.port) })}</span></p>
        <div class="foot"><Button on:click={() => close(true)}>{$t('adminLive.push.done')}</Button></div>
      </div>
    {:else}
      <header>
        <h2 id="{id}-t">{$t('adminLive.push.add')}</h2>
        <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={() => close()}><Icon name="x" size={20} /></button>
      </header>
      <form class="body" novalidate on:submit|preventDefault={create}>
        <div role="group" aria-labelledby="{id}-m">
          <span class="lbl" id="{id}-m">{$t('adminLive.push.mode')}</span>
          <div class="seg" role="radiogroup" aria-labelledby="{id}-m">
            {#each MODES as m, i (m)}
              <button type="button" role="radio" aria-checked={mode === m} tabindex={mode === m ? 0 : -1} class:on={mode === m} bind:this={modeBtns[i]}
                on:click={() => (mode = m)} on:keydown={(e) => modeKey(e, i)}>{$t(`adminLive.push.${m}`)}</button>
            {/each}
          </div>
        </div>

        <Field label={$t('adminLive.push.name')} id="{id}-name" bind:value={name} maxlength={60} required error={nameErr} />

        {#if mode === 'pull'}
          <Field label={$t('adminLive.push.pullUrl')} required error={urlErr} hint={$t('adminLive.push.pullUrlHint')} let:id={fid} let:describedby let:invalid>
            <SecretInput id={fid} bind:value={url} {describedby} {invalid} />
          </Field>
          <Select label={$t('adminLive.push.kind')} value={kind} options={kindOptions} hint={pickedKind ? '' : $t('adminLive.push.kindAuto')} error={kindErr}
            on:change={(e) => { const v = (e.target as HTMLSelectElement | null)?.value; if (v === 'hls' || v === 'ts' || v === 'srt') { pickedKind = v; kindErr = ''; } }} />
          <Toggle label={$t('adminLive.src.lan')} hint={$t('adminLive.src.lanHint')} bind:checked={allowLan} />
        {:else}
          <p class="note"><Icon name="key" size={18} /><span>{$t('adminLive.push.pushNote')}</span></p>
        {/if}

        <Field label={$t('adminLive.push.number')} type="number" bind:value={number} min={1} max={99999} width="8rem" error={numErr} hint={$t('adminLive.src.optional')} />
        <Select label={$t('adminLive.push.group')} bind:value={groupId} options={groupOptions} />

        <div class="slot" aria-live="polite">
          {#if formErr}<p class="msg err" role="alert" data-form-error><Icon name="alert" size={18} /><span>{formErr}</span></p>{/if}
        </div>
        <div class="foot">
          <Button type="submit" icon="plus" pending={saving}>{$t('adminLive.push.create')}</Button>
          <Button variant="ghost" on:click={() => close()}>{$t('adminLive.src.cancel')}</Button>
        </div>
      </form>
    {/if}
  </div>
</div>

<style>
  .st-wrap { position: fixed; inset: 0; z-index: 90; }
  .st { position: absolute; top: 0; right: 0; bottom: 0; box-sizing: border-box; width: min(480px, 100%); display: flex; flex-direction: column; outline: none; color: #fff;
    border-right: 0; border-radius: var(--fr-r-sheet) 0 0 var(--fr-r-sheet); padding: 14px 0 0; }
  header { flex: none; display: flex; align-items: center; gap: .5rem; padding: 0 18px .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; overflow-wrap: anywhere; outline: none; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: .4rem 18px calc(18px + var(--safe-bottom, 0px)); display: flex; flex-direction: column; gap: 1rem; }
  .lbl { display: block; font-size: .9rem; font-weight: 600; margin-bottom: .35rem; }
  .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid rgba(255, 255, 255, .2); border-radius: 22px; padding: 3px; gap: 3px; max-width: 100%; }
  .seg button { min-height: 44px; padding: .3rem 1rem; border-radius: 999px; background: transparent; border: 0; color: rgba(255, 255, 255, .8); font-weight: 600; text-align: left; }
  .seg button.on { background: #fff; color: #101418; }
  .seg button:not(.on):hover { color: #fff; }
  .note, .fw, .warn { display: flex; gap: .45rem; align-items: flex-start; margin: 0; overflow-wrap: anywhere; min-width: 0; }
  .note :global(svg), .fw :global(svg), .warn :global(svg) { flex: none; margin-top: .15rem; }
  .warn { padding: .6rem .8rem; border-radius: 12px; background: rgba(var(--fr-scrim-rgb, 18, 16, 24), .45); font-weight: 700; }
  .warn :global(svg) { color: var(--err); }
  .adv { border-top: 1px solid rgba(255, 255, 255, .12); padding-top: .4rem; }
  .adv summary { list-style: none; display: flex; align-items: center; gap: .4rem; min-height: 44px; cursor: pointer; font-weight: 600; }
  .adv summary::-webkit-details-marker { display: none; }
  .adv summary :global(svg) { transition: transform var(--t-fast, .15s); }
  .adv[open] summary :global(svg) { transform: rotate(180deg); }
  .obs { margin: .2rem 0 .4rem; font-size: .9rem; overflow-wrap: anywhere; }
  .slot { min-height: 3rem; }
  .msg { display: flex; gap: .45rem; align-items: flex-start; margin: 0; overflow-wrap: anywhere; }
  .msg :global(svg) { flex: none; margin-top: .15rem; color: var(--err); }
  .foot { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
  /* a pending button's spinner takes its icon's 18 px: the buttons keep their width */
  .foot :global(.spinner) { width: 18px; height: 18px; }
  :global(html.m-still) .st-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .st-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
