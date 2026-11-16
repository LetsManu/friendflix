# Menus glass, Stage 2: desktop menus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every desktop menu (title / card / admin ⋯, account, notifications, Categories, the list picker, `Select`, toasts) has one glass look and one row anatomy, stays inside the window, opens fully loaded, one at a time, and the hover cards reveal without scaling their text.

**Architecture:** Three small pure-TS primitives come first: `placeMenu` (flip above / below, shift sideways, height cap) in `lib/popover.ts`, a one-pop-up-at-a-time registry with parent links in `lib/ui/popups.ts`, and `menuGroups` (destructive rows last, after a divider). One set of global row classes (`.gm-*` in `app.css`) carries the mockup's anatomy. `MoreActions` (and through it `ActionMenu` and the card ⋯), `ListMenu`, the `DeskBar` dropdowns and a new glass listbox behind `Select` move onto them. The hover cards swap their FLIP zoom for a crossfade plus a capped translate, which removes the last two TEMPORARY `motionRule` entries of this stage.

**Tech Stack:** SvelteKit (Svelte 5, legacy `$:` components), TypeScript, vitest (pure-TS units in Node, no DOM library; `.svelte` files are covered by e2e), Playwright e2e with the mock API (`e2e/mocks`).

**Spec:** `docs/superpowers/specs/2026-11-15-menus-glass-design.md` (stage 2 of "Order of work", goals 1–6). Look to build: board 1 of the approved mockup, `/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/menumock/project/Main.dc.html` (poster ⋯, account, admin ⋯; its CSS `.mh` / `.mi` / `.val` / `.sep` is the anatomy). Audit with every surface and file: `/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/menu-audit/report.md` (screenshots `shots/desk-*`). Stage 1 (merged on `claude/menus-glass`, work on a branch from it): `docs/superpowers/plans/2026-11-15-menus-glass-stage1.md`.

## Global Constraints

- Animate only transform and opacity.
- No scale() on text.
- Nothing jumps.
- 44 px targets (36 px for mouse-only small buttons).
- 7 locales (de, en, es, fr, it, pl, tr) identical key order.
- Never "Netflix"/"Seerr".
- Placeholder hosts/names only.
- No new UI dependency.
- Agents run only typecheck + specific specs + `npm run build -w web`:
  - typecheck: `cd web && npx svelte-kit sync && npx svelte-check --threshold error` (0 errors) and `npx tsc --noEmit -p e2e`;
  - units: `cd web && npx vitest run <files>`;
  - e2e: from `e2e/`, `E2E_PORT=<free> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off`;
  - build: `npm run build -w web` (repo root).
- Web coverage gate ≥ 94 % statements: every new `.ts` module ships with unit tests that cover all of its statements (check with `cd web && npx vitest run --coverage --coverage.include=<new files> <their tests>`; never run the whole suite).
- Commits with the session trailer, exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- From stage 1, still binding: motion only through the `lib/glass/fx.ts` tokens (menus `growBoth`, 220 / 150 ms, 8 px); calm mode / reduced motion instant, a tripped frame guard opacity only; never `git stash`; merge, never rebase.
- TV (`html.tv`) and the phone sheet (`asSheet`, coarse pointer, ≤ 600 px) keep their current look in this stage (stages 3 and 5); the new rules apply to the desktop popover only.

## Review Focus

1. **A `Select` inside a dialog** (delete role, merge, new role): Escape closes only the listbox, the dialog stays open and the focus returns to the select (Task 4 test `Escape inside a dialog closes only the listbox`).
2. **Existing specs that click a select and then `selectOption`** (129 calls in 31 specs): the glass listbox must close when the value changes from outside, or it covers the next click (Task 4 test `selectOption still works and closes an open listbox`).
3. **The window shrinks while a menu is open** (1440 → 1000 px): the menu is placed again inside the window, it never hangs off the edge (Task 2 test `a resize keeps the open menu inside the window`).
4. **`/api/profiles` fails or is slow:** the account menu still opens, its reserved profile rows are replaced in place (same height) or removed, the avatar's spinner ends (Task 3 tests `the profile rows hold their place while they load` and `a failed profile list still opens the menu`).
5. **A hover card closed mid-reveal:** it fades out from where it is, never jumps back to full opacity first (Task 5 test `closing mid-reveal fades from where it is`).

---

### Task 1: Placement, one pop-up at a time, anchor scroll (pure TS)

**Files:**
- Modify: `web/src/lib/popover.ts` (add; keep `placePopover` / `placedStyle` for `admin/NoteTip.svelte`)
- Create: `web/src/lib/ui/popups.ts`
- Test: `web/src/lib/popover.test.ts`, `web/src/lib/ui/popups.test.ts`

