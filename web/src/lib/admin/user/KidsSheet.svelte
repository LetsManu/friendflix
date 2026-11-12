<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Kinderprofil anlegen* (spec §6.3): a small glass sheet sliding up (`sheetSlide`, the page dimmed behind) with the name and the age
   * limit. A modal dialog: Tab stays inside, Escape or a press on the dimmed page closes it (not while `pending`), the focus goes back
   * to `trigger`. The page does the write (`create`) and closes the sheet when it worked; a failure leaves the sheet open with its
   * input. Mounted while open.
   *   <KidsSheet {trigger} pending={busy} on:create={(e) => make(e.detail)} on:close={() => (open = false)} />
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import Select from '#lib/ui/Select.svelte';
  import { CAPS, capLabel } from './profiles';

  /** the button it came from (the focus returns there on close) */
  export let trigger: HTMLElement | null = null;
  /** the write is running */
  export let pending = false;
  /** why the last write failed (shown here, where the button is: a toast would cover it) */
  export let error = '';
  /** the DB limit of a profile name */
  const NAME_MAX = 20;

  const dispatch = createEventDispatcher<{ create: { name: string; maxRating: number }; edit: void; close: void }>();
  const id = uid('ks');
  let panel: HTMLDivElement | undefined;
  let name = '', cap = '12';
  $: options = CAPS.map((n) => ({ value: String(n), label: capLabel(n) }));

  function close() {
    if (pending) return;
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  function submit() {
    const n = name.trim();
    if (!n || pending) return;
    dispatch('create', { name: n, maxRating: Number(cap) });
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir }));
  onMount(() => { document.getElementById(`${id}-name`)?.focus({ preventScroll: true }); });
</script>

<div class="ks-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={close} transition:scrimFade|global></div>
  <div class="ks frost frost-safe frost-sheet" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close }} transition:slide|global>
    <header>
      <h2 id="{id}-t">{$t('adminPeople.profiles.createKids')}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={close}><Icon name="x" size={20} /></button>
    </header>
    <form on:submit|preventDefault={submit}>
      <Field id="{id}-name" label={$t('adminPeople.profiles.sheetName')} bind:value={name} maxlength={NAME_MAX} required on:input={() => dispatch('edit')} />
      <Select id="{id}-cap" label={$t('adminPeople.profiles.maxRating')} bind:value={cap} {options} />
      {#if error}<p class="err" role="alert"><Icon name="alert" size={18} /><span>{error}</span></p>{/if}
      <p class="note"><Icon name="info" size={18} /><span>{$t('adminPeople.profiles.createHint')}</span></p>
      <footer>
        <Button variant="ghost" disabled={pending} on:click={close}>{$t('common.cancel')}</Button>
        <Button type="submit" {pending} disabled={!name.trim()}>{$t('adminPeople.profiles.create')}</Button>
      </footer>
    </form>
  </div>
</div>

<style>
  .ks-wrap { position: fixed; inset: 0; z-index: 90; }
  .ks { position: absolute; left: 0; right: 0; bottom: 0; box-sizing: border-box; max-width: 480px; max-height: 82vh; margin: 0 auto; overflow: auto; overscroll-behavior: contain;
    outline: none; color: #fff; border-bottom: 0; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding: 14px 18px calc(16px + var(--safe-bottom, 0px)); }
  header { display: flex; align-items: center; gap: .5rem; margin-bottom: .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  form { display: flex; flex-direction: column; gap: .9rem; }
  .note { display: flex; gap: .55rem; align-items: flex-start; margin: 0; color: rgba(255, 255, 255, .9); font-size: .9rem; }
  .err { display: flex; gap: .55rem; align-items: flex-start; margin: 0; color: rgba(255, 255, 255, .9); font-weight: 700; }
  .err :global(svg) { color: #ffbdbd; }
  .err :global(svg), .note :global(svg) { flex: none; margin-top: .1rem; }
  footer { display: flex; justify-content: flex-end; gap: .6rem; flex-wrap: wrap; }
  /* calm mode and reduced motion: nothing moves */
  :global(html.m-still) .ks-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .ks-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
