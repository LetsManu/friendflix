# Branding, Stage A: identity, logo, colours everywhere — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin sets the name, byline, short name, header style, logo, app symbol, accent colour, glow and sign-in background on Admin → Branding, and the whole web app (sign-in included), the TV start screen and the cast receiver show it live.

**Architecture:**
- **Backend storage:** a dedicated `brand` table (one row, JSON validated by zod) and a `brand_images` table (content-hashed bytes). These are not part of the env-mirroring settings registry: branding is not deploy config.
- **Routes:** admin routes write the brand; a public route returns the public fields plus a revision, and a public image route serves the images same-origin with immutable caching.
- **Web:** a `brand` store loads before sign-in. It applies the colour tokens as inline custom properties on `<html>` (the CSP allows style attributes), updates the title, icons and meta, and feeds `{app}` into i18n.
- **Images:** they are resized and re-encoded in the admin's browser (canvas → PNG), so no image library is needed on the server. The server validates the signature and dimensions and strips metadata chunks again.

**Tech Stack:** Fastify, Postgres (migration 56), zod, SvelteKit SPA (`ssr=false`), vitest, Playwright e2e with mocks.

**Spec:** `docs/superpowers/specs/2026-11-15-branding-design.md`. Recon map: `/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/branding-recon.md`. Mockup: `/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/menumock/project/Branding.dc.html`.

## Global Constraints