**Interfaces:**
- Produces in `popover.ts`:
  - `export const MENU_MARGIN = 8; export const MENU_GAP = 6;`
  - `export interface MenuPlace { left: number; top: number; maxHeight: number; up: boolean }`
  - `export function placeMenu(trigger: Box, size: { w: number; h: number }, vp: { w: number; h: number }, o?: { up?: boolean; align?: 'start' | 'end' }): MenuPlace`. Horizontal: `align` defaults to `'end'` when the trigger's centre is in the right half of the window, else `'start'`; `'end'` aligns right edges (`left = trigger.right - w`), `'start'` left edges; then shift into `[MENU_MARGIN, vp.w - MENU_MARGIN - w]` (if `w > vp.w - 16`, `left = 8`). Vertical: `below = vp.h - trigger.bottom - GAP - MARGIN`, `above = trigger.top - GAP - MARGIN`; `up = o.up ? (above >= h || above >= below) : (below < h && above > below)`. Down: `top = trigger.bottom + GAP`, `maxHeight = below`. Up: `maxHeight = above`, `top = trigger.top - GAP - min(h, above)`. All values rounded to whole px.
  - `export const menuPlaceStyle = (p: MenuPlace): string` → `left:${l}px;top:${t}px;max-height:${m}px;`.
  - `export function anchorMoved(before: { left: number; top: number }, after: { left: number; top: number }, tol = 2): boolean` (true when either axis moved more than `tol` px).
- Produces in `ui/popups.ts`:
  - `export interface PopupHandle { readonly id: number; release(): void }`
  - `export const POPUP_CTX: unique symbol` (Svelte context key; the value is `() => PopupHandle | null`, so a pop-up opened inside another one finds its parent).
  - `export function openPopup(close: () => void, parent?: PopupHandle | null): PopupHandle`: first calls `close` of every open pop-up that is not `parent` or one of its ancestors (deepest first), then registers the new one.
  - `release()`: removes the handle and closes (deepest first) and removes its descendants; idempotent; a `close` callback that calls `release()` again is harmless (remove before calling).
  - `export function closeAllPopups(): void` (deepest first); `export function openPopups(): number`.

- [ ] **Step 1: Failing tests.**
  - `popover.test.ts`, `describe('placeMenu')`, vp 1440×900, size `{w: 264, h: 300}` unless stated:
    - `opens below, right-aligned, for a trigger in the right half`: trigger `{left:1300,right:1344,top:100,bottom:144,width:44}` → `{left:1080,top:150,maxHeight:742,up:false}`;
    - `left-aligned for a trigger in the left half`: trigger left 40 / right 84 → `left: 40`;
    - `shifts inside the right edge`: trigger left 1400 / right 1440, `align:'start'` → `left: 1168`;
    - `flips above near the bottom`: trigger top 800 / bottom 844 → `{up:true, top:494, maxHeight:786}`;
    - `prefers above when asked and it fits`: trigger top 500 / bottom 544, `up:true` → `up: true, top: 194`;
    - `a short window caps the height and never leaves it`: vp 1100×400, trigger top 180 / bottom 224, h 600 → `up: true`, `top >= 8`, `top + maxHeight <= 392`;
    - `whole pixels`: a trigger at fractional coordinates gives integers, and `menuPlaceStyle` prints `left:…px;top:…px;max-height:…px;`;
    - `anchorMoved`: `{0,0}→{0,2}` false, `{0,0}→{0,3}` true, `{0,0}→{-3,0}` true.
  - `popups.test.ts` (reset with `closeAllPopups()` in `afterEach`):
    - `opening a second pop-up closes the first`;
    - `a child keeps its parent open`;
    - `a sibling of a child closes the child and keeps the parent`;
    - `releasing a parent closes its children first`: record the close order, expect `['child', 'parent']`, where only the child's close is called by `release`;
    - `closeAllPopups closes everything, deepest first, and leaves none` (`openPopups() === 0`);
    - `release is idempotent, even from inside close`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/popover.test.ts src/lib/ui/popups.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same command. Expected: PASS. Coverage of `popups.ts` and the new `popover.ts` code: 100 % statements.
- [ ] **Step 5: Commit** `feat(ui): menus place themselves inside the window and only one pop-up opens at a time`.

### Task 2: One menu anatomy; the ⋯ menus on it (MoreActions, ActionMenu, card ⋯, ListMenu)

**Files:**
- Modify: `web/src/app.css` (the `.gm*` classes, beside the glass rules)
- Create: `web/src/lib/ui/menuGroups.ts`, `web/src/lib/ui/menuGroups.test.ts`
- Modify: `web/src/lib/MoreActions.svelte`, `web/src/lib/ui/ActionMenu.svelte`, `web/src/lib/ListMenu.svelte`, `web/src/lib/hoverShared.ts` (`previewActions`), `web/src/routes/+layout.svelte` (`afterNavigate(() => closeAllPopups())`)
- Test: `e2e/tests/desk-menus.spec.ts` (create)

