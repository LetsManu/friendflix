<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The whole role as a form (spec §6.1): a right-hand glass sheet (`sheetSlide`, the page dimmed behind) with the name, the
   * invitable switch (not for admin), and every visible right grouped as in the matrix, the library checklist included. Every
   * edit is staged into the same `stage` as the matrix cells (the save bar behind it counts them); nothing is written here.
   * A modal dialog: Tab stays inside, Escape or a press on the dimmed page closes it and the focus goes back to `trigger`.
   * *Umbenennen* opens it with the name field focused (`focusName`). Mounted while open.
   *   <RoleSheet {matrix} {role} bind:stage focusName={false} {trigger} on:close={() => (open = null)} />
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { locale, t } from '#lib/i18n';
  import { PERM_KEYS } from '#lib/perms';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import Toggle from '#lib/ui/Toggle.svelte';
  import FieldControl from './FieldControl.svelte';
  import { roleName, stageSet, visibleFields, type FieldGroup, type MatrixField, type MatrixRole, type RoleMatrix, type Stage } from './model';

  export let matrix: RoleMatrix;
  export let role: MatrixRole;
  export let stage: Stage = {};
  /** the name field starts focused (*Umbenennen*) */
  export let focusName = false;
  /** the element the focus returns to on close */
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = uid('rs');
  const PERM_SET: ReadonlySet<string> = new Set(PERM_KEYS);
  let panel: HTMLDivElement | undefined;

  $: staged = (key: string): boolean => Object.hasOwn(stage[role.key] ?? {}, key);
  $: valueOf = (key: string): unknown => (Object.hasOwn(stage[role.key] ?? {}, key) ? stage[role.key]![key] : role.values[key]);
  const put = (key: string, v: unknown) => { stage = stageSet(stage, matrix, role.key, key, v); };

  // ---- name: staged once it is 1-30 characters (the role write's bounds); a bad text shows the error and stages nothing
  let typed: string | null = null;
  $: name = typed ?? (Object.hasOwn(stage[role.key] ?? {}, 'label') ? String(stage[role.key]!.label) : roleName(role));
  $: nameErr = typed !== null && (typed.trim().length < 1 || typed.trim().length > 30) ? $t('adminPeople.roles.errLabel') : '';
  function onName(e: Event) {
    typed = (e.target as HTMLInputElement).value;
    const v = typed.trim();
    // an empty or too long text stages nothing: the loaded name goes back in (which unstages an earlier valid prefix)
    put('label', v.length >= 1 && v.length <= 30 ? v : roleName(role));
  }

  /** the visible fields under their groups; the admin's switches are locked and left out (its note says so) */
  $: groups = visibleFields(matrix).filter((f) => !(role.base === 'admin' && PERM_SET.has(f.key))).reduce<Array<{ id: FieldGroup; fields: MatrixField[] }>>((acc, f) => {
    const last = acc[acc.length - 1];
    if (last && last.id === f.group) last.fields.push(f); else acc.push({ id: f.group, fields: [f] });
    return acc;
  }, []);

  function close() {
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, side: 'right' }));
  onMount(() => {
    if (focusName && role.stored) document.getElementById(`${id}-name`)?.focus({ preventScroll: true });
    else panel?.focus({ preventScroll: true });
  });
</script>

<div class="rs-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={close} transition:scrimFade|global></div>
  <div class="rs frost frost-safe frost-sheet" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close }} transition:slide|global>
    <header>
      <h2 id="{id}-t">{$locale && $t('adminPeople.roles.sheetTitle', { name: roleName(role) })}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={close}><Icon name="x" size={20} /></button>
    </header>
    <div class="body">
      <section class="own" aria-label={$t('adminPeople.roles.fLabel')}>
        <!-- a role without a table row (a ROLE_TEMPLATES key the roles table cannot hold) has no name or invitable switch to write -->
        {#if role.stored}<Field label={$t('adminPeople.roles.fLabel')} id="{id}-name" value={name} maxlength={30} error={nameErr} on:input={onName} />{/if}
        {#if role.base !== 'admin' && role.stored}
          <Toggle label={$t('adminPeople.roles.fInvitable')} hint={$t('adminPeople.roles.invitableHint')} checked={Boolean(valueOf('invitable') ?? role.invitable)} on:change={(e) => put('invitable', e.detail)} />
        {/if}
        {#if role.envGone}<p class="note">{$t('adminPeople.roles.envGone')}</p>
        {:else if role.origin === 'env'}<p class="note">{$t('adminPeople.roles.fromEnv')}</p>{/if}
        {#if role.base === 'admin'}<p class="note">{$t('adminPeople.roles.adminLocked')}</p>{/if}
      </section>
      {#each groups as g (g.id)}
        <section aria-labelledby="{id}-g-{g.id}">
          <h3 id="{id}-g-{g.id}">{$t(`adminPeople.roles.groups.${g.id}`)}</h3>
          {#each g.fields as f (f.key)}
            <div class="row" class:staged={staged(f.key)}>
              <FieldControl field={f} value={valueOf(f.key)} libraries={matrix.libraries} on:change={(e) => put(f.key, e.detail)} />
            </div>
          {/each}
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .rs-wrap { position: fixed; inset: 0; z-index: 90; }
  .rs { position: absolute; top: 0; right: 0; bottom: 0; box-sizing: border-box; width: min(440px, 100%); display: flex; flex-direction: column; outline: none; color: #fff;
    border-right: 0; border-radius: var(--fr-r-sheet) 0 0 var(--fr-r-sheet); padding: 14px 0 0; }
  header { flex: none; display: flex; align-items: center; gap: .5rem; padding: 0 18px .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; overflow-wrap: anywhere; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: .4rem 18px calc(18px + var(--safe-bottom, 0px)); display: flex; flex-direction: column; gap: 1.1rem; }
  section { display: flex; flex-direction: column; gap: .8rem; min-width: 0; }
  section + section { border-top: 1px solid rgba(255, 255, 255, .12); padding-top: .9rem; }
  h3 { margin: 0; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: rgba(255, 255, 255, .9); }
  .note { margin: 0; font-size: .85rem; color: rgba(255, 255, 255, .9); }
  /* a staged field: the amber rail of the matrix's staged cell, on the left of its control */
  .row { padding-left: .7rem; border-left: 3px solid transparent; }
  .row.staged { border-left-color: var(--warn); }
  /* calm mode and reduced motion: nothing moves */
  :global(html.m-still) .rs-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .rs-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
