<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  export interface MoreAction {
    id: string;
    label: string;
    /** name from Icon.svelte */
    icon?: string;
    /** rendered as a link; the menu closes on click */
    href?: string;
    /** called on click; the menu closes first (focus goes back to the trigger) */
    run?: () => void | Promise<void>;
    disabled?: boolean;
    /** red text (remove / delete) */
    danger?: boolean;
    /** toggle state (aria-pressed), e.g. Favorit / Gesehen */
    pressed?: boolean;
  }
</script>

<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { placePopover, placedStyle } from '#lib/popover';
  import { holdBillboard } from '#lib/preview';
  import { t } from '#lib/i18n';
  import { growFrom, scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';

  /**
   * "⋯ Mehr": one trigger that opens a menu (desktop popover) or a bottom sheet (touch / narrow screens).
   * Pass `actions` and/or custom content in the default slot (`let:close` closes the menu), e.g. ListMenu variant="row".
   */
  export let actions: MoreAction[] = [];
  /** accessible name + visible text of the trigger (labelled variants); default: "Mehr" in the current language */
  export let label = '';
  $: shown = label || $t('common.more');
  /** heading of the sheet / popover (e.g. the title name) */
  export let title = '';
  /** round = pop-out card (34px), ring = detail view icon button, labelled = icon + text under it (phone icon row), pill = grey button with text */
  export let variant: 'round' | 'ring' | 'labelled' | 'pill' = 'round';
  /** diameter of the round variant in px */
  export let size = 34;
  /** prefer opening the popover above the trigger */
  export let up = false;
  /** force the bottom sheet (true) / the popover (false); default: sheet on touch or narrow screens */
  export let sheet: boolean | undefined = undefined;

  const dispatch = createEventDispatcher<{ open: void; close: void; action: { id: string } }>();
  let open = false, asSheet = false, style = '', btn: HTMLButtonElement, panel: HTMLDivElement | undefined;
  let release: (() => void) | null = null;

  const useSheet = () => sheet ?? (typeof matchMedia !== 'undefined' && matchMedia('(hover: none), (pointer: coarse), (max-width: 600px)').matches);
  function place() {
    if (!btn || asSheet) return;
    style = placedStyle(placePopover(btn.getBoundingClientRect(), { w: window.innerWidth, h: window.innerHeight }, { up }));
  }
  export async function show() {
    if (open) return;
    asSheet = useSheet();
    open = true; place();
    if (asSheet) release = holdBillboard();
    dispatch('open');
    await tick();
    (panel?.querySelector<HTMLElement>('.mi:not([disabled]), a[href], button:not([disabled]), input:not([disabled])') ?? panel)?.focus({ preventScroll: true });
  }
  export function close(refocus = true) {
    if (!open) return;
    open = false;
    release?.(); release = null;
    dispatch('close');
    if (refocus) btn?.focus({ preventScroll: true });
  }
  const toggle = () => (open ? close() : void show());
  /** the popover grows out of the trigger and folds back into it; the phone sheet slides up and back down (glass spec §5, §8.3) */
  // (bidirectional: a close mid-open shrinks from where it is, a reopen mid-close grows from there)
  function popT(node: Element) {
    return twoWay((dir) => (asSheet ? sheetSlide(node, { dir }) : growFrom(node, { trigger: btn, dir })));
  }

  async function runAction(a: MoreAction, e: MouseEvent) {
    if (a.disabled) { e.preventDefault(); return; }
    dispatch('action', { id: a.id });
    close(!a.href);
    if (a.run) await a.run();
  }

  /** nested popovers (ListMenu etc.) are portaled to <body> after us: clicks/focus there count as inside */
  function inside(n: EventTarget | null): boolean {
    if (!n || !(n instanceof Node)) return false;
    if (btn?.contains(n) || panel?.contains(n)) return true;
    if (!panel) return false;
    let top: Node | null = n;
    while (top && top.parentNode && top.parentNode !== document.body) top = top.parentNode;
    const host = panel.parentNode === document.body ? panel : panel.closest('body > *');
    return !!(top && host && top !== host && top.parentNode === document.body && host.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  function onDoc(e: Event) { if (open && !inside(e.target)) close(false); }
  function onFocusOut(e: FocusEvent) { if (open && !asSheet && e.relatedTarget && !inside(e.relatedTarget)) close(false); }
  function onKey(e: KeyboardEvent) {
    if (!panel) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    const items = [...panel.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((x) => x.getClientRects().length);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Tab') { // focus trap
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); items[items.length - 1]!.focus(); }
      else if (!e.shiftKey && (i === items.length - 1 || i < 0)) { e.preventDefault(); items[0]!.focus(); }
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !(document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text')) {
      e.preventDefault();
      const n = items.length, j = e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      items[j]!.focus();
    }
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', onDoc, true);
  onDestroy(() => { if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onDoc, true); release?.(); });
</script>

<svelte:window on:resize={() => open && place()} on:scroll|capture={(e) => { if (open && !asSheet && !panel?.contains(e.target as Node)) place(); }} />

<button
  bind:this={btn} type="button" class="ma {variant}" class:on={open} aria-haspopup="dialog" aria-expanded={open} aria-label={variant === 'labelled' || variant === 'pill' ? undefined : shown} title={variant === 'round' || variant === 'ring' ? shown : undefined}
  style={variant === 'round' ? `--ma:${size}px` : undefined} on:click|stopPropagation={toggle}
>
  <svg class="dots" width={variant === 'round' ? Math.round(size * 0.52) : 22} height={variant === 'round' ? Math.round(size * 0.52) : 22} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
  {#if variant === 'labelled' || variant === 'pill'}<span class="tx">{shown}</span>{/if}
</button>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="ma-wrap" class:modal={asSheet} use:portal role="presentation">
    {#if asSheet}<div class="scrim" role="presentation" on:click={() => close()} transition:scrimFade|global></div>{/if}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class={asSheet ? 'sheet ma-pop frost frost-sheet frost-safe' : 'pop ma-pop frost frost-menu frost-safe'} bind:this={panel} transition:popT style={`--fr-scrim-safe:${SCRIM_MENU};` + (asSheet ? '' : style)} tabindex="-1" role="dialog" aria-modal={asSheet ? 'true' : undefined} aria-label={title || shown} on:keydown={onKey} on:focusout={onFocusOut}>
      {#if asSheet}<span class="grab" aria-hidden="true"></span>{/if}
      {#if title}<p class="ttl">{title}</p>{/if}
      {#if actions.length}
        <ul>
          {#each actions as a (a.id)}
            <li>
              {#if a.href && !a.disabled}
                <a class="mi" class:danger={a.danger} href={a.href} on:click={(e) => runAction(a, e)}>{#if a.icon}<Icon name={a.icon} size={20} />{:else}<span class="sp"></span>{/if}<span>{a.label}</span></a>
              {:else}
                <button type="button" class="mi" class:danger={a.danger} disabled={a.disabled} aria-pressed={a.pressed} on:click={(e) => runAction(a, e)}>{#if a.icon}<Icon name={a.icon} size={20} fill={a.pressed && a.icon === 'heart'} />{:else}<span class="sp"></span>{/if}<span>{a.label}</span>{#if a.pressed}<span class="chk"><Icon name="check" size={16} /></span>{/if}</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if $$slots.default}<div class="slot"><slot {close} /></div>{/if}
      {#if asSheet}<button type="button" class="mi cancel" on:click={() => close()}>{$t('common.close')}</button>{/if}
    </div>
  </div>
{/if}

<style>
  .ma { position: relative; color: #fff; padding: 0; }
  .ma.round { width: var(--ma); height: var(--ma); min-height: var(--ma); border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); display: grid; place-items: center; }
  .ma.round::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; }
  .ma.round:hover:not(:disabled), .ma.round.on { border-color: #fff; background: rgba(42,42,42,.9); }
  .ma.ring { width: 44px; height: 44px; min-height: 44px; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); display: grid; place-items: center; }
  .ma.ring:hover:not(:disabled), .ma.ring.on { border-color: #fff; background: rgba(42,42,42,.9); }
  .ma.labelled { flex-direction: column; gap: .3rem; background: none; border: 0; min-height: 44px; padding: .2rem .4rem; border-radius: 6px; }
  .ma.labelled .tx { font-size: .75rem; font-weight: 500; color: var(--mut); }
  .ma.labelled:hover:not(:disabled) { background: rgba(255,255,255,.08); }
  .ma.pill { background: rgba(112,124,138,.55); border-radius: 4px; padding: .6rem 1rem; gap: .5rem; }
  .ma.pill:hover:not(:disabled) { background: rgba(112,124,138,.35); }
  .ma:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  /* glass card (glass spec §5): .frost .frost-menu (20 px corners, 8 px padding), 44 px rows with 12 px corners; hover, focus and
     a pressed toggle are the light pill; the safe scrim for white text on that pill and .9 notes (SCRIM_MENU), as artwork or video can
     sit behind it */
  .pop { position: fixed; z-index: 88; box-sizing: border-box; overflow: auto; overscroll-behavior: contain; outline: none; padding: 8px; text-align: left; font-size: .92rem; font-weight: 400; }
  .ttl { margin: .35rem .7rem .45rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul { list-style: none; margin: 0; padding: 0; }
  .mi { display: flex; gap: .8rem; align-items: center; width: 100%; min-height: 44px; padding: 0 14px; border: 0; border-radius: 12px; background: transparent; color: inherit; font: inherit; font-weight: 600; text-align: left; text-decoration: none; justify-content: flex-start; }
  .mi:hover:not(:disabled), .mi:focus-visible, .mi[aria-pressed='true'] { background: var(--fr-sel); outline: none; }
  .mi:focus-visible { box-shadow: inset 0 0 0 2px #fff; }
  .mi:active:not(:disabled) { transform: none; }
  /* a destructive row: white text (AA on glass over any backdrop), the colour only on its icon or a dot */
  .mi.danger :global(svg) { color: var(--err-mark); } /* a light red: 3:1 on the glass over a white backdrop */
  .mi.danger .sp { display: grid; place-items: center; }
  .mi.danger .sp::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--err-mark); }
  .mi .sp { width: 20px; flex: none; }
  .chk { margin-left: auto; color: var(--ok, #4ade80); }
  .slot { border-top: 1px solid rgba(255,255,255,.1); margin-top: 6px; padding-top: 6px; }
  /* rows from nested pickers (ListMenu variant="row") line up with the menu items */
  .pop .slot :global(.rowbtn) { min-height: 44px; padding: 0 14px; border-radius: 12px; font-weight: 600; }
  .slot:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
  .ma-wrap.modal { position: fixed; inset: 0; z-index: 88; }
  .scrim { position: absolute; inset: 0; background: rgba(0,0,0,.6); }
  /* phone: a glass bottom sheet (top corners 26 px) that slides up (sheetSlide) */
  .sheet { position: absolute; left: 0; right: 0; bottom: 0; max-width: 560px; max-height: 82vh; margin: 0 auto; overflow: auto; overscroll-behavior: contain; outline: none; border-bottom: 0; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding: .4rem .6rem calc(.6rem + var(--safe-bottom)); }
  .grab { display: block; width: 40px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.3); margin: .3rem auto .5rem; }
  .sheet .mi { min-height: 48px; padding: 0 1rem; }
  .cancel { justify-content: center; color: rgba(255,255,255,.9); margin-top: .3rem; }
  .cancel:hover:not(:disabled), .cancel:focus-visible { color: #fff; } /* on the light pill: white */
  @media (pointer: coarse) { .mi { min-height: 48px; } }
</style>