**Interfaces:**
- Consumes: `placeMenu`, `menuPlaceStyle`, `anchorMoved`, `openPopup`, `POPUP_CTX`, `closeAllPopups` (Task 1); `menuMove` / `moveIndex` (`lib/ui/menuKeys.ts`).
- Produces:
  - `export function menuGroups<T extends { danger?: boolean; tail?: boolean }>(items: readonly T[]): T[][]`: `[head]` or `[head, tail]`, empty groups dropped. `tail` holds the items with `tail` or `danger`; inside it the non-danger ones come first, then the danger ones; order otherwise stable.
  - `MoreAction` gains `tail?: boolean` (a removal that is not destructive, after the divider, white) and `value?: string` (trailing value text).
  - Global classes in `app.css` (from the mockup; the `--fr-*` tokens win where they differ):
    - `.gm`: the desktop menu card with `frost frost-menu frost-safe`: `padding: 6px; width: max-content; min-width: 220px; max-width: min(320px, calc(100vw - 16px)); overflow-y: auto; overscroll-behavior: contain`;
    - `.gm-head`: header line, `padding: 10px 12px 8px`, 13 px / 1.2, weight 700, `rgba(255,255,255,.9)`, one line with ellipsis;
    - `.gm-row`: `display: grid; grid-template-columns: 24px minmax(0,1fr) auto; column-gap: 12px; align-items: center; min-height: 44px; padding: 0 12px; border-radius: 12px; font: 500 15px/1.25 inherit-family; color: #fff; text-align: left; width: 100%; box-sizing: border-box`. Hover, `:focus-visible` and `[aria-pressed='true']` / `[aria-checked='true']` get `background: var(--fr-sel)`. Focus is one ring: `outline: 2px solid #fff; outline-offset: -2px; box-shadow: none` (this replaces the triple ring);
    - `.gm-ic`: 24 px box, icon centred (20 px icons);
    - `.gm-val`: trailing value / check / chevron, `rgba(255,255,255,.9)`, 14 px, `font-variant-numeric: tabular-nums`, flex, gap 6 px;
    - `.gm-sep`: `height: 1px; margin: 6px 8px; background: rgba(255,255,255,.12); border: 0`;
    - `.gm-row.danger .gm-ic { color: var(--err-mark) }`. The label stays white: `#ff9d9d` is only 3.3:1 on menu glass over white, so AA keeps the colour on the icon.
  - `MoreActions` popover (not the sheet):
    - classes `pop ma-pop gm frost frost-menu frost-safe`, `role="dialog"` unchanged (62 e2e locators and slot content depend on it);
    - `title` renders as `.gm-head`;
    - rows are `.gm-row`, each with `.gm-ic` (icon, or empty; a danger row without an icon keeps its dot), the label `<span>`, `.gm-val` (`value`, or the check for `pressed`);
    - `menuGroups(actions)` with an `<li class="gm-sep" role="separator">` between groups;
    - the slot keeps its divider (`.gm-sep` look).
  - Placement: a `use:` action on the popover measures `offsetWidth` / `offsetHeight` on mount and writes `menuPlaceStyle(placeMenu(btn rect, size, window, { up }))` synchronously, before the intro reads the box (so `growShift` sees the final place). Resize re-places.
  - A scroll (capture) outside the panel closes the menu (`close(false)`) when `anchorMoved(rect at open, rect now)`.
  - `show()` calls `openPopup(() => close(false), getContext(POPUP_CTX)?.() ?? null)` and sets `POPUP_CTX` for its slot; `close()` releases.
  - Keys: ArrowUp / ArrowDown / Home / End move through the rows (`menuMove`, `moveIndex`). They are not taken while a text input has the focus.
  - `ActionMenu`: its `:global(.ma.ring)` override goes. The admin ⋯ is the title page's `.ma.ring`: 44 px circle, `rgba(42,42,42,.6)` fill, 2 px `rgba(255,255,255,.5)` border, `#fff` border on hover / open. Its busy button copies that look.
  - `ListMenu` popover: `placeMenu` (with `wide` row variant → `min-width` = trigger width), `openPopup` with the `POPUP_CTX` parent (inside a MoreActions slot it is a child), close on anchor scroll like MoreActions.
  - `previewActions`: the `remove` item gets `tail: true`.

