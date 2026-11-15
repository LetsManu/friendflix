# Menus, sheets and dialogs: one glass system, release-ready motion

Status: approved by the owner 2026-11-15 ("go" on the design and the mockup). Mockup: the "Menus & pop-ups" design canvas (desktop + phone artboards).
Builds on: `2026-11-09-glass-design.md` (the glass material and its tokens), `docs/ui-kit.md`.

## Why

The owner wants every menu and pop-up release-ready, as polished as the big streaming platforms: "no artifacts, bouncing text or
unfinished or broken pop-ups". Today's visible fault: text in pop-ups gets distorted while they open, e.g. on the Update page.
The cause, found in the code: pop-ups zoom in with a `scale()` transform, on a frosted-glass layer, so the text is resampled every
frame (smeared, wobbly) and can stay slightly soft afterwards:

- `lib/admin/StepList.svelte:170`: the Update result note starts at `translateY(10px) scale(.98)`.
- `lib/ui/ModalShell.svelte:41`: every small dialog (confirm, name, delete role, update confirm) uses `in:scale start .96`.
- `lib/ItemModal.svelte:65`: the title pop-up starts at `translateY(18px) scale(.97)`.

Other surfaces never moved to the glass material: `ModalShell` is a flat `#1b2127` box with a 12 px radius while menus, sheets
and panels are glass with the `--fr-r-*` radii. Owner: **"all panels and menus should have the same glass design on everything, as
well on mobile; the TV player keeps its current design, but all menus there should also reflect the same design."**

### What the audit found (35 pop-up surfaces, 6 shared shells, ~20 hand-rolled)

- Dialogs (ModalShell: confirm, new role, delete role, merge, group name) are flat and 12 px while menus and sheets are 20/26 px
  glass; while a dialog fades and scales in, the page text shows through it (*Rollen & Rechte* over *Neue Rolle*); open
  (fade + scale) and close (fade) differ.
