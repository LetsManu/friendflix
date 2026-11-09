# UI kit (`web/src/lib/ui`) and admin shell (`web/src/lib/admin`)

One set of building blocks for consumer and admin pages. Everything uses the tokens in `app.css` (`--surface`, `--line`,
`--ok/--warn/--err/--info` and their `--tone-*` backgrounds, `--danger`), the `Icon` set, 44px touch targets, the global
focus ring (two-tone: a white outline with a dark companion, `--ring-dark`, so it shows on bright artwork and light glass; a
component that moves the ring sets `--ring-o`, one with its own shadow restates the companion; TV: its own bigger ring) and
the menu keys of `ui/menuKeys.ts` on every `role="menu"` popup, and respects `prefers-reduced-motion` (CSS rule in `app.css`; Svelte transitions use
`dur()` from `ui/motion.ts`). All texts come from the i18n area `ui` (7 languages).

## Colour tokens

Defined in `web/src/app.css`; components prefer the tokens; one-off shades only for gradients and overlays.

| Token | Value | Use |
|---|---|---|
| `--bg` / `--bg-deep` | `#101418` / `#000` | page background (blue-black) / player and intro |
| `--surface`, `--card` | `#161b21` | panels, cards, menus |
| `--surface-2` | `#242b33` | raised surfaces, badges, inputs hover |
| `--line` | `#2a323b` | borders and dividers |
| `--fg` / `--mut` | `#f5f5f5` / `#b3bac2` | text / secondary text (9:1 on `--bg`) |
| `--acc` | `#ff4f6d` (coral) | accent for text, rings, progress bars, focus glow (5.8:1 on `--bg`) |
| `--acc-hover` | `#e63e5c` | hover for accent-coloured text and links |
| `--acc-fill`, `--acc-fill-hover` | `#d6325a`, `#c9304d` | **filled** buttons and badges that carry white text |

Contrast decision: white text on plain coral `#ff4f6d` is only 3.2:1, below the 4.5:1 needed for small text. Filled surfaces
therefore use the darker coral `--acc-fill` (white on it: 4.7:1, hover 5.2:1); the lighter coral stays for text and graphics
on dark surfaces (3:1 is enough for non-text, and 5.8:1 for text). The logo tile is a coral gradient `#ff6b81` to `#e23c5b`.

## Rules

- **Every mutation** goes through `runAction` (busy flag per row, optimistic change + rollback, toast).
- **Irreversible** actions ask first with `confirm({ danger: true })`; *very* destructive ones add `typed: '<name>'`.
- **Reversible or postponable** actions do not ask: they show a toast with **Undo** (`undo.run` = inverse call, or
  `defer: true` = commit only after the toast is gone).
- **Never** `alert()` / `confirm()` / inline `msg` lines for action feedback.
- **Every list** has four states: skeleton, empty, error + retry, content (`DataTable` does this for you).
- State is never colour alone: `StatusPill` always has icon + text.

## Feedback

```ts
import { toast } from '#lib/ui/toast';
toast.success(tr('…saved'));
toast.error(errorText(e), { action: { label: tr('ui.retry'), run: save } });
toast.info(msg, { duration: 0, key: 'sync' });   // sticky; same key replaces instead of stacking
```
`ToastHost` (mounted once in `routes/+layout.svelte`) is a polite live region, max 3 toasts, timers pause on hover/focus,
Escape closes the focused toast, sits above the phone tab bar. Defaults: 5 s, errors 8 s, with an action 6 s.
While the last input was a key (not on TV), a toast with an action stays until it is dismissed and its ring fades out;
`Alt+Z` (`ACTION_SHORTCUT`) runs the newest toast's action from anywhere and is the action's accessible description. A
pointer press brings the countdown back.

```ts
import { confirm } from '#lib/ui/confirm';
if (!(await confirm({ title: tr('…confirmDelete', { name }), body?, danger: true, confirmLabel: tr('…delete') }))) return;
await confirm({ title, danger: true, typed: user.name });   // button enabled after typing the name
```
Modal `alertdialog`, focus trap (`dialogKeys`), Escape/backdrop = cancel, focus starts on Cancel for danger, returns to
the trigger. Requests queue; without a mounted host it resolves `false`.