- [ ] **Step 1: Failing unit tests** `menuGroups.test.ts`: `no tail: one group`, `danger rows go last, after the others`, `tail rows without danger come before danger rows`, `only tail rows: one group`, `empty: no groups`.
- [ ] **Step 2: Failing e2e** `e2e/tests/desk-menus.spec.ts`, 1440×900, default (reduced) motion. Admin role row setup: copy the "Oma" splice from `motion-frames.spec.ts`. Hover card helper: `openPopout` from `e2e/helpers.ts`.
  - `title ⋯ and admin ⋯ look the same`: computed `width, height, borderTopWidth, borderTopColor, backgroundColor, borderRadius` of `.ma.ring` on `/item/${MOVIE.id}` deep-equal those of the "Aktionen für Oma" trigger on `/admin/roles`.
  - `card ⋯ menu: header, 44 px rows, 24 px icon column, the removal last after a divider, one line each`:
    - open the hover card on the first card of `row(page, 'Weiterschauen')` and click "Mehr Aktionen für …";
    - in `.ma-pop`, `.gm-head` has the item's name;
    - every `.gm-row` box height is 44 ± 0.5 and every `.gm-ic` width 24 ± 0.5;
    - the last row reads "Aus Weiterschauen entfernen" and its preceding element has class `gm-sep`.
  - `admin ⋯ menu: destructive last after a divider; label white, icon light red`:
    - on the Oma row, the last `.gm-row` has class `danger` and follows a `.gm-sep`;
    - its label's computed colour is `rgb(255, 255, 255)`; its svg colour is `rgb(255, 157, 157)`.
  - `keys: ArrowDown wraps, Home / End, Escape gives the focus back to ⋯`.
  - `stays inside the window near the bottom and right edges`:
    - viewport 1100×700;
    - the last role row scrolled to the window's bottom (`scrollIntoView({ block: 'end' })`), then its ⋯ opened;
    - `boxInViewport(page, page.locator('.ma-pop'))` is ok, and the menu's bottom ≤ the trigger's top (it flipped up);
    - repeat on the title page ⋯ at 1440×900: inside.
  - `a resize keeps the open menu inside the window`: open the title ⋯, `setViewportSize({ width: 1000, height: 700 })`, then `boxInViewport` ok.
  - `scrolling the page under an admin ⋯ menu closes it; an outside press closes it`: `mouse.wheel(0, 300)` → `.ma-pop` count 0; reopen, click the page heading → count 0.
  - `one pop-up at a time`: open the title ⋯, click the header avatar → `.ma-pop` count 0, and the "Profilmenü" menu is visible.
  - `the list picker inside a ⋯ menu keeps its parent open`: on the title page ⋯, open the slot's list row (`getByRole('button', { name: /Zu Liste hinzufügen/ })`: Task 6 changes its ellipsis) → `.lm-pop` and `.ma-pop` both visible.
  - `a route change closes the menu`: open the title ⋯, `page.goBack()` → `.ma-pop` count 0.
- [ ] **Step 3: Run** `npx vitest run src/lib/ui/menuGroups.test.ts` and the new spec. Expected: FAIL.
- [ ] **Step 4: Implement** as specified. Match the mockup's `.mi` / `.mh` / `.sep` for anything the interface leaves open. The phone sheet branch keeps its 48 px rows and its cancel row.
- [ ] **Step 5: Run** the unit test, `desk-menus.spec.ts`, then `glass-menus.spec.ts`, `motion-frames.spec.ts`, `admin-roles.spec.ts`, `lists.spec.ts`, `desk-preview.spec.ts`, `popout.spec.ts`, `desk-detail.spec.ts` and `glass-menus.mobile.spec.ts` (the sheet must be unchanged). Expected: PASS. Update only assertions of the old look (row padding, triple ring, ActionMenu border), and say which in the commit body.
- [ ] **Step 6: Commit** `feat(ui): one glass menu anatomy; ⋯ menus place themselves, close on scroll, one at a time`.

### Task 3: Header menus: account, notifications, Categories

**Files:**
- Modify: `web/src/lib/desk/DeskBar.svelte`
- Modify: `web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/shell.ts` (one key)
- Test: `e2e/tests/desk-menus.spec.ts` (extend), `e2e/tests/desk-bar.spec.ts` (keep passing)

**Interfaces:**
- Consumes: `.gm*` classes (Task 2), `openPopup` / `closeAllPopups` (Task 1).
- New key `shell.account.switchProfile`, right after `withPin` in all seven files:
  - de 'Profil wechseln', en 'Switch profile', es 'Cambiar de perfil', fr 'Changer de profil';
  - it 'Cambia profilo', pl 'Zmień profil', tr 'Profil değiştir'.
- Account menu (`.drop.acct`, stays `role="menu"` with `menuKeys`, `.gm`, `min-width: 280px`), top to bottom:
  - header block: the 44 px face, `who` (16 px / 700), and below it `me.name · me.roleLabel` (13 px, `.9` white); `.gm-sep`;
  - with `multi`:
    - `.gm-head` `switchProfile`;
    - the active profile as `role="menuitemradio" aria-checked="true"` with the check in `.gm-val` (it only closes);
    - the others as `menuitemradio` `aria-checked="false"`, the lock in `.gm-val` for `hasPin`;
    - then "Profile bearbeiten"; `.gm-sep`;
  - Mein Bereich, Einstellungen, Geräte, Downloads, Überrasch mich, Hilfe, Admin; `.gm-sep`;
  - `changeServer` (icon `refresh`) when `lgApp`;
  - logout (icon `log-out`), left-aligned like every row (the `.acct .out` centring goes).