- New-role dialog: a dead gap above the buttons, *Abbrechen*/*Anlegen* in a different order on desktop and phone, a heavy double
  focus ring on the name field.
- Phone title ⋯ sheet: action rows, a segmented control and two native selects crammed into one sheet; the selects wrap onto two
  lines; *Favorit* stays highlighted at rest.
- Player panels (tracks, episodes, phone tracks): three designs, radii 6/16/20 px, row heights 44/52/64/90, episode text starting at
  different x positions; the volume slider animates its `width` on hover.
- Copy: ASCII `...` instead of `…` ("Untertitel suchen ...", "Zu Liste hinzufügen ...", "Titel oder Serie suchen ...").
- The logout row is centred without an icon; the search sheet is half empty with an unstyled *Alle Ergebnisse*; the admin ⋯ button
  looks different from the title page's.
- Fine already: nothing goes off-screen or overflows, focus enters menus and returns on Escape.

## Goals

1. **Text never scales.** No `scale()` (or `zoom`, font-size or letter-spacing animation) on any element that holds text, during an
   open, close, swap or press. Pop-ups move with `opacity` plus a small `translateY`/`translateX` in whole pixels. Icon-only buttons may
   keep a press scale (no text inside).
2. **One look.** Every menu, popover, listbox, sheet, dialog, toast and settings panel uses the glass material (`.frost` family, the
   `--fr-*` tokens): the same fill, edge, highlight, grain, shadow; radii `--fr-r-menu` (menus, popovers, listboxes), `--fr-r-panel`
   (dialogs), `--fr-r-sheet` (phone sheets), `--fr-r-pill` (toasts). Desktop, phone and TV.
3. **One anatomy.** Menu rows 44 px (phone sheet rows 52 px), 24 px icon column, label, a trailing value / check / chevron column;
   a header line with the context (the title or the person); dividers between groups; destructive items last, after a divider, in the
   light danger colour. Dialogs: title, body, a reserved status/error line, buttons right (phone: stacked, full width).
4. **Nothing jumps.** Content that changes inside a pop-up stays in a box of fixed size (nested player menus slide sideways inside a
   fixed height); a busy button keeps its width (spinner over the hidden label); error lines are reserved; opening a dialog locks the
   page scroll without the scrollbar gap shifting the page (`scrollbar-gutter: stable` or padding compensation).
5. **Never broken.** Menus stay inside the viewport (flip above/below, shift sideways near an edge), close on Escape, outside press,
   route change and scroll of their anchor's container; focus moves in and returns to the trigger; Arrow keys / Home / End move between
   items; one pop-up at a time; no pop-up opens half-loaded (skeleton rows of the final height, or the trigger shows a spinner).
6. **Motion tokens only.** Open: `--m-d-s`…`--m-d-m` with `--m-emph-out`; close ≈70 % of open with `--m-emph-in`. Calm mode,
   reduced motion and a tripped frame guard (`lib/glass/fx.ts`): opacity only, or instant in `still`.

## TV

The TV player and TV screens keep their current layout and focus design. Every TV menu, sheet and dialog (player options,
audio/subtitle pickers, Live TV sheets, confirm dialogs, the side bar's menus) takes the same glass look as the web app, **without
blur**: on TV the glass is already the solid-panel fallback (same shape, edge, highlight and shadow, no `backdrop-filter`) because
blur costs frames on TV hardware. Motion on TV follows the same rule (no text scaling); focus rings stay the TV ones.

## Non-goals

- No new menu actions or features; content stays, broken or unfinished entries get fixed or removed.
- No TV player layout redesign; no change to page layouts outside pop-ups.
- No new UI dependency (no headless component library).

## Anti-goals (a failure even if it works)

- Any text resampled by a transform while it animates.
- `width`/`height`/`top`/`left` animations, or content behind a pop-up shifting when it opens.
- Blur on TV, or glass that drops frames on a mid-range phone (the frame guard must keep working).
- A pop-up that renders one way in one place and differently in another.

## Approaches

- **A. Shared primitives, every surface moved onto them (chosen, my recommendation).** Fix and restyle the existing shared pieces
  (`ModalShell`, `MoreActions`/`ActionMenu`, `Select`, `ToastHost`, `ConfirmHost`, the phone sheet), add a glass `Popover`/`Menu`
  shell where one is missing, then move each hand-rolled pop-up onto them. Costs more up front; afterwards one change fixes all.
- B. Restyle each pop-up in place. Fastest per surface, but the looks drift apart again and the motion rule is re-solved 30 times.
- C. Adopt a headless library (bits-ui / melt-ui). Good positioning and a11y, but a new dependency that overlaps `MoreActions`,
  `dialogKeys`, the TV focus system and the glass fx; a bigger migration with more risk.

## Guard rails (tests that keep it fixed)

- A unit/lint test scanning `web/src/**/*.{svelte,css}` for `scale(` in keyframes, transitions and `in:/out:/transition:scale` on
  pop-up files; an allow-list for icon-only press feedback and artwork.
- An e2e "frames" spec: opens each primary pop-up and samples computed `transform` of every text-bearing descendant during the
  animation; any matrix with a scale ≠ 1 fails. Also asserts the page behind does not move (bounding boxes stable) and the pop-up lies
  inside the viewport at desktop, phone and TV sizes.
- Screenshots of each surface at desktop 1440, phone 390 and TV 1920 checked by the reviewer.

## Order of work (each stage shippable on its own)

1. **Motion rule + dialogs + Update page:** the scale removals, `ModalShell` as glass, the motion lint, the frames spec.
2. **Desktop menus:** `MoreActions`/`ActionMenu`, account menu, notifications, `Select`, card ⋯ menus, toasts; viewport placement.
3. **Phone sheets:** one sheet (grab handle, safe area, 52 px rows), every phone menu and confirm on it.
4. **Player menus** (desktop and phone): the settings menu with sliding sub-pages in a fixed box; Live TV sheets (record sheet etc.).
5. **TV menus:** the same look without blur, existing TV focus.
6. **Audit leftovers:** every item from the menu audit (`menu-audit/report.md`) not covered above.

## Left to the builder

Exact component APIs, which surfaces share a file, placement maths, the frames spec's sampling, test names; the audit report lists
every surface with its file.
