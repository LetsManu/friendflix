# Menus glass, Stage 1: motion rule, dialogs, Update page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Text in every pop-up stops zooming or bouncing, and every small dialog becomes the same glass panel, in one shippable PR.

**Architecture:** The root cause is central. `web/src/lib/glass/fx.ts` `grow()` scales menus from .4 to 1 with an overshooting spring, and `sheetSlide`/`toastRise` overshoot too. `ModalShell` adds a scale of its own, and `press.ts` and `app.css` scale text buttons on press. Fix those shared pieces first, so every menu, sheet and toast that uses them is fixed at once. Then make `ModalShell` glass, with a symmetric no-scale motion and a scroll lock, and give all its dialogs one button row. Remove the remaining stray text scales. Pin the rule with a source scan and an e2e frames spec.

**Tech Stack:** SvelteKit (Svelte 5, legacy `$:` components), TypeScript, vitest (pure-TS units, no component library), Playwright e2e with mocks.

**Spec:** `docs/superpowers/specs/2026-11-15-menus-glass-design.md`. The owner-approved mockup is the "Menus & pop-ups" canvas; its sources are in `/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/menumock/project/` (`Dialogs.dc.html` is the reference for this stage). Audit: `/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/menu-audit/report.md`.

## Global Constraints

- Text is never scaled: no `scale()`, `zoom`, font-size or letter-spacing animation on any element that holds text, or on any ancestor of one, during open, close, swap or press. Icon-only controls and artwork may keep a press scale.
- Pop-up motion uses `opacity` plus `translate` in whole pixels, at most 10 px (menus 8 px, dialogs 10 px). Sheets slide by percent from the edge. No easing curve overshoots 1 (no spring) on any pop-up, sheet or toast.
- Exit is about 70 % of the entry duration, with an accelerate curve (`inEase`). The reduced set (frame guard tripped) uses opacity only, 160 ms. Calm mode and reduced motion are instant (`fxMode() === 'still'`).
- Only `transform` and `opacity` animate. Nothing behind a pop-up moves when it opens (scroll lock with scrollbar compensation).
- Touch targets are at least 44 px (36 px for mouse-only small buttons). Seven locales (de, en, es, fr, it, pl, tr) keep identical key order if any key is added.
- No "Netflix" or "Seerr" in user-facing text; fictional names and placeholder hosts only. Never `git stash`. Merge, never rebase.
- Commit trailer, exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- Run only typecheck plus the specific specs you touched:
  - web: `cd web && npx svelte-kit sync && npx svelte-check --threshold error`, where 0 errors is expected after sync;
  - units: `cd web && npx vitest run <files>`;
  - e2e: from `e2e/`, `E2E_PORT=<free> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off`.

## Review Focus

1. **A menu reopened mid-close:** the bidirectional `growBoth` must continue from the current point without a jump now that it translates instead of scaling (Task 1 test `reverses mid-flight without a jump`).
2. **Calm mode / reduced motion:** every changed transition returns `duration: 0`, and `ModalShell` does not lag (Task 1, Task 3 tests).
3. **A dialog opened while a page is scrolled, on a desktop with a classic scrollbar:** the page must not shift sideways when the scroll locks (Task 3 `scrollLock` padding test and the e2e "page does not move" check in Task 7).
4. **Two dialogs or a dialog over a sheet:** the scroll lock is ref-counted, and the inner close must not unlock while the outer is open (Task 3 test `nested locks`).
5. **Phone width under 420 px:** the dialog buttons stack full width with the primary on top, the same in every dialog (Task 4 e2e).

---

### Task 1: Pop-up transitions without scale or overshoot (`fx.ts`)

**Files:**
- Modify: `web/src/lib/glass/fx.ts` (`grow`, `growFrom`, `sheetSlide`, `toastRise`, constants)
- Test: `web/src/lib/glass/fx.test.ts`