- No half-loaded account menu:
  - the profile list loads on the avatar's `pointerenter` / `focus` (and on click if not yet);
  - while it loads, the menu shows `min(4, max(0, (me.profileCount ?? 1) - 1))` reserved `.gm-row.skel` rows (`aria-hidden`, 44 px; an opacity shimmer only, or none in calm);
  - the rows are replaced in place; on failure they go;
  - `shell.account.loadingProfiles` is no longer rendered; delete the key from all seven locales if nothing else uses it.
- Notifications (`.drop.wide`, a region, not a menu):
  - `.gm` with a `.gm-head` (`shell.bell.label`);
  - each note a `.gm-row`: a link when it has one, else a non-interactive div;
  - unread notes have an 8 px `--acc-fill` dot in `.gm-ic`, read ones an empty icon cell and `.9` white text;
  - labels may wrap (min-height 44); the empty state is one `.gm-row` with `shell.bell.empty`.
- Categories (a region): the layout stays.
  - Genres and languages load on the button's `pointerenter` / `focus`.
  - A click while they load sets `aria-busy="true"` on the button, with a spinner in the caret's place, and opens the drop only once both have settled (failure → the existing "none" texts). The `common.loading` lines inside the drop go.
- Each dropdown that opens calls `openPopup` with a close that clears `menu`, `bell` and `cats`, and releases on close; opening a ⋯ menu or a `Select` therefore closes them, and the reverse.

- [ ] **Step 1: Failing e2e** in `desk-menus.spec.ts` (`describe('header menus')`):
  - `account menu: the person in the header, 44 px rows with a 24 px icon column; Abmelden last, with its icon, left-aligned like the rest`:
    - the header shows the profile name and `me.name`;
    - every `.gm-row` is 44 ± 0.5 high;
    - the logout row has an `svg` in `.gm-ic`;
    - its label's left x equals the "Mein Bereich" label's left x (± 1).
  - `the profile rows hold their place while they load`:
    - `/api/me` with `profileCount: 3`, `/api/profiles` with `PROFILES` from `e2e/mocks/api.ts` delayed 600 ms by `page.route`;
    - click the avatar at once;
    - the menu's height right after opening equals its height after the rows arrive (± 1); "Anna" and "Ben" are `menuitemradio`; "Tester" is `aria-checked="true"`.
  - `a failed profile list still opens the menu`: `/api/profiles` 500 → the menu is visible, no `.skel` rows remain, and the avatar has no `aria-busy`.
  - `notifications: a header line, unread rows marked, rows 44 px`: with the mock's notes, `.gm-head` reads "Benachrichtigungen" and every unread row has the dot.
  - `Categories never opens half-loaded`:
    - genres delayed 500 ms;
    - click "Kategorien" → the button has `aria-busy="true"` and `#ff-cats` is absent;
    - then `#ff-cats` is visible with genre links and no `[role=status]` loading line.
  - `Categories stays inside the window at 1100 and 900 px`: `boxInViewport` ok at both widths.
  - `one pop-up at a time across the bar`: open the bell, then the title ⋯ (on `/item/…`) → `#ff-notes` count 0; open the account menu → `.ma-pop` count 0.