- **Defaults** (an empty table means exactly today's look):

  | Field | Default |
  |---|---|
  | `name` | `"FriendFlix"` (1–24 chars, trimmed, no control chars) |
  | `byline` | `""` (≤ 32) |
  | `shortName` | `""` → falls back to the name (≤ 12) |
  | `website` | `""` (https/http URL or empty) |
  | `about` | `""` (≤ 280) |
  | `header` | `'wordmark' \| 'symbol' \| 'logo'` = `'wordmark'` |
  | `accent` | `'#ff4f6d'` (`^#[0-9a-f]{6}$`, lower-cased) |
  | `glow` | `'accent' \| 'accentViolet' \| 'neutral' \| 'off'` = `'accentViolet'` |
  | `signInBg` | `'posters' \| 'image' \| 'color'` = `'posters'` |
  | `logo`, `symbol`, `signInImage` | content hashes or `null` |

- **Contrast:** derived tokens must satisfy `--acc-text` ≥ 4.5:1 on `#101418`, white on `--acc-fill` ≥ 4.5:1, `--acc-light` ≥ 4.5:1 on `rgb(18,16,24)`, and `--acc-line` ≥ 3:1 on `#ffffff`. For the default accent they must reproduce today's values exactly: `--acc #ff4f6d`, `--acc-fill #d6325a`, `--acc-hover #e63e5c`, `--acc-fill-hover #c9304d`, `--acc-light #ff8aa0`, `--acc-line #ff9cad`. Implement this as a special case: if the accent equals the default, return the current table.
- **Images:** PNG or WebP only, ≤ 2 MB as uploaded. The symbol is square and ≥ 512 px. The logo is ≤ 2048 × 512. The sign-in image is ≤ 2560 × 1600. Served from `/api/public/brand/img/<sha256>.<ext>` with `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`.
- **Access:** only admins write (`requireAdmin`). Every write and reset is audited as `brand.update` / `brand.reset` with the changed field names only (no image bytes). The public route returns nothing beyond the fields above plus `rev`.
- **The AGPL source link** in About/Footer stays; nothing in this plan may hide it.
- **Repo rules:**
  - 7 locales (de, en, es, fr, it, pl, tr) with identical key order.
  - No "Netflix" or "Seerr" in user text; fictional names and placeholder hosts only.
  - Only transform and opacity animate; no text scaling; 44 px targets.
  - Never `git stash`; merge, never rebase.
- **Commit trailer**, exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- **Checks:** only typecheck plus the touched specs.
  - backend: `npx tsc --noEmit -p backend`; `cd backend && npx vitest run <files>`. This needs Postgres at 127.0.0.1:5433; use your own database name per the test helpers and drop it afterwards.
  - web: `cd web && npx svelte-kit sync && npx svelte-check --threshold error`. Four known `./$types` errors in `routes/manifest.webmanifest/+server.ts` and `routes/cast-receiver/+server.ts` are an environment artifact.
  - e2e: from `e2e/`, `E2E_PORT=<free> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off`.

## Review Focus

1. **Sign-in before anyone is logged in, and during setup:** the public brand route must pass the setup gate (`app.ts:90,203-223`), and the sign-in page must show the brand on first paint without a flash of "FriendFlix" when a cached brand exists. Task 1 test `public brand passes the setup gate`; Task 3 e2e `sign-in shows the brand`.
2. **A hostile upload:**
   - a PNG with a `tEXt`/`eXIf`/`iTXt` chunk: the chunks are stripped;
   - a polyglot (an HTML or SVG body behind a PNG signature, or a wrong IHDR length): refused;
   - a > 2 MB body: 413;
   - a non-square symbol: refused;
   - WebP EXIF/XMP: stripped.

   Covered by the Task 1 tests.
3. **An accent that is too light** (`#f2e94e`) or **too dark** (`#1a1a40`): the derived tokens still meet every ratio, and the admin page shows "angepasst". Task 1 `brandColors` vectors.
4. **Another admin tab or person's tab open while the brand changes:** a refetch on focus/visibility plus after a save in the same tab; there is no reload loop. Task 2 test `refetches on visibility only when rev changed`.
5. **A long name or byline in narrow places** (phone header, TV sidebar): it ellipsizes without moving the layout. Task 3 e2e `long name ellipsizes`.

---

### Task 1: Backend — brand storage, colours, images, routes

**Files:**
- Create: `backend/src/brand/schema.ts`, `backend/src/brand/colors.ts`, `backend/src/brand/images.ts`, `backend/src/brand/repo.ts`, `backend/src/brand/routes.ts`
- Modify: `backend/src/db.ts` (migration 56: `brand(id smallint primary key check (id = 1), data jsonb not null, rev bigint not null default 0, updated_at timestamptz, updated_by uuid references users on delete set null)` and `brand_images(hash text primary key, mime text not null check (mime in ('image/png','image/webp')), width int not null, height int not null, bytes bytea not null, created_at timestamptz default now())`)
- Modify: `backend/src/app.ts` (register the routes; allow `/api/public/brand*` through the setup gate)
- Modify: `deploy/npm/portal.advanced.conf` (and any other shipped proxy config the recon lists) to allow a 3 MB body on `PUT /api/admin/brand/image/*`
- Test: `backend/test/brand-colors.test.ts`, `backend/test/brand-images.test.ts`, `backend/test/brand-routes.test.ts`
- Create: `test-vectors/brand-colors.json` (shared with the web; see the vectors below)

**Interfaces (produced):**
- `type Brand` (the fields from Global Constraints) and `brandSchema` (zod).
- `DEFAULT_BRAND: Brand`.
- `deriveTokens(accent: string): BrandTokens`, where
  `BrandTokens = { acc: string; accHover: string; accFill: string; accFillHover: string; accText: string; accLight: string; accLine: string; adjusted: { text: boolean; fill: boolean } }`.
  It is pure and adjusts lightness in steps (OKLCH or HSL) until the ratios in Global Constraints hold. For the default accent it returns today's values with `adjusted.fill = true`, because today's fill is a darker shade.
- `contrast(a: string, b: string): number` (WCAG).
- `sanitizeImage(buf: Buffer, kind: 'symbol'|'logo'|'signIn'): { bytes: Buffer; mime; width; height; hash }`. It throws a `BrandImageError` with code `type` | `size` | `dimensions` | `corrupt`.
  - PNG: verify the signature and the chunk CRCs; keep only `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND`, `sRGB`, `gAMA`, `cHRM`.
  - WebP: verify the RIFF/WEBP header; keep only `VP8 `, `VP8L`, `VP8X` (with its EXIF/XMP flags cleared), `ALPH`, `ANIM`/`ANMF`; drop `EXIF`, `XMP `, `ICCP`.
  - The dimensions come from IHDR / VP8*.
- Routes:
  - `GET /api/public/brand` returns `{ rev, brand: PublicBrand, tokens: BrandTokens, images: { logo?: url, symbol?: url, signIn?: url } }`. It sends an `ETag` of the rev and is reachable without a session and during setup.
  - `GET /api/public/brand/img/:file` serves an image by `<hash>.<png|webp>`, with the headers from Global Constraints. 404 for an unknown hash.
  - `GET /api/admin/brand` (admin) returns the full brand with its rev.
  - `PUT /api/admin/brand` (admin): body `{ rev, brand }`. A stale rev gives 409 `brand_conflict`. Validates, saves, audits `brand.update` with the changed keys, bumps the rev and publishes on the existing settings bus channel, if the recon shows one usable for a rev ping.
  - `PUT /api/admin/brand/image/:kind` (admin) takes a raw body (`image/png` or `image/webp`), copying the livetv logo raw-body pattern (`livetv/adminRoutes.ts:601-621`) with a 2 MB limit. It sanitizes, stores the image deduplicated by hash, and returns `{ hash, url, width, height }`. It does not set the brand field; the following PUT of the brand does.
  - `POST /api/admin/brand/reset` (admin) restores the defaults and audits `brand.reset`.
  - Images no longer referenced are deleted on save, after 1 hour (only those not referenced and older than 1 h).

- [ ] **Step 1: Failing tests.**
  - `brand-colors.test.ts` runs vectors from `test-vectors/brand-colors.json`, with at least these accents: the default `#ff4f6d` (the exact table above), `#a37cff`, `#4c9dff`, `#2fc4b2`, `#f2b52c`, `#5ccf6a`, `#f2e94e` (too light), `#1a1a40` (too dark), `#ffffff`, `#000000`. For each, every ratio in Global Constraints holds, and `adjusted` matches the vector.
  - `brand-images.test.ts` uses fixtures built in-test (a tiny PNG made with zlib and CRC; a tiny WebP from a known byte string). Cases:
    - a `tEXt` chunk is stripped and the result is still valid;
    - a bad CRC gives `corrupt`;
    - a PNG signature followed by `<svg` gives `corrupt`;
    - a JPEG gives `type`;
    - a 300×300 symbol gives `dimensions`;
    - a 3 MB body gives `size`;
    - WebP EXIF and XMP are stripped and the VP8X flags cleared;
    - the hash is the sha256 of the sanitized bytes.
  - `brand-routes.test.ts`:
    - public GET without a session gives 200 and the defaults;
    - `public brand passes the setup gate` (an instance in setup mode returns 200 here);
    - a non-admin PUT gives 403;
    - an admin PUT saves, bumps the rev and writes the audit row with field names;
    - a stale rev gives 409;
    - an invalid name (empty, 25 chars, control chars) or a bad hex gives 400 with the field;
    - an image upload stores and dedups by hash;
    - the image GET returns the headers;
    - reset gives the defaults;
    - the public payload never contains `updated_by`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the files and migration 56.
- [ ] **Step 4: Run** the tests plus `npx tsc --noEmit -p backend`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): brand storage, contrast-safe colours, sanitized images and the public brand route`.

### Task 2: Web — brand store, tokens, title, icons, manifest, i18n `{app}`

**Files:**
- Create: `web/src/lib/brand.ts`, `web/src/lib/brand.test.ts`, `web/src/lib/brandColors.ts` (a port of `deriveTokens`/`contrast`, tested against the same `test-vectors/brand-colors.json`)
- Modify:
  - `web/src/routes/+layout.svelte`: load the brand at boot, before the auth check;
  - `web/src/app.html`: an inline-free bootstrap; the existing title and meta stay as defaults;
  - `web/src/lib/manifest.ts` and `web/src/routes/manifest.webmanifest/+server.ts`: the server route fetches the backend's public brand internally (the URL from the same env the other server routes use) and falls back to the defaults on error;
  - `web/src/lib/i18n/index.ts`: a global default param `app`, so every `{app}` in messages gets the brand name unless a caller passes one;
  - the ~30 locale strings that embed "FriendFlix" (all 7 locales; the recon lists them) become `{app}`, keeping the key order.

**Interfaces (produced):**
- `brand: Readable<LoadedBrand>`, where `LoadedBrand = { rev: number; brand: PublicBrand; tokens: BrandTokens; images: {...}; name: string /* shortName fallback applied where needed */ }`.
- `loadBrand(fetchFn?): Promise<void>`: fetches `/api/public/brand`. It caches the last result in `localStorage` (`ff.brand`, try/catch guarded) and applies the cached one synchronously at boot, so there is no flash.
- `applyBrand(b: LoadedBrand, doc = document): void`:
  - sets `--acc`, `--acc-hover`, `--acc-fill`, `--acc-fill-hover`, `--acc-text`, `--acc-light`, `--acc-line` on `documentElement.style`;
  - adds the class `glow-<mode>` on `<html>`;
  - sets `document.title` through the existing pageTitle logic;
  - updates the `meta[name=apple-mobile-web-app-title]` content;
  - swaps the `link[rel=icon]` and `link[rel=apple-touch-icon]` hrefs to the symbol URL when there is one;
  - sets `meta[name=theme-color]`.
- `refetchOnVisible()`: refetches when the tab becomes visible and applies only if the rev changed.
- After an admin save, the admin page calls `loadBrand()`.

- [ ] **Step 1: Failing tests** in `brand.test.ts` (with a fake document, as other web units do):
  - `applies tokens as inline custom properties`;
  - `cached brand applies before the fetch resolves`;
  - `refetches on visibility only when rev changed`;
  - `no symbol keeps the default icons`;
  - `{app} in a message uses the brand name`;
  - `brandColors matches the backend vectors`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/brand.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `app.css` add `html.glow-accent`, `glow-neutral` and `glow-off` variants of the `.frost-amb` gradient (`app.css:208-214`); `glow-accentViolet` is today's.
- [ ] **Step 4: Run** the tests, the i18n key-order test (`npx vitest run src/lib/i18n`) and svelte-check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): the web loads the brand before sign-in and applies its colours, name, icons and manifest`.