**Interfaces:**
- Produces:
  - `export const emphOut: (t: number) => number = cubicBezier(0.05, 0.7, 0.1, 1)`;
  - `export function growShift(trigger: DOMRectLike, pop: DOMRectLike): { x: number; y: number }`: the popover's entry offset in px, at most 8 in each axis. y is -8 when the popover's top lies below the trigger centre (it opens downward, so it slides down into place), +8 when it opens upward, else 0. x follows the same idea for side-opening popovers (|x| ≤ 8, 0 when vertically placed).
  - `grow(node, { shift?, dir?, mode? })` replaces the `origin` parameter with `shift`. `growFrom`, `growBoth` and the other signatures are unchanged.
  - Constants: `GROW_IN_MS = 220`, `GROW_OUT_MS = 150`, `SHEET_IN_MS = 320`, `SHEET_OUT_MS = 200`, `TOAST_IN_MS = 300`, `TOAST_OUT_MS = 200`.

- [ ] **Step 1: Write the failing tests** in `fx.test.ts`:
  - `grow css never scales`: for `dir` in/out and t in 0…1 in 0.05 steps, `css(t, 1-t)` does not match `/scale/`, and does match `translate`.
  - `grow moves at most 8 px`: parse the translate px from `css(0,1)`; |x| ≤ 8 and |y| ≤ 8; `css(1,0)` translates 0.
  - `no pop-up easing overshoots`: for `grow` (in), `sheetSlide` (in) and `toastRise` (in), sample the easing at 201 points and require max ≤ 1 and min ≥ 0.
  - `growShift`: a trigger above the popover gives `{x:0,y:-8}`, a trigger below gives `{x:0,y:8}`.
  - `reverses mid-flight without a jump`: `growBoth(...)({direction:'out'}).css(0.5, 0.5)` equals the in-transition's css at 0.5. Same t, same position.
  - `still / reduced`: the existing cases keep passing, with duration 0 and opacity-only css.
  - Update any existing assertion that expected `scale(`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/glass/fx.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - `grow` css: `transform:translate(${round(sx*(1-t))}px,${round(sy*(1-t))}px);opacity:${min(1,t)}`. Easing in is `emphOut`, out is `inEase`.
  - `growFrom` stores the measured shift (not the origin) in the WeakMap.
  - `sheetSlide` and `toastRise` use `emphOut` on the way in.
  - Keep `growOrigin` exported only if something else imports it (grep); otherwise delete it with its test.
  - Update the doc comments to say "fades and slides 8 px from its button; text never scales".
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): menus, sheets and toasts fade and slide, never scale or overshoot`.

### Task 2: Press feedback without scaling text

**Files:**
- Modify: `web/src/lib/glass/press.ts`, `web/src/app.css:100` (`button:active … scale(.97)`), `web/src/app.css:262` (`.ff-press.pressed … scale(.92)`), `web/src/lib/phone/Carousel.svelte:292`
- Test: `web/src/lib/glass/press.test.ts`

**Interfaces:**
- Produces: the press feedback for text controls is `opacity: .72` (80 ms in, 200 ms back, linear), and the ripple stays. Icon-only controls (`.ff-press.icon`, or any `button` whose only child is an `svg`/`.icon`) may keep `scale(.92)` via the class `press-scale`. Export `PRESS_OPACITY = 0.72`; delete `PRESS_SCALE` if nothing else imports it.

- [ ] **Step 1: Failing test** in `press.test.ts`: `a text button pressed dims, it does not scale`. Mount a `<button>` with a text node, dispatch `pointerdown` (touch, full motion), assert the class `pressed` is set, and assert the stylesheet rule the code relies on carries no `scale`. If press.ts sets inline style, assert `style.transform` is empty and `style.opacity` is `'0.72'`. Choose the inline-style form so it is testable without CSS.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/glass/press.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - press.ts applies `opacity` on press for text controls and `transform: scale(.92)` only for icon-only nodes.
  - app.css: `button:active:not(:disabled), .btn:active { opacity: .82; }`, with no transform.
  - The `.ff-press.pressed` rule: opacity, not scale.
  - Carousel `.btn:active`: opacity.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `fix(ui): pressing a text button dims it instead of shrinking the text`.

### Task 3: `ModalShell` becomes a glass dialog with symmetric motion and a scroll lock

**Files:**
- Modify: `web/src/lib/ui/ModalShell.svelte`
- Modify: `web/src/lib/glass/fx.ts` (add `dialogRise`)
- Create: `web/src/lib/ui/scrollLock.ts`, `web/src/lib/ui/scrollLock.test.ts`
- Test: `web/src/lib/glass/fx.test.ts`

**Interfaces:**
- Produces:
  - `export function dialogRise(node: Element, p?: { dir?: 'in'|'out'; mode?: FxMode }): Cfg`: 220 ms in with `emphOut`, 150 ms out with `inEase`; css `transform:translateY(${round(10*(1-t))}px);opacity:${t}`; reduced is opacity-only 160 ms; still is 0.
  - `export function dialogBoth(node, p)`: the `twoWay` wrapper.
  - `export function lockScroll(doc?: Document): () => void`: ref-counted. The first lock sets `overflow:hidden` on `documentElement` and `padding-right: <scrollbar width>px`, where the scrollbar width is `window.innerWidth - documentElement.clientWidth` (0 means no padding). The last unlock restores the previous inline values exactly. The returned function is idempotent.
- `ModalShell`:
  - backdrop `transition:scrimFade`;
  - panel `transition:dialogBoth`, with the panel classes `frost frost-panel frost-safe` (the glass material, radius `--fr-r-panel`, the glass shadow), replacing `#1b2127` / 12 px / `--shadow-pop`;
  - `max-height: calc(100dvh - 2rem)` with `overflow:auto`;
  - `lockScroll()` on mount, released on destroy;
  - the scrim colour stays `rgba(0,0,0,.6)`;
  - if `focus` is null, the first focusable inside the panel gets focus;
  - the `m-still` rule stays.