- [ ] **Step 2: Run** the spec. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Keep the existing Escape, Tab-out, outside-click and path-change closing.
- [ ] **Step 4: Run** `desk-menus.spec.ts`, `desk-bar.spec.ts`, `glass-menus.spec.ts`, `motion-frames.spec.ts`, `i18n.spec.ts`, and `cd web && npx vitest run src/lib/i18n` (key parity tests). Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): account, notifications and Categories menus share the glass anatomy and never open half-loaded`.

### Task 4: `Select` opens a glass listbox on desktop

**Files:**
- Create: `web/src/lib/ui/listbox.ts`, `web/src/lib/ui/listbox.test.ts`, `web/src/lib/ui/GlassListbox.svelte`
- Modify: `web/src/lib/ui/Select.svelte`
- Test: `e2e/tests/desk-menus.spec.ts` (extend), `e2e/tests/admin-people.mobile.spec.ts` (one guard)

**Interfaces:**
- Consumes: `MenuMove` (`menuKeys.ts`), `placeMenu` / `menuPlaceStyle` / `anchorMoved` / `openPopup`, `.gm*`, `growBoth`.
- Produces in `listbox.ts`:
  - `export interface ListOpt { value: string; label: string; disabled?: boolean }` (`SelectOption` is assignable to it);
  - `export function nextEnabled(opts: readonly ListOpt[], from: number, move: MenuMove): number`: next / prev skip disabled options and stop at the ends (no wrap, as in a native select); first / last pick the first / last enabled option; -1 if none is enabled;
  - `export function typeahead(opts: readonly ListOpt[], buffer: string, from: number): number`: the first enabled option after `from` (wrapping) whose label starts with `buffer`, case- and accent-insensitive (`normalize('NFD')` without combining marks, `toLocaleLowerCase`); -1 if none;
  - `export function wantsGlassList(env: { tv: boolean; coarse: boolean; hover: boolean }): boolean`: `!tv && !coarse && hover`.
- `GlassListbox.svelte` (props `anchor: HTMLSelectElement`, `options: ListOpt[]`, `value: string`, `labelledby: string`; events `pick: string`, `close: void`):
  - portaled to `<body>`; `class="gm frost frost-menu frost-safe"`, `role="listbox"`, `aria-labelledby`, `tabindex="-1"`;
  - takes the focus and moves an `aria-activedescendant`; each row is a `.gm-row` `role="option"` with `aria-selected`, the check in `.gm-ic` for the current value, disabled options `aria-disabled`;
  - `min-width` = the select's width; placed by `placeMenu(…, { align: 'start' })` like Task 2;
  - z-index above `ModalShell`'s layer (read it there);
  - closes on an anchor scroll or an outside press, via `openPopup`;
  - keys: ArrowUp / ArrowDown / Home / End move (`nextEnabled`), Enter or Space picks, printable keys typeahead with a 500 ms buffer;
  - Escape closes with `stopPropagation` and gives the focus back to the select; Tab closes without picking.
- `Select.svelte`:
  - the native `<select>` stays the control (form value, `bind:value`, `on:change`, Playwright `selectOption`, TV, phone);
  - when `wantsGlassList(...)` (from `html.tv` and `matchMedia('(hover: hover) and (pointer: fine)')`) and not disabled:
    - a primary-button `mousedown` → `preventDefault()`, focus the select, toggle the listbox;
    - `keydown` Space, Enter, F4, Alt+ArrowDown or Alt+ArrowUp → `preventDefault()` and open;
  - a pick sets `select.value` and dispatches bubbling `input` and `change` events (in that order);
  - an `input` / `change` the listbox did not cause closes it;
  - the label gets `id="{id}-l"` for `labelledby`.
- Raw `<select>` elements outside `Select.svelte` are not touched in this stage.

- [ ] **Step 1: Failing unit tests** `listbox.test.ts`:
  - `nextEnabled skips disabled options and stops at the ends`;
  - `first and last pick the outermost enabled options`;
  - `no enabled option gives -1`;
  - `typeahead is case- and accent-insensitive, starts after the current and wraps` ("ö" finds "Österreich", "a" from the last "A…" wraps to the first);
  - `wantsGlassList only on a desktop pointer, never on TV`.
- [ ] **Step 2: Failing e2e** in `desk-menus.spec.ts` (`describe('Select')`, admin, `/admin/users`, `getByRole('combobox', { name: 'Rolle', exact: true })`):
  - `a click opens a glass listbox: 44 px options, the current one checked, inside the window`:
    - `[role=listbox]` has class `frost`;
    - each `[role=option]` is 44 ± 0.5 high;
    - one option has `aria-selected="true"`;
    - `boxInViewport` ok.
  - `keys: Space opens, End and ArrowUp move, Enter picks and fires change`: after Enter the combobox has the picked value, the listbox is gone, the focus is on the combobox, and the table shows the filtered rows as `admin-people.spec.ts` expects for that role.
  - `near the window's bottom it opens upward`: viewport 1100×600, the select scrolled to the bottom edge → listbox bottom ≤ select top.
  - `Escape inside a dialog closes only the listbox`: the Oma delete dialog (as in `motion-frames.spec.ts`), open its `Select` → Escape → `[role=listbox]` count 0, `[role=alertdialog]` visible, the select focused.
  - `selectOption still works and closes an open listbox`: click to open, `selectOption('guest')` → value `guest`, listbox count 0.
  - In `admin-people.mobile.spec.ts`: `phone keeps the native select` (tap the role filter → `[role=listbox]` count 0).
- [ ] **Step 3: Run** the unit test and both specs. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the unit test, `desk-menus.spec.ts`, `admin-people.spec.ts`, `admin-people.mobile.spec.ts`, `admin-roles.spec.ts`, `admin-settings.spec.ts`, `admin-livetv-channels.spec.ts`, `dialogs.spec.ts`. Expected: PASS without changing their `selectOption` calls.
- [ ] **Step 6: Commit** `feat(ui): selects open a glass list on desktop; phones and TV keep the native picker`.

### Task 5: Hover cards reveal without scaling (HoverPreview, DeskPreview)

**Files:**
- Modify: `web/src/lib/glass/fx.ts`, `web/src/lib/HoverPreview.svelte` (the `el.animate` in `onMount`), `web/src/lib/desk/DeskPreview.svelte` (`grow` in `onMount`, `leave()`, the `org` transform-origin bookkeeping)
- Modify: `web/src/lib/ui/motionRule.test.ts` (delete the three `HoverPreview` / `DeskPreview` TEMPORARY keys)
- Test: `web/src/lib/glass/fx.test.ts`, `e2e/tests/desk-preview.spec.ts`, `e2e/tests/kids.spec.ts` or `popout.spec.ts` (whichever drives `HoverPreview`: `Card.svelte` uses it off the desktop browse layout with a fine pointer, e.g. the kids UI)