### Task 3: Web surfaces show the brand; hard-coded corals become tokens

**Files:**
- Modify: `web/src/lib/Logo.svelte` (three header styles from `brand.header`), `lib/desk/DeskBar.svelte`, the phone header in `routes/+layout.svelte`, `lib/auth/AuthShell.svelte` (name, byline, symbol; sign-in background `posters` (today) | `image` (the uploaded sign-in image, dimmed by the same gradient) | `color` (just the glow)), `lib/Footer.svelte` (byline), `lib/Intro.svelte`, the TV start screen and the TV sidebar wordmark (find them in `lib/tv` / the TV layout; the recon lists the files), `lib/cast/receiverPage.ts` (name and symbol on the receiver idle screen), `sw/push.ts` (the default notification title is the brand name from the last cached brand), `lib/wrapped.ts`
- Modify: the ~20 files with hard-coded coral literals (the recon lists them: `lib/auth/auth.css:11,39,40`, `Logo.svelte`, `wrapped.ts`, `TvRail`, `DeskBar`, …). Each literal becomes the matching token: `var(--acc)`, `var(--acc-fill)` or `var(--acc-light)`.
- Test: `e2e/tests/brand.spec.ts`, `e2e/tests/brand.mobile.spec.ts`, plus the mock for `/api/public/brand` in the e2e fixtures (the default brand, overridable per test)

