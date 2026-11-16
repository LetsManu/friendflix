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
    /** destructive (delete, lock, sign out): last, after the divider; white text, the light red only on its icon (or a dot) */
    danger?: boolean;
    /** a removal that is not destructive (e.g. out of Continue Watching): after the divider, before the danger rows, white */
    tail?: boolean;
    /** trailing value text (the current setting) */
    value?: string;
    /** toggle state (aria-pressed), e.g. Favorit / Gesehen */
    pressed?: boolean;
  }
</script>

<script lang="ts">
  import { createEventDispatcher, getContext, onDestroy, setContext, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { menuGroups } from '#lib/ui/menuGroups';
  import { menuMove, moveIndex } from '#lib/ui/menuKeys';
  import { menuPlace } from '#lib/ui/menuPlace';
  import { openPopup, POPUP_CTX, type PopupHandle } from '#lib/ui/popups';
  import { holdBillboard } from '#lib/preview';
  import { t } from '#lib/i18n';
  import { growFrom, scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';

  /**
   * "⋯ Mehr": one trigger that opens a menu (desktop popover) or a bottom sheet (touch / narrow screens).
   * Pass `actions` and/or custom content in the default slot (`let:close` closes the menu), e.g. ListMenu variant="row".
   * The popover is the shared glass menu (app.css `.gm*`): the title as its header line, 44 px rows (icon column, label, value or
   * check), the removals and destructive rows last after a divider (menuGroups). It places itself inside the window
   * (menuPlace), closes when its button scrolls away, on a route change and when another pop-up opens (lib/ui/popups; pickers
   * in its slot open as its children and keep it open).
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
  /** prefer opening the popover above the trigger (it still flips when there is no room) */
  export let up = false;
  /** force the bottom sheet (true) / the popover (false); default: sheet on touch or narrow screens */
  export let sheet: boolean | undefined = undefined;

  const dispatch = createEventDispatcher<{ open: void; close: void; action: { id: string } }>();
  let open = false, asSheet = false, btn: HTMLButtonElement, panel: HTMLDivElement | undefined;
  let release: (() => void) | null = null;
  $: groups = menuGroups(actions);

  /** one pop-up at a time: this menu's entry; a picker in the slot opens as its child (it keeps this menu open) */
  const parentPopup = getContext<(() => PopupHandle | null) | undefined>(POPUP_CTX);
  let popup: PopupHandle | null = null;
  setContext(POPUP_CTX, () => popup);

  const useSheet = () => sheet ?? (typeof matchMedia !== 'undefined' && matchMedia('(hover: none), (pointer: coarse), (max-width: 600px)').matches);
  export async function show() {
    if (open) return;
    asSheet = useSheet();
    popup = openPopup(() => close(false), parentPopup?.() ?? null);
    open = true;
    if (asSheet) release = holdBillboard();
    dispatch('open');
    await tick();
    (panel?.querySelector<HTMLElement>('.gm-row:not([disabled]), .mi:not([disabled]), a[href], button:not([disabled]), input:not([disabled])') ?? panel)?.focus({ preventScroll: true });
  }
  export function close(refocus = true) {
    if (!open) return;
    open = false;
    const p = popup; popup = null; p?.release();
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
    } else {
      // Arrow keys, Home and End move through the rows (wrapping); a text field keeps them for its caret
      const move = menuMove(e.key);
      if (!move || e.altKey || e.ctrlKey || e.metaKey || typing(document.activeElement)) return;
      e.preventDefault();
      items[moveIndex(move, i, items.length)]!.focus();
    }
  }
  const typing = (el: Element | null): boolean =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type));
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', onDoc, true);
  onDestroy(() => { if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onDoc, true); release?.(); popup?.release(); popup = null; });
</script>