**Interfaces:**
- Produces in `fx.ts`:
  - `export const REVEAL_PX = 12; export const REVEAL_IN_MS = 220; export const REVEAL_OUT_MS = 150;`
  - `export function revealShift(card: DOMRectLike, box: DOMRectLike): Shift`: the start offset of the card that appears over its source card. It points from the box's centre toward the card's centre (the FLIP direction is kept). Its length is `min(REVEAL_PX, distance)`, rounded per axis to whole px; `{x:0,y:0}` when the centres meet.
  - `export function revealKeyframes(shift: Shift, dir: Dir): Keyframe[]`:
    - in: `[{ transform: 'translate(${x}px, ${y}px)', opacity: 0 }, { transform: 'translate(0px, 0px)', opacity: 1 }]`;
    - out: the same two frames reversed.
- Motion:
  - Opening: full motion `el.animate(revealKeyframes(revealShift(cardRect, box), 'in'), { duration: REVEAL_IN_MS, easing: EMPH_OUT })` with `watchFrames()`; reduced: opacity 0 → 1 over `REDUCED_MS`; still: none. `HoverPreview` follows the same rules (its start opacity .4 becomes 0).
  - Closing (`DeskPreview.leave`): toward the card's current rect (it may have scrolled) with `revealKeyframes(…, 'out')`, `REVEAL_OUT_MS`, `GLASS_IN`, `fill: 'forwards'`.
  - Mid-reveal: read the computed `opacity` and `transform` (a pure translate), cancel the reveal, and animate from those values to the out frame.
  - No `scale` anywhere in either file's animations; `org` / `transform-origin` go if nothing else needs them.