- [ ] **Step 1: Failing tests:**
  - `fx.test.ts`: `dialogRise never scales and moves at most 10 px`, and `dialogRise is symmetric` (the out css at t equals the in css at t).
  - `scrollLock.test.ts` (jsdom or a fake document object; pick what the existing tests use):
    - `pads by the scrollbar width`: innerWidth 1000, clientWidth 985, so padding-right is `15px`;
    - `no scrollbar, no padding`;
    - `nested locks`: lock A, lock B, unlock B, still locked; unlock A, restored;
    - `restores previous inline values`;
    - `double unlock is harmless`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/glass/fx.test.ts src/lib/ui/scrollLock.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `dialogRise`, `dialogBoth` and `scrollLock.ts`, then rewire ModalShell. Remove the `svelte/transition` import.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then run `e2e/tests/admin-roles.spec.ts` and `e2e/tests/admin-role-page.spec.ts` (they open ModalShell dialogs). Expected: PASS, with any stale selector or style assertion updated.
- [ ] **Step 5: Commit** `feat(ui): dialogs are glass panels that fade and rise 10 px; the page behind stays put`.

### Task 4: One dialog button row and a tidy new-role dialog

**Files:**
- Modify: `web/src/app.css` (add the `.dlg-acts` / `.dlg-title` / `.dlg-body` / `.dlg-err` rules beside the glass rules)
- Modify: `web/src/lib/ui/ConfirmHost.svelte`, `web/src/lib/admin/rights/NewRoleDialog.svelte`, `web/src/lib/admin/rights/DeleteRoleDialog.svelte`, `web/src/lib/admin/livetv/MergeDialog.svelte`, `web/src/lib/admin/livetv/GroupNameDialog.svelte`
- Test: `e2e/tests/dialogs.spec.ts`, `e2e/tests/dialogs.mobile.spec.ts` (create; follow the mock fixtures used by `admin-roles.spec.ts`)

**Interfaces:**
- Produces these shared classes:
  - `.dlg-title`: 21 px, weight 800, line-height 1.25, margin 0 0 10 px.
  - `.dlg-body`: 15 px / 1.5, colour `#c9ced4`.
  - `.dlg-err`: a reserved `min-height: 22px` status line, 13 px, colour `--err-mark`, margin 10 px 0 8 px.
  - `.dlg-acts`: flex, justify-content flex-end, gap 10 px. Under 420 px it becomes `flex-direction: column-reverse`, buttons full width, primary on top.
  - DOM order is always [secondary, primary].
- Button look in dialogs:
  - secondary: the glass pill (`frost-btn`);
  - primary: `--acc-fill` pill;
  - danger: `--danger` solid pill;
  - all 44 px high with radius `--fr-r-pill`;
  - a busy primary keeps its width: the spinner sits over the hidden label (`visibility:hidden` on the label, the spinner absolutely centred).