<button
  bind:this={btn} type="button" class="ma {variant}" class:frost-btn={variant === 'ring'} class:on={open} aria-haspopup="dialog" aria-expanded={open} aria-label={variant === 'labelled' || variant === 'pill' ? undefined : shown} title={variant === 'round' || variant === 'ring' ? shown : undefined}
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
    <div class={asSheet ? 'sheet ma-pop frost frost-sheet frost-safe' : 'pop ma-pop gm frost frost-menu frost-safe'} bind:this={panel} transition:popT use:menuPlace={{ trigger: asSheet ? null : btn, up, onMoved: () => close(false) }} style={`--fr-scrim-safe:${SCRIM_MENU};`} tabindex="-1" role="dialog" aria-modal={asSheet ? 'true' : undefined} aria-label={title || shown} on:keydown={onKey} on:focusout={onFocusOut}>
      {#if asSheet}
        <span class="grab" aria-hidden="true"></span>
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
      {:else}
        {#if title}<p class="gm-head">{title}</p>{/if}
        {#if actions.length}
          <ul>
            {#each groups as g, gi}
              {#if gi > 0}<li class="gm-sep" role="separator"></li>{/if}
              {#each g as a (a.id)}
                <li>
                  {#if a.href && !a.disabled}
                    <a class="gm-row" class:danger={a.danger} href={a.href} on:click={(e) => runAction(a, e)}><span class="gm-ic">{#if a.icon}<Icon name={a.icon} size={20} />{:else if a.danger}<span class="dot"></span>{/if}</span><span class="gm-lbl">{a.label}</span>{#if a.value}<span class="gm-val">{a.value}</span>{/if}</a>
                  {:else}
                    <button type="button" class="gm-row" class:danger={a.danger} disabled={a.disabled} aria-pressed={a.pressed} on:click={(e) => runAction(a, e)}><span class="gm-ic">{#if a.icon}<Icon name={a.icon} size={20} fill={a.pressed && a.icon === 'heart'} />{:else if a.danger}<span class="dot"></span>{/if}</span><span class="gm-lbl">{a.label}</span>{#if a.value || a.pressed}<span class="gm-val">{#if a.value}{a.value}{/if}{#if a.pressed}<Icon name="check" size={16} />{/if}</span>{/if}</button>
                  {/if}
                </li>
              {/each}
            {/each}
          </ul>
        {/if}
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
  /* the title page's round glass button (.frost-btn.round: fill, edge, highlight; solid without blur); open: the lit edge */
  .ma.ring { width: 44px; height: 44px; min-height: 44px; border-radius: 50%; display: grid; place-items: center; }
  .ma.ring.on { border-color: rgba(255,255,255,.42); box-shadow: inset 0 1px 0 var(--fr-hi), inset 0 0 0 1px rgba(255,255,255,.14); }
  .ma.labelled { flex-direction: column; gap: .3rem; background: none; border: 0; min-height: 44px; padding: .2rem .4rem; border-radius: 6px; }
  .ma.labelled .tx { font-size: .75rem; font-weight: 500; color: var(--mut); }
  .ma.labelled:hover:not(:disabled) { background: rgba(255,255,255,.08); }
  .ma.pill { background: rgba(112,124,138,.55); border-radius: 4px; padding: .6rem 1rem; gap: .5rem; }
  .ma.pill:hover:not(:disabled) { background: rgba(112,124,138,.35); }
  .ma:focus-visible { outline: 2px solid #fff; outline-offset: 2px; --ring-o: 2px; }
  :global(html:not(.tv)) .ma:focus-visible { box-shadow: 0 0 0 6px var(--ring-dark); } /* the two-tone ring (app.css) over the glass button's own edge */
  /* the desktop menu: the shared glass card and rows (app.css .gm*); placed by menuPlace (position: fixed, left / top / max-height).
     The safe scrim for white text on the light pill and .9 notes (SCRIM_MENU), as artwork or video can sit behind it */
  .pop { position: fixed; z-index: 88; box-sizing: border-box; outline: none; text-align: left; font-size: .92rem; font-weight: 400; }
  ul { list-style: none; margin: 0; padding: 0; }
  /* the slot (pickers, settings) after its own divider, the .gm-sep look */
  .pop .slot::before { content: ''; display: block; height: 1px; margin: 6px 8px; background: rgba(255,255,255,.12); }
  .pop .slot:first-child::before { display: none; }
  /* rows from nested pickers (ListMenu variant="row") line up with the menu's rows */
  .pop .slot :global(.rowbtn) { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; column-gap: 12px; align-items: center; min-height: 44px; padding: 0 12px; border-radius: 12px; font-size: 15px; font-weight: 500; line-height: 1.25; }
  .pop .slot :global(.rowbtn > svg) { justify-self: center; }
  .pop .slot :global(.rowbtn > span) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pop .slot :global(.rowbtn:hover:not(:disabled)), .pop .slot :global(.rowbtn.on), .pop .slot :global(.rowbtn:focus-visible) { background: var(--fr-sel); }
  .pop .slot :global(.rowbtn:focus-visible) { outline: 2px solid #fff; outline-offset: -2px; box-shadow: none; }
  /* phone sheet rows (unchanged: 48 px, the cancel row) */
  .ttl { margin: .35rem .7rem .45rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mi { display: flex; gap: .8rem; align-items: center; width: 100%; min-height: 44px; padding: 0 14px; border: 0; border-radius: 12px; background: transparent; color: inherit; font: inherit; font-weight: 600; text-align: left; text-decoration: none; justify-content: flex-start; }
  .mi:hover:not(:disabled), .mi:focus-visible, .mi[aria-pressed='true'] { background: var(--fr-sel); outline: none; }
  .mi:focus-visible { box-shadow: inset 0 0 0 2px #fff, inset 0 0 0 4px var(--ring-dark), 0 0 0 2px var(--ring-dark); }
  .mi:active:not(:disabled) { transform: none; }
  /* a destructive row: white text (AA on glass over any backdrop), the colour only on its icon or a dot */
  .mi.danger :global(svg) { color: var(--err-mark); } /* a light red: 3:1 on the glass over a white backdrop */
  .mi.danger .sp { display: grid; place-items: center; }
  .mi.danger .sp::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--err-mark); }
  .mi .sp { width: 20px; flex: none; }
  .chk { margin-left: auto; color: var(--ok, #4ade80); }
  .sheet .slot { border-top: 1px solid rgba(255,255,255,.1); margin-top: 6px; padding-top: 6px; }
  .sheet .slot:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
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