- [ ] **Step 1: Failing tests:**
  - `fx.test.ts`:
    - `revealShift points from the preview toward its card, at most 12 px`: card centre 100 px left of and 0 px above the box centre → `{x:-12,y:0}`;
    - `revealShift is zero when centred`;
    - `revealShift whole px on a diagonal`: |x|, |y| integers, length ≤ 12;
    - `revealKeyframes never scale and land at no offset`: no frame matches `/scale|matrix/`; in ends at opacity 1 and `translate(0px, 0px)`;
    - `out mirrors in`.
  - `desk-preview.spec.ts` (full motion):
    - replace `closing mid-grow shrinks from where it is (no jump to full size)` with `closing mid-reveal fades from where it is`: same in-page harness, sampling `opacity` and the `DOMMatrix` of `.dpv`. The first sample's opacity is < 1, every later one ≤ first + 0.02, and every matrix has `a === 1 && d === 1`;
    - rename `closing shrinks back (full) and is instant in calm` to `closing fades back (full) and is instant in calm` (same assertion: a running animation is seen).
  - In the `HoverPreview` spec: `the pop-out reveals without scaling` → `textScaleDuring(page, '.hp', () => card.hover(), 700)` < 0.001.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/glass/fx.test.ts src/lib/ui/motionRule.test.ts` and the two e2e specs. Expected: FAIL (`revealShift` missing; motionRule reports the three deleted keys' findings; the frames check fails).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same commands plus `popout.spec.ts`. Expected: PASS. `motionRule` passes with the three keys gone (their findings no longer exist).
- [ ] **Step 5: Commit** `fix(ui): hover cards fade in from their card instead of zooming their text`.

### Task 6: Toasts and menu copy

**Files:**
- Modify: `web/src/lib/ui/ToastHost.svelte` (type and spacing only)
- Modify: `web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/{detail,player,fresh,adminContent}.ts`
- Create: `web/src/lib/i18n/ellipsis.test.ts`
- Test: `e2e/tests/desk-menus.spec.ts` (extend)

**Interfaces:**
- Toast:
  - `.toast` padding `4px 4px 4px 20px`, gap 12 px;
  - `.msg` 15 px, weight 600, line-height 1.3 (the mockup);
  - min-height 52 px, ✕ and action 44 px, the pill radius and motion unchanged.
  - Toasts stay out of the pop-up registry (status, not pop-ups): opening a menu never closes a toast.
- Copy: a menu or action label that opens more input ends in "…" with no space before it (the mockup's "Rolle ändern…"). Every locale value of these keys:
  - `detail.lists.addMore`;
  - `player.subs.searchMenu`;
  - `fresh.admin.menu`;
  - `adminContent.hygiene.search` (the audit's "Titel oder Serie suchen …").

  Status texts ("Lade …") stay for stage 6. No key is added or moved.

- [ ] **Step 1: Failing tests:**
  - `ellipsis.test.ts` (imports the seven `locales/*/index` like `i18n.test.ts`):
    - `no locale string uses three ASCII dots`: walk every string value; none matches `/\.\.\./`;
    - `menu labels glue their ellipsis`: for the four keys in all seven locales, the value matches `/\S…$/`.
  - `desk-menus.spec.ts` `describe('toasts')`:
    - `a long toast wraps inside the window with 44 px controls`: viewport 1100×700; in the `api` fixture, lengthen the approval title used by `motion-frames.spec.ts` ('Dunmoor: Part Two') to about 90 characters of placeholder words; approve it;
    - then `boxInViewport(page, page.locator('.toast'))` is ok, the ✕ is 44×44, and its vertical centre is within 1 px of the toast's;
    - `the message is 15 px / 600`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/i18n/ellipsis.test.ts` and the spec. Expected: FAIL.
- [ ] **Step 3: Implement** the CSS and the 28 string edits (4 keys × 7 locales; Italian already glues two of them).
- [ ] **Step 4: Run** the unit test, `cd web && npx vitest run src/lib/i18n`, `desk-menus.spec.ts`, `glass-menus.spec.ts` (toast look tests), `lists.spec.ts` and `admin-hygiene.spec.ts` (they may match the old label text: update to "…"). Expected: PASS.
- [ ] **Step 5: Commit** `fix(ui): toasts set like the menus; menu labels end in a proper ellipsis`.

### Task 7: Frames, docs and CHANGELOG

**Files:**
- Modify: `e2e/tests/motion-frames.spec.ts`
- Modify: `docs/ui-kit.md` (section "Motion of pop-ups" and a new "Menus" section), `CHANGELOG.md` (`[Unreleased]` → `### Look and feel`)

**Interfaces:**
- Consumes: `textScaleDuring`, `watchTextScale`, `stableBox` (`e2e/frames.ts`) and the spec's `fullMotion`.

- [ ] **Step 1: Write** in `motion-frames.spec.ts` (full motion, `LIMIT = 0.001`; open and close where the surface closes, `frames > 0`):
  - `the notifications and Categories dropdowns`;
  - `the card ⋯ menu inside the hover card`;
  - `the hover card itself, open and close` (`.dpv`, opened by hover, closed by Escape);
  - `the Select listbox` (`[role=listbox]`);
  - `the admin ⋯ menu; the page heading does not move` (`stableBox` of `main h1` before and after open equal).

  They must PASS on the branch. To see one bite, locally put `scale(.96)` into `revealKeyframes`' first frame, watch the hover card case FAIL, and restore it without committing.
- [ ] **Step 2: Docs.**
  - `docs/ui-kit.md` "Menus":
    - the `.gm*` anatomy (44 px rows, 24 px icon column, trailing value, header line, dividers, destructive last with the light-red icon and white label for AA);
    - `placeMenu` (flip, shift, height cap) and `anchorMoved` closing;
    - `lib/ui/popups.ts` (one at a time, `POPUP_CTX` for nested pickers, `closeAllPopups` on navigation);
    - `menuGroups`;
    - no half-loaded menus (prefetch on hover / focus, reserved rows, a busy trigger);
    - `Select`'s glass listbox (desktop only; the native select stays the control).
  - "Motion of pop-ups": add `REVEAL_*` / `revealShift` / `revealKeyframes` to the token table and drop `HoverPreview` / `DeskPreview` from the temporary exceptions.
  - CHANGELOG bullet: "**Desktop menus look and behave alike.** The title, card and admin ⋯ menus, the profile menu, notifications, Categories, the list picker and drop-down fields are the same glass card: a header line, 44 px rows with their icons in one column, values on the right, dividers, and removing or deleting always last. They open next to their button inside the window (above it near the bottom), close on Escape, a click elsewhere, scrolling or going to another page, only one is open at a time, and they never open half-loaded. Drop-down fields on desktop open a glass list instead of the system one. Hover cards fade in from their card instead of zooming their text. *Abmelden* has its icon, menu labels end in a proper „…“ and the admin ⋯ button looks like the one on title pages."
- [ ] **Step 3: Run**
  - `motion-frames.spec.ts`;
  - `desk-menus.spec.ts`;
  - `cd web && npx svelte-kit sync && npx svelte-check --threshold error` (0 errors);
  - `npx tsc --noEmit -p e2e`;
  - `cd web && npx vitest run src/lib/popover.test.ts src/lib/ui src/lib/glass src/lib/i18n/ellipsis.test.ts`;
  - the coverage check of the new modules (Global Constraints);
  - `npm run build -w web`.

  Expected: PASS, and ≥ 94 % statements for `popups.ts`, `menuGroups.ts`, `listbox.ts` and the new `popover.ts` / `fx.ts` code.
- [ ] **Step 4: Commit** `test(ui): frames pin the desktop menus and hover cards; docs and changelog`.

---

Later stages keep their own plans (stage 1 plan, last section): phone sheets (3; the `MoreActions` sheet rows, raw `<select>` in the detail sheet), player and Live TV menus (4), TV menus (5), audit leftovers (6; the half-empty search sheet and its *Alle Ergebnisse* row, which the spec's stage-2 list does not name; status-text ellipses; the remaining TEMPORARY `motionRule` keys).