- [ ] **Step 1: Failing e2e:**
  - `sign-in shows the brand`: the mock brand is "Nordlicht Kino", byline "by Anna Beispiel", accent `#4c9dff`. The sign-in shows the name and byline, and the primary button background equals the derived fill.
  - `header styles`: wordmark, symbol plus name, logo image.
  - `tab title uses the brand`.
  - `no coral left when the accent is blue`: sample the computed colours of the primary button, the active nav underline and the progress bar.
  - `long name ellipsizes`: a 24-char name in the phone header and the desktop header, with no overflow and the bounding boxes of the neighbours unchanged.
  - `TV start screen shows the name and byline` (the TV spec pattern).
  - `default brand looks like today`: the existing visual assertions stay green.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the surfaces and token replacements. Grep for `#ff4f6d`, `#d6325a`, `#e63e5c`, `#c9304d`, `#ff8aa0`, `#ff9cad` and `255, 79, 109` / `214, 50, 90` across `web/src`. Leave a literal only where it is not the brand accent (for example the error red), with a comment.
- [ ] **Step 4: Run** the new specs plus the existing specs touching these surfaces (auth, layout, tv, cast receiver: grep `e2e/tests` for each file's selectors). Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): every surface shows the brand; the accent follows it everywhere`.

### Task 4: Admin → Branding page (Identity, Logo & symbol, Colours & mood) with live preview

**Files:**
- Create: `web/src/routes/admin/branding/+page.svelte`, `web/src/lib/admin/branding/*` (`model.ts` for the staged-edits model and validation messages; `imageResize.ts` for the canvas resize and re-encode to PNG; `Preview.svelte` with Desktop / Telefon / TV / Anmeldung panes; a `Swatches.svelte` contrast readout)
- Modify: the admin navigation (a new entry "Branding" under Einstellungen, after Einstellungen; find the admin nav in `routes/admin/+layout.svelte`), 7 locales (`admin.branding.*`, identical key order)
- Test: `web/src/lib/admin/branding/model.test.ts`, `imageResize.test.ts` (pure size maths), `e2e/tests/admin-branding.spec.ts`, `e2e/tests/admin-branding.mobile.spec.ts`

**Interfaces (consumed):** Task 1 routes, Task 2 `loadBrand` / `brandColors`.

The page follows the mockup's tabs Identität, Logo & Symbol, Farben & Stimmung. Texte, Rechtliches & Hilfe and Teilen & E-Mails are Stage B and are not shown yet.

- **Fields:** the fields with their limits.
- **Uploads:** the symbol is resized in the browser to 512×512 PNG (cover-crop centred, with a crop preview). The logo fits within 2048×512 and the sign-in image within 2560×1600, then each is uploaded and the hash staged.
- **Accent:** six presets plus a hex field; the contrast readout comes from `brandColors` ("angepasst" when adjusted).
- **Glow** and **sign-in background:** segmented controls.
- **Preview:** Desktop / Telefon / TV / Anmeldung, live from the staged values, using the same components where cheap, otherwise a faithful mini rendering like the mockup.
- **Save:** the existing admin save bar pattern; on a 409, reload with a message. Reset asks a confirm through `confirm()` and then calls the reset route. Leaving with unsaved edits asks (the existing `leaveGuard`).

- [ ] **Step 1: Failing tests:**
  - `model.test.ts`: validation messages for each field limit; staged diff; `isDirty`.
  - `imageResize.test.ts`: the cover-crop maths for 1000×600 → 512×512 and 400×400, the latter refused under 512.
  - e2e:
    - change the name and accent, and the preview updates live;
    - save calls PUT with rev;
    - a 409 shows the conflict message;
    - reset asks and then resets;
    - an upload calls the image route with `image/png`;
    - the Branding nav entry is visible to admins only;
    - phone layout: tabs scroll and the preview sits below the form.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit tests, both e2e specs, svelte-check and the i18n test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): Admin → Branding with identity, logo, colours and a live preview`.

### Task 5: Docs, CHANGELOG, coverage

**Files:**
- Create: `docs/branding.md`. Cover what can be branded and where it shows; the native app launcher names stay; the AGPL source link stays; the image rules; how to set "by AetherSpire" style bylines.
- Modify: `CHANGELOG.md` (`[Unreleased]` → Admin: one bullet), `README.md` (one line under features), and the docs index if one exists.
- [ ] **Step 1:** Write the docs and the CHANGELOG entry.
- [ ] **Step 2:** Run `cd web && npx vitest run --coverage` once and confirm statements ≥ 94 %. If not, add unit tests for the uncovered branding modules.
- [ ] **Step 3: Commit** `docs(brand): branding guide and changelog`.

Stage B (texts, legal and help, OpenGraph via a new server handler plus a public share route, sender name, export and import, maintenance message) gets its own plan after Stage A merges.
