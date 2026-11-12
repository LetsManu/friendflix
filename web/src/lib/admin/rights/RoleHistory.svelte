<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Verlauf* of one role (spec §6.1, §6.6): a right-hand glass sheet that lists the role's audit entries (GET /api/admin/audit?target=)
   * newest first, each as a sentence with from → to chips (auditText.ts). A modal dialog like the role sheet; the focus returns to
   * `trigger`. Mounted while open.
   *   <RoleHistory {role} {trigger} on:close={() => (open = null)} />
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { api } from '#lib/api';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, locale, t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { uid } from '#lib/ui/ids';
  import { auditSentence, sinceLatestCreate } from './auditText';
  import { roleName, type MatrixRole } from './model';

  export let role: MatrixRole;
  export let trigger: HTMLElement | null = null;
  /** a role's name by key (the matrix's labels); null = no such role any more */
  export let names: (key: string) => string | null = () => null;

  interface Entry { id: number | string; at: string; action: string; target: string | null; meta: Record<string, unknown> | null; actor: string | null; target_name: string | null }
  const dispatch = createEventDispatcher<{ close: void }>();
  const id = uid('rh');
  let panel: HTMLDivElement | undefined;
  let entries: Entry[] | null = null, error = false;

  async function load() {
    error = false;
    try { entries = (await api<{ entries: Entry[] }>(`/api/admin/audit?target=${encodeURIComponent(role.key)}&limit=100`)).entries; } catch { error = true; }
  }
  $: rows = sinceLatestCreate(entries ?? [], role.key).map((e) => ({ e, s: auditSentence({ action: e.action, actorName: e.actor, targetName: roleName(role), target: e.target, meta: e.meta ?? {}, roleName: names }) }));

  function close() {
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, side: 'right' }));
  onMount(() => { panel?.focus({ preventScroll: true }); void load(); });
</script>

<div class="rh-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={close} transition:scrimFade|global></div>
  <div class="rh frost frost-safe frost-sheet" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close }} transition:slide|global>
    <header>
      <h2 id="{id}-t">{$locale && tr('adminPeople.roles.historyTitle', { name: roleName(role) })}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={close}><Icon name="x" size={20} /></button>
    </header>
    <div class="body" aria-busy={entries === null && !error}>
      {#if error}
        <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminPeople.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
      {:else if entries === null}
        <Skeleton lines={5} />
      {:else if !rows.length}
        <p class="empty">{$t('adminPeople.roles.historyEmpty')}</p>
      {:else}
        <ul>
          {#each rows as { e, s } (e.id)}
            <li>
              <span class="tx">{s.text}</span>
              {#if s.chips.length}
                <ul class="chips">
                  {#each s.chips as c (c.label)}<li class="chip">{$t('adminPeople.roles.auditChip', { field: c.label, from: c.from, to: c.to })}</li>{/each}
                </ul>
              {/if}
              <time datetime={e.at}>{fmtDateTime(e.at)}</time>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</div>

<style>
  .rh-wrap { position: fixed; inset: 0; z-index: 90; }
  .rh { position: absolute; top: 0; right: 0; bottom: 0; box-sizing: border-box; width: min(440px, 100%); display: flex; flex-direction: column; outline: none; color: #fff;
    border-right: 0; border-radius: var(--fr-r-sheet) 0 0 var(--fr-r-sheet); padding: 14px 0 0; }
  header { flex: none; display: flex; align-items: center; gap: .5rem; padding: 0 18px .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; overflow-wrap: anywhere; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: .4rem 18px calc(18px + var(--safe-bottom, 0px)); }
  ul { list-style: none; margin: 0; padding: 0; }
  .body > ul > li { display: grid; gap: .35rem; padding: .7rem .1rem; border-bottom: 1px solid rgba(255, 255, 255, .12); }
  .tx { overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: .4rem; }
  .chip { padding: .2rem .7rem; border-radius: var(--fr-r-pill, 99px); background: rgba(var(--fr-scrim-rgb), .25); font-size: .85rem; font-weight: 600; overflow-wrap: anywhere; }
  time { font-size: .8rem; color: rgba(255, 255, 255, .9); }
  .empty { margin: 1rem 0; color: rgba(255, 255, 255, .9); }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 1.5rem 0; }
  .state p { margin: 0; }
  :global(html.m-still) .rh-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .rh-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