- Inputs in dialogs show one focus ring: `outline: 2px solid #fff; outline-offset: 2px`, no box-shadow ring.

- [ ] **Step 1: Failing e2e** `dialogs.spec.ts` (desktop 1440×900) and `dialogs.mobile.spec.ts` (390×844):
  - open the new-role dialog (Admin → Rollen & Rechte → *+ Neue Rolle*);
  - assert the gap between the last option and the button row's top is ≤ 32 px (the reserved error line included);
  - assert the buttons' DOM order is [Abbrechen, Anlegen] and the visual order: desktop has Anlegen to the right; phone has Anlegen above Abbrechen, both full width;
  - assert the focused name input's computed `box-shadow` is `none` and its `outline-width` is `2px`;
  - assert the panel's computed `border-radius` equals `--fr-r-panel` (24 px);
  - open the delete-role dialog and the ConfirmHost dialog (any `confirm()` path covered by existing fixtures) and assert the same button rules.
- [ ] **Step 2: Run** both specs. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the classes and move the five dialogs onto them. Find and remove the source of the new-role dead gap (it is likely a fixed `min-height` or a `flex:1` spacer). Make the copy ellipses `…` in these files.
- [ ] **Step 4: Run** both specs, `admin-roles.spec.ts`, `admin-role-page.spec.ts` and the livetv groups specs that open Merge / GroupName (`admin-livetv-groups.spec.ts`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): every dialog shares one title, body, status line and button row`.

### Task 5: The remaining text scales (Update page, title pop-up, TV scrub preview)

**Files:**
- Modify: `web/src/lib/admin/StepList.svelte:170` (the `.note` start `translateY(10px) scale(.98)` becomes `translateY(8px)`)
- Modify: `web/src/lib/ItemModal.svelte:65` (`@keyframes pop`: drop `scale(.97)`, keep `translateY(18px)`, and the easing has no overshoot)
- Modify: `web/src/lib/player/TvControls.svelte:213-217` (`tv-pv-in`: opacity plus `translateY(12px)`, no scale; the TV look is otherwise unchanged)
- Test: `web/src/lib/admin/steps.test.ts` is unaffected; the coverage comes from the scan in Task 6 and the frames spec in Task 7.

- [ ] **Step 1:** Make the three CSS changes. Check each easing used there: replace any `--m-spring` / `--tv-spring` on these three animations with `--m-emph-out` (TV: the TV emphasised-out token in `lib/tv/motion.ts` / app.css `--tv-*`).
- [ ] **Step 2: Run** `e2e/tests/admin-update*.spec.ts` (whichever exist) and the TV player spec that covers scrubbing if one exists (`grep -l tv-pv\|pcard e2e/tests`). Expected: PASS.
- [ ] **Step 3: Commit** `fix(ui): the update result, the title pop-up and the TV scrub preview no longer zoom their text`.

### Task 6: The no-text-scale rule as a source scan

**Files:**
- Create: `web/src/lib/ui/motionRule.test.ts`

**Interfaces:**
- Produces the test `no pop-up or text control animates scale`. It reads every `web/src/**/*.{svelte,css,ts}` that is not a test, and fails on:
  - `scale(` inside a `@keyframes` block, a `transform:` declaration under a `:active`, `.pressed`, `:focus` or `.open` / `.in` / `.out` selector, or a JS string building a transform;
  - `import { … scale … } from 'svelte/transition'`;
  - `springEase` or `--m-spring` / `--fr-spring` / `--tv-spring` used in any file under `lib/ui/`, `lib/glass/fx.ts` pop-up transitions, `MoreActions`, `ListMenu`, `desk/`, `live/*Sheet*`, `admin/**/Sheet*`, or `*Dialog*`.
- `ALLOW: Record<string, string>` maps `path:pattern` to a reason, for elements without text only:
  - artwork and thumbnails (`Card.svelte .thumb:active`, `.tw-shadow`);
  - decorative rings (`admin/Halo.svelte`);
  - the splash logo (`Intro.svelte`), after checking that it holds no text, else fix it;
  - TV focus tiles (`lib/tv/*`, the TV focus design the owner keeps);
  - ripples (`.ripple`);
  - `pillParts` `scaleX` (a bar, no text);
  - icon-only press (`press-scale`).
  - `Card.svelte` tilt-row dimming (`section.row.dk.tilt-row`) gets a TEMPORARY entry with the reason "row hover depth, not a pop-up — Stage 6".
- Every allow-list key must still match something; a stale key fails the test.

- [ ] **Step 1:** Write the test with an empty `ALLOW`. Run `cd web && npx vitest run src/lib/ui/motionRule.test.ts`. Expected: FAIL, listing every remaining match.
- [ ] **Step 2:** For each match, either fix it (a text element: switch to opacity / translate) or add it to `ALLOW` with a reason after confirming that no text sits inside the scaled element or its descendants.
- [ ] **Step 3: Run** the test. Expected: PASS.
- [ ] **Step 4: Commit** `test(ui): no pop-up or text control may animate scale`.

### Task 7: The e2e frames spec, docs and CHANGELOG

**Files:**
- Create: `e2e/tests/motion-frames.spec.ts`, `e2e/tests/motion-frames.mobile.spec.ts`
- Create: `e2e/helpers/frames.ts` (or the repo's helper folder, if it has one)
- Modify: `docs/ui-kit.md` (a short "Motion of pop-ups" section stating the rule and the tokens), `CHANGELOG.md` (under `[Unreleased]`, a new `### Look and feel` heading if none exists)

**Interfaces:**
- Produces two helpers:
  - `sampleTextScale(page, rootSelector: string, ms = 450): Promise<number>`: in the page, sample on every animation frame for `ms`. For each element under the root that has a non-empty direct text node, multiply the `DOMMatrix` of its own and every ancestor's computed `transform` (up to `<html>`) and return the maximum of `|scaleX-1|` and `|scaleY-1|` seen.
  - `stableBox(page, selector)`: the bounding box before and after.
- Tests:
  - Desktop:
    - the title page ⋯ menu (MoreActions popover), the header profile menu, a toast (from an action that toasts in the fixtures), the ConfirmHost dialog, the new-role dialog, and the Update page result note (use the update fixtures from `admin-update*.spec.ts`);
    - each: start sampling, open, `expect(maxDev).toBeLessThan(0.001)`; same for close where the surface closes;
    - the page heading's box is unchanged after a dialog opens.
  - Mobile: the title ⋯ sheet, the phone header menu and the new-role dialog.

- [ ] **Step 1:** Write the specs and run them on the branch. They must PASS (Tasks 1–6 made them true). To prove the spec bites, temporarily revert Task 1's css line locally, see the menu case FAIL, and restore it. Do not commit the revert.
- [ ] **Step 2:** Docs and CHANGELOG. CHANGELOG bullet: "**Menus, sheets, dialogs and toasts no longer zoom their text.** They fade and slide a few pixels into place, without bouncing; dialogs are glass panels like the menus, with one button row (primary on the right, on phones on top), and the page behind them no longer shifts when they open. Pressing a button dims it instead of shrinking its label. The Update page's result, the title pop-up and the TV scrub preview no longer zoom."
- [ ] **Step 3: Run**
  - the two new specs;
  - `cd web && npx svelte-kit sync && npx svelte-check --threshold error` (0 errors);
  - `npx tsc --noEmit -p e2e`;
  - `cd web && npx vitest run src/lib/glass src/lib/ui`.

  Expected: PASS.
- [ ] **Step 4: Commit** `test(ui): frames spec pins no text scaling in pop-ups; docs and changelog`.

---

Later stages get their own plan files, written just in time from the audit report and this stage's primitives:

- `…-stage2.md`: desktop menus (MoreActions/ActionMenu one ⋯ look, the profile menu row with its icon, bell, Kategorien, ListMenu, hover pop-out ⋯ placement, search sheet, `max-height` on popovers, the MoreActions triple focus ring);
- `…-stage3.md`: phone sheets (one sheet, the title ⋯ sheet split into sub-pages, no native selects in sheets);
- `…-stage4.md`: player and Live TV menus (one panel design, fixed-height sub-pages, the volume slider without a `width` animation, the episode rows);
- `…-stage5.md`: TV menus (solid glass, TV focus);
- `…-stage6.md`: audit leftovers (tilt-row scale, ellipses, the remaining items).