```ts
import { runAction, busyKeys, errorText } from '#lib/ui/action';
await runAction({
  key: `user:${u.id}`,                          // $busyKeys.has(key) → row spinner; double clicks are skipped
  apply: () => { const prev = u.disabled; u.disabled = true; users = users; return () => { u.disabled = prev; users = users; }; },
  run: () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: true } }),
  success: tr('…locked', { name: u.name }),     // string | (result) => string
  undo: { run: () => api(…, { body: { disabled: false } }) },   // optional Undo in the toast
  // defer: true,                               // delay-commit instead (run() after the toast closes, Undo = rollback)
  //                                            // leaving the page commits at once: root layout beforeNavigate (route change,
  //                                            // reload) + pagehide → flushDeferred(); on unload the requests use keepalive
  // error: false | string | (e) => string      // default errorText(e): 403/404/409/429/5xx/offline texts
}); // → { ok, value?, error?, undone?, skipped? }
```

## Components

| Component | Props (main) | Notes |
| --- | --- | --- |
| `Button` | `variant` primary/secondary/ghost/danger, `pending`, `icon`, `size` md/sm, `href`, `block`, `solid` | pending = spinner + `aria-busy`, keeps focus, swallows clicks |
| `DataTable` | `rows` (null = loading), `columns`, `key`, `caption`, `filterable`, `pageSize` (25, 0 = off), `actions(row)`, `rowLabel(row)`, `busyKey(row)` (runAction key; the table follows `busyKeys` itself), `busy(row)` (custom test), `error` + `on:retry`, `emptyText`, bind `q`/`sort`/`page`; server paging: `total` + `on:query` ({ q, sort, offset, limit }) | sticky header, `aria-sort`, cards at ≤720px (mark one column `primary`), slots `cell` (let:row let:col), `toolbar`, `empty` |
| `Column<T>` (`ui/table.ts`) | `key`, `label`, `value(row)`, `sortable`, `sort(a,b)`, `filter: false`, `align`, `width`, `primary`, `hideOnCard`, `hideLabel` | |
| `ActionMenu` | `items: MoreAction[]` ({ id, label, icon, run, href, danger, disabled }), `label`, `title`, `busy` | popover / bottom sheet (MoreActions) |
| `StatusPill` | `tone` ok/warn/err/info/muted, `label`, `icon` | |
| `StatTile` | `label`, `value` (null = skeleton), `icon`, `hint`, `href`, `tone`, `pressed` (`true`/`false`; `undefined` = off), `on:click` | value is not a heading; with `pressed` set (and no `href`) the tile is a real `<button aria-pressed>` toggle for filter tiles (hygiene categories), link and plain tiles are unchanged |
| `Skeleton` | `w`, `h`, `radius`, `lines`, `inline` | |
| `Progress` | `value` (null = indeterminate), `max`, `label`, `showValue`, `tone` | role=progressbar |
| `Field` | `label`, bind `value`, `type`, `hint`, `error`, `required`, `min/max/step` (ISO strings for `type="date"`), `hideLabel`, `width`; or a slot (let:id let:describedby let:invalid) | label/hint/error wired with aria |
| `Select` | `label`, bind `value`, `options` [{ value, label }], `hint`, `error`, `hideLabel`, `on:change` | native select (TV/keyboard) |
| `Toggle` | `label`, bind `checked`, `hint`, `pending`, `on:change` (detail = checked) | `role=switch` |
| `CopyField` | `label`, `value`, `qr`, `hint` | Copy → toast; optional QR (`lib/qr.ts`) |
| `fmtBytes` (`ui/format.ts`) | bytes | localised "1,2 GB" |

## Glass

One material for the web app (`web/src/app.css`, helpers in `web/src/lib/glass/`): milky matte frost over a dark scrim, grain, a light edge and a deep soft shadow. It is used on desktop, phone and the admin panel. Rules for new surfaces:

- Use the classes, never a hand-written `background` and `backdrop-filter` pair.
- Animate only `transform` and `opacity` (the two named exceptions are below). No `color`, `background`, `border-color` or `filter` in any `transition`, anywhere in the app (`admin/glass.test.ts` scans every stylesheet): colours and fills switch at once, and a fill or edge that should fade is an opacity layer (`.fill-hover`, `.edge-hover`). The global `button` rule moves only `transform` and `opacity`.
- Glass never nests: a `.panel` inside a glass surface is part of it (its background is removed); a glass control inside a glass surface (the rating pill in the hover card or the detail panel) keeps its look and scrim but drops the second blur.

### Tokens (`--fr-*`)

| Token | Value | Use |
|---|---|---|
| `--fr-milk`, `--fr-milk-top` | `236, 232, 244` / `240, 236, 248` | milk colour (rgb triples); alphas `--fr-milk-a1` .13 (bottom) and `--fr-milk-a2` .19 (top) |
| `--fr-scrim-rgb` | `18, 16, 24` | scrim colour |
| `--fr-scrim` | `--fr-scrim-light` (.2) | scrim alpha of the surface; `.frost-safe` sets `--fr-scrim-safe` (.7); `toneVars()` sets it inline over sampled artwork |
| `--fr-line`, `--fr-hi` | white .2 / .28 | border / inner top highlight |
| `--fr-blur` | `blur(38px) saturate(115%) brightness(1.05)` | the backdrop filter |
| `--fr-grain`, `--fr-grain-a` | SVG noise, .22 | matte grain (`::before`, overlay) |
| `--fr-shadow`, `--fr-shadow-card` | deep soft shadows | panels / cards |
| `--fr-solid`, `--fr-solid-hover` | `#1c1a21` / `#2a2731` | the solid fallback fill |
| `--fr-sel` | white .13 | the light pill of a hovered, focused or selected menu row, tab or entry (`SEL_A` in `tone.ts`) |
| `--fr-tint` | `0, 0, 0` | artwork tint colour (`.frost-tint`) |
| `--fr-r-card` ... `--fr-r-pill` | 12 / 18 / 20 / 22 / 24 / 26 px / 999px | card, tile, menu, hover card, panel, sheet, pill |
| `--fr-spring`, `--fr-out`, `--fr-in` | cubic-beziers | glass motion curves (as functions: `lib/glass/fx.ts`) |
| `--acc-light`, `--acc-line` | `#ff8aa0` / `#ff9cad` | light coral: text straight on the ambient or on a glass surface's dark underlay (AA) / lines on glass, such as underlines and the toast ring (3:1 over a white backdrop) |
| `--err-mark`, `--info-mark` | `#ff9d9d` / `#73c6cf` | light red danger icons and error dots / the toast's info dot |

### Classes

- `.frost`: the glass surface with blur. `.frost-flat`: the same look without blur (long pages, big panels, anything with many children where blur costs frames); `.panel` is the same look for settings and `/me`. Choose `.frost` for floating things (top bar, menus, sheets, hover card, toasts) and `.frost-flat` for large static areas.
- Shapes: `.frost-pill`, `.frost-tile`, `.frost-menu`, `.frost-panel`, `.frost-sheet`.
- `.frost-btn` (44 px glass pill button, `.round` for a 44 px circle; its hover lights the edge), `.frost-dim` (page dim behind a sheet), `.frost-amb` (the still ambient background for pages without artwork), `.frost-sheen` (light sheen layer), `.frost-tint` (artwork tint layers), `.frost-text` (text levels below on a surface that is not a `.panel`).
- `.fill-hover`: the hover fades in a darker fill under the content (scrim at .3; it only adds contrast), for rows and text buttons on glass. `.edge-hover`: the hover lights the edge (white .42), for tiles and chips. Both fade by opacity; the element must be positioned (the glass classes are; `.fill-hover` sets it).
- Write `-webkit-backdrop-filter` before `backdrop-filter` when the value is a `var()`.

### Fallbacks

Blur exists only with full motion: `html.m-glass`, never on TV or kids. Without it every surface is a solid panel (`--fr-solid`) with the same shape, border, highlight and shadow, no grain:

- calm mode and reduced motion (`html.m-still`): solid, no effects, state changes at once;
- the frame guard tripped: `html.m-glass` drops for the session, solid; open and close then use a 160 ms opacity fade;
- TV (`html.tv`): solid, no pointer effects;
- kids profiles (`html.kids`): keep their look; shared parts (toasts, menus) use the solid fallback.

### Contrast (`lib/glass/tone.ts`)

Text over glass must reach AA (4.5:1) against the ambient's brightest point. `tone.ts` computes the composite (backdrop, scrim, milk, tint) and `scrimFor()` picks the lightest scrim that passes over a sampled picture; `tone.test.ts` and `pages.test.ts` guard the numbers. Over artwork or video nobody sampled, add `.frost-safe` (heavy scrim). On a `.panel` or `.frost-text` surface the text levels are: dim text white .72 (`--mut`), hints white .66 (`--hint`), navigation .75. Status colours there: ok `#4ade80`, warn `#f7b344`, err `#ffa8a8`, link/info `#80cbd4`; coral text `#ffa7b6` (`--acc-text`). On the bare ambient (`html.amb`) coral text is `--acc-text` = `--acc-light` (`#ff8aa0`). Hover lights the edge of `.frost-btn`, it does not add milk (that would drop white text below AA).

| Helper (`tone.ts`) | Use |
|---|---|
| `toneFor(key, src)`, `cachedTone(key)` | sample a picture's tone once per key (tint, bright end, scrim); `cachedTone` reads it without loading |
| `toneVars(tone, text?)` | the inline `--fr-tint` and `--fr-scrim` for a surface over that picture; pass the dimmest text alpha (`TEXT_DIM`) when the surface has dim text |
| `menuScrim(bright)`, `SCRIM_MENU` | the scrim a menu, sheet or toast needs: white on the light pill and `TEXT_DIM` text both pass over pure white. Set it as the surface's `--fr-scrim-safe` (with `.frost-safe`) on every menu or sheet that can open over artwork |
| `TEXT_DIM`, `SCRIM_SAFE_DIM` | the dimmest text on glass over artwork (white .9) and the safe scrim for a surface with such text |

### Helpers (`lib/glass/`)

| Helper | What it does |
|---|---|
| `SlidePill` (`host`, `selector`, `tone` light/white) | the sliding selection pill for tabs, segmented controls and side navigation: three parts moved by transforms, 450 ms spring, jumps without `html.m-glass` |
| `grow` / `growFrom` / `growBoth` (`fx.ts`) | menus and sheets grow out of their button: scale .4 to 1 with the spring (380 ms), back in 200 ms; reduced set: 160 ms fade; calm: instant. `growFrom({ trigger })` measures the origin from the button once per open and keeps it |
| `twoWay(make)`, `growBoth` | the reversal contract: use them with Svelte's bidirectional `transition:` (never `in:`/`out:`), so a close mid-open or a reopen mid-close turns around from where it is. `transition:growBoth={{ trigger }}` for a menu; `twoWay((dir) => …)` to build your own |
| `sheetSlide` | a phone bottom sheet (the card sheet, MoreActions on phones) slides up from below the window (380 ms in, 200 ms out) |
| `toastRise` | a toast rises in (420 ms spring) and slides out (260 ms) |
| `scrimFade` | a sheet's scrim fades (200 ms) |
| `countAt` | the count-up value (1.1 s ease-out) for admin numbers; `admin/glass.ts` `countable()` decides which values count (plain numbers only) |
| `sheen` (`pointer.ts`) | action: a light sheen follows the pointer inside a glass surface (host clips it) |
| `tilt` (`pointer.ts`) | action: poster and card tilt toward the pointer (up to 9 degrees), glare, light band, shadow; siblings step back |
| `press` (`press.ts`) | action: touch press feedback, scale .92 in 80 ms, spring back in 350 ms, ripple from the touch point (the action adds `.ff-press` itself) |
| `Button` `done` | after a save the label becomes "Saved" with a drawn checkmark; the caller resets it after about 2 s |

`sheen`, `tilt` and `press` run only with full motion (`fxLive()`): `sheen` and `tilt` need a fine pointer off TV and kids, `press` needs touch or pen. `grow`, `sheetSlide`, `toastRise` and `tilt` pulse the frame guard when they start with full motion, so slow glass motion can trip it.

### Named animation exceptions

Everything else moves `transform` and `opacity` only. Two paint-only exceptions are allowed: the `stroke-dashoffset` of the toast countdown ring and of the drawn save checkmark, and the text colour of a selected tab or segment label (250 ms). The sliding pill's width is never animated.

## Admin shell

`routes/admin/+layout.svelte` renders `AdminShell`: sidebar groups (People, Content, Operations; `lib/admin/nav.ts`)
with `aria-current` and badges from `/api/admin/summary` (`lib/admin/summary.ts`: `summary` store, `refreshSummary()`,
`bumpPending(key, ±1)` for optimistic badges). The shell owns the page `<h1>` and `<title>` (from the nav item) –
pages must not add their own. Phone: `/admin` shows the grouped list, sub-pages a back chevron.
Audit entries become sentences with `describeActivity(entry)` (`lib/admin/activity.ts`, keys `admin.activity.*`).
New admin page: add the route, a nav item in `nav.ts` and its label key; page texts go to `adminPeople` / `adminContent`.

Pages in the shell (`lib/admin/nav.ts`): **People** – users, roles, devices, usage, invitations; **Content** – requests, polls, lists, hubs, leaving soon, previews, library care (hygiene); **Operations** – playback check, weekly recap, data sources, status, audit log, update. Badges: devices, requests and polls count what waits for a decision (amber), previews count failures (red).

The overview (`/admin`, `routes/admin/+page.svelte`) is built only from kit parts: a health strip of `StatusPill`s (media server, request service, version, previews, playback check), "Waiting for you" with inline approve / decline for requests (decline is delayed with Undo) and new devices, recent activity as sentences, `StatTile` counts and `Progress` bars for storage. One cheap call feeds the badges and the tiles – `GET /api/admin/summary` returns counts only (users, pending devices / polls / invites / failed previews, request counts, download and preview storage, last playback check, service reachability, running streams and party rooms); every source is optional, so a request service that is down shows "not reachable" instead of an error. Phone: the same area is a grouped list, each page opens with a back chevron.

**Status page (Block 22).** `/admin/status` keeps its route and label; it is built from `ServiceLights` (one `StatusPill` per service with response time), `DiskCard` (one entry per volume, `Progress` bar, FriendFlix's own share, both shares when downloads and previews share a volume), `StreamsCard` (running streams with play method, reason chips, codecs) and `ErrorsCard` (aggregated errors: code, count, last seen; never samples). Data: `lib/admin/health.ts` (types mirror the backend; `loadHealth(refresh)`, `loadStreams()`, `loadErrors(hours)`). The overview strip reads media server and request service from the same snapshot.

**Warning banner.** `lib/admin/HealthBanner.svelte` + `lib/admin/banner.ts` (`banner` store, `startBanner()` polls `GET /api/admin/health/banner` every 60 s while the tab is visible, `dismiss(issue)` hides it optimistically and rolls back with the error toast on failure, `issueText(issue)` builds the sentence from `admin.banner.*`). The root layout mounts it inside `<main>` above the page (in flow, never covering content or the phone tab bar) only for an admin on the owner profile; never on `/watch/*`, `/party/*`, the profile picker, public pages, TV mode, kids profiles or while the device waits for approval. The worst issue shows as one sentence (red before amber, `role="alert"` once per red issue, else `role="status"`) with *View* and *Dismiss*; "+n more" opens the rest.

**Library care and usage.** `/admin/hygiene` (`lib/admin/hygiene.ts`): category `StatTile`s with `pressed` as filters, issue pills, search, sort, a `DataTable` with server paging, *Ignore* / *Refresh metadata* per row and *Check now* (polls the summary every 10 s while a scan runs). `/admin/usage` (`lib/admin/usage.ts`): a `DataTable` sorted on the client with period select (7/30/90 days); the name cell is a button (`aria-expanded`, `aria-controls`) that opens one detail panel below the table with the daily bars, devices and reasons.
