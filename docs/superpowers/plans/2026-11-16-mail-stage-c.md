# E-mail, Stage C: weekly recap by mail, admin alerts, Authentik mails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can get the weekly recap as a mail (opt-in), admins get mail when an update is available or failed, a Systemcheck line turns into a problem, or disk or recordings storage runs full (each switchable), and Authentik's own reset and confirmation mails look like FriendFlix's, with an optional admin action that copies the brand and the sender (and, only on explicit consent, the SMTP settings) into Authentik.

**Architecture:**
- **Mail types:** five new switch types in `user_prefs.data.mail`: `digest` for everyone (default off) and four admin-only types (default on). Admin types reach only active admins with an address; the worker's last check drops a mail whose recipient stopped being an admin.
- **Admin alerts are notices:** each alert is a `notifyAdmins()` notice with `Notice.mail` set, so the mail is the stage B channel of a notice (one event system, the notice dedupe is the durable "once"). New code only detects the events: `adminAlerts.ts` (update available tick, Systemcheck tick, disk check after each health snapshot) plus hooks in `updater.ts` and the two existing recordings-storage notices.
- **Digest mail:** `sendDigest` queues a `digest` outbox row with compact params (names, counts) next to the in-app notice; its own template renders titles as text lists (the layout gains `sections`), with the stage B unsubscribe link and headers.
- **Authentik:** four standalone template files in `deploy/authentik/templates/` share one FriendFlix shell; `POST /api/admin/authentik/branding` patches the Authentik brand (title, logo URL) and the recovery flow's e-mail stage (sender; SMTP only with `smtp: true` and a fresh sign-in), reporting each part on its own.
- **Follow-up from stage B:** `/confirm-email`'s *Zum Konto* links load the page in full.

**Tech Stack:** Fastify, Postgres (no migration in this stage), zod 4, nodemailer 10.3.1 (already in), SvelteKit SPA, vitest, Playwright e2e with mocks. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-16-mail-design.md` (sections "Authentik (stage C)", "Admin alerts and digest (stage C)", "Stages"). As built: stage A and B code in `backend/src/mail/*`, `backend/src/notify.ts` (`Notice.mail`), `web/src/lib/account/MailCard.svelte`, `web/src/routes/mail/unsubscribe/+page.svelte`; plans `docs/superpowers/plans/2026-11-16-mail-stage-a.md` and `…-stage-b.md` (their Controller's calls still apply).

## Controller's calls (stage C)

1. **Type names and defaults.** `digest` (person, default **off**: the spec says opt-in) and the admin types `update`, `updatefailed`, `syscheck`, `storage` (default on). Letters only, so the unsubscribe token format `[a-z]{1,20}` (backend and web regex) stays as it is. Admin types are mailed only to `role = 'admin'` accounts that pass stage B's active-account rule and have a valid address; `GET /api/account/mail` lists them only for admins, a non-admin's `PUT` of one answers 403 `admin_only`, the unsubscribe link works for them like for any type. Reason: the spec's "each admin can switch each off" and "Recipients = active admins with an address".
2. **Alerts are admin notices** (in-app for every admin, plus mail through `Notice.mail`). Reason: stage B call 10 ("mail is a channel of a notice, not a second event system"); `notifications.dedupe` is durable (never pruned), the outbox key alone is not (30-day retention).
3. **Update available.** An hourly timer; the check runs at most every 6 h across instances (kv `alerts:update:tick`, `setnx`, TTL 21 600 s) through `updateInfo(ctx)` (GitHub answers cached 10 min) and fires only on `updateAvailable === true`. Dedupe ("once per version"): stable `update-avail-stable-<release.version>`, pinned `update-avail-pinned-<UPDATE_VERSION>`, nightly `update-avail-nightly-<ISO week, e.g. 2026-W47>` (a nightly build appears almost daily: at most one mail a week). Skipped while `AUTO_UPDATE = 'nightly-window'` and `UPDATER_URL` is set: the update installs itself overnight and a failure mails (call 4).
4. **Update failed.** In `reconcileAudit` (exactly once per job: the pending kv entry is taken atomically): actions `update`, `self-update`, `rollback` with result `failed` **or** `rolled_back` (the new version did not come up), dedupe `update-failed-<job id>`. Plus the automatic Portainer redeploy that fails in `autoUpdateTick`, dedupe `update-failed-portainer-<target>-<yyyy-mm-dd>`. Livetv jobs never alert. A manual Portainer redeploy shows its error on screen and does not alert.
5. **Systemcheck problem.** A 15-minute timer, one instance per run (kv `alerts:syscheck:tick`, `setnx`, TTL 840 s), reading `getSystemcheck(ctx)` (the cached result; a stale one is rebuilt in the background and seen next run), only lines with `runs: 'server'`. A line *turns* `problem` when it is `problem` now and was not in the previous run's set (kv `alerts:syscheck:prev`, JSON array of ids, TTL 86 400 s; missing = empty, so lines already in problem at the first run after the deploy alert once). Each line at most once per server-local day (kv `alerts:syscheck:<id>:<yyyy-mm-dd>`, `setnx`, TTL 172 800 s). All lines that turn in one run make **one** notice naming their groups, dedupe `syscheck-<yyyy-mm-dd>-<sorted ids joined by ",">`. A problem that persists does not repeat. Reason: a database or Authentik outage flips several lines at once; one mail, not six.
6. **Disk and recordings storage.** After each successful `healthTick` rebuild: disks `downloads` and `previews` with level `warn` or `err` and reason `full` or `low_free` (not `cap`, not the database's `large`) → one notice per disk, level and server-local day (kv short-circuit `alerts:disk:<id>:<level>:<yyyy-mm-dd>`, `setnx`, TTL 172 800 s, so the 60-s tick does not re-run `notify()`; dedupe `disk-<id>-<level>-<yyyy-mm-dd>`), repeated daily while it lasts, and `err` after `warn` on the same day alerts again. The two existing `livetv.rec.storage` admin notices (already once a day) gain `mail: 'storage'`. Reason: a filling disk keeps getting worse, unlike a Systemcheck line.
7. **Digest mail is independent of `weeklyDigest`** (stage B call 8: mail switches are independent of the other channels). The tick selects accounts with `weeklyDigest` on **or** `mail.digest = true`; `sendDigest` posts the in-app notice only when `weeklyDigest` is on (or for the admin's test) and always calls `mailPerson(…, 'digest', …)` (the switch decides), dedupe `digest:<userId>:<week>`; the admin's *Testdigest* mails too when that admin's switch is on, dedupe `digest-test:<userId>:<Date.now()>`. Content: subject and heading = the in-app headline; a range line; sections *Neue Filme* (≤ 12 names, then "… und {n} weitere"), *Neue Folgen* (≤ 20 series, followed first, "Name (n neue Folgen)"), *Deine Wünsche sind da* (≤ 20), *Empfehlungen für dich* (≤ 5, "Name – von Anna"); every name cut to 120 characters; plain text, no per-title links, no images; one button to `<origin>/digest`. Reason: the personal channel may name titles (spec); the `/digest` page has the links.
8. **Where the Authentik action lives:** *Admin → Einstellungen → Benachrichtigungen*, under the E-Mail card's status (`AuthentikSync.svelte`), only when the Authentik API is configured. Reason: it carries the mail settings and their consent; title and logo are read from Branding and only shown.
9. **What it writes.** Brand: the one whose `domain` equals the host of `OIDC_ISSUER`, else the one with `default: true`; `branding_title` = brand name; `branding_logo` = `<PUBLIC_URL origin>/api/public/brand/img/<hash>.<ext>` of the logo, else of the symbol, else not sent (also not sent without `PUBLIC_URL`). Stage: the first e-mail stage of `AUTHENTIK_RECOVERY_FLOW || 'default-recovery-flow'` (`emailStageOf`); `from_address` = `<name> <MAIL_FROM>` (name with `<>",;\` and control characters removed; the bare address when nothing is left); only with `smtp: true`: `use_global_settings: false`, `host`, `port`, `username` (or `''`), `password` (or `''`), `use_tls` (`starttls`), `use_ssl` (`tls`), `timeout: 10`; TLS `none` sends `username: ''` and `password: ''` (stage A: `none` never logs in). `smtp: true` needs a sign-in at most 10 minutes old (401 `reauth_required`, like saving the password) and mail configured (400 `mail_not_configured`). Permissions `authentik_brands.view_brand`, `authentik_brands.change_brand`, `authentik_stages_email.change_emailstage` are **not** added to the blueprint (optional action, least privilege); `docs/authentik.md` lists them. Each part reports `done` / `skipped` / `failed` with a code and, for a refusal, the missing permission's codename. The password exists only in the PATCH body to Authentik.
10. **Authentik templates.** `friendflix-recovery.html` and `friendflix-email-change.html` are restyled in place (same names, same single link, same first-line comment: nothing for existing installs to redo), plus `friendflix-reset.html` (Authentik's own reset link `{{ url }}`, for installs without the in-app sign-in) and `friendflix-confirm.html` (the enrollment flow's address confirmation, `{{ url }}`). Standalone files (no `{% extends %}`, so copying one file is enough); the shell between `{# ff:head #}`…`{# /ff:head #}` and `{# ff:foot #}`…`{# /ff:foot #}` is byte-identical in all four. Light layout with stage A's colours, the default accent's `accFill`, the letter tile "F" and the name "FriendFlix" (Authentik cannot read FriendFlix's brand; the docs name the two lines to edit). Texts English with `{% trans %}`, like the existing files.
11. **No migration, no new kv data beyond the `alerts:*` day keys** (counters and day keys, the allowed use of kv).

## Global Constraints

- **Secrets and personal data never reach a log, an audit row, an error text or an API answer:** the SMTP password (also never in an Authentik diagnostics record), unsubscribe and invite tokens, full e-mail addresses, the Authentik token. Logs and audit rows carry codes only; an address appears at most masked (`maskAddress`). The SMTP password is sent to Authentik only with `smtp: true`.
- **Never "Netflix" or "Seerr"** in user-facing text, code comments or docs ("request service" / "Wünsche").
- **Fictional names and placeholder hosts only:** Anna Beispiel, Ben Muster, Nordlicht TV; `friend.example.com`, `mail.example.com`, `auth.example.com`, `192.0.2.x`; test addresses `anna@friend.example.com`, `ben@friend.example.com`, sender `kino@friend.example.com`; test password `hunter2-fixture`.
- **7 locales** de, en, es, fr, it, pl, tr with identical key order (web locale files and `backend/src/messages.ts`); German is the source, "du" form, real umlauts; "…" not "...".
- **UI:** animate only transform/opacity; never scale text; nothing may jump (reserve space for results and errors, no layout shift); 44 px touch targets (36 px for mouse-only controls); glass look (`.frost`, `--fr-r-*`), brand tokens `--acc*`.
- **Docker socket** only for docker-proxy, never for web, backend, gateway or livetv.
- **Web coverage gate** ≥ 94 % statements.
- **Checks agents run:** typecheck, the specific tests, build, lint; CI runs the rest. Backend typecheck `cd backend && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`; web `cd web && npx svelte-kit sync && npx svelte-check --threshold error` (4 known env errors in `routes/manifest.webmanifest/+server.ts` and `routes/cast-receiver/+server.ts`); `npm run build -w web`; `npx eslint <touched files>`. Backend vitest with a private database: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/ff_test_mailc`. e2e from `e2e/`: `E2E_PORT=<free> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off`. `node_modules` are symlinks: never `npm install`.
- **gitleaks:** a token-shaped string in an e2e or backend test (unsubscribe tokens of the new types, a fake Authentik token) must not trip `generic-api-key`: build it from short pieces (`'v1.' + id + '.digest.' + mac`), or add its fingerprint to `.gitleaksignore` in the same commit (as `1f922e87` did).
- **Git:** merge, never rebase or force-push; never `git stash`. Every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- **Exact values:**

  | What | Value |
  |---|---|
  | Types | `PERSON_MAIL_TYPES = ['available','recording','licence','digest']`, `ADMIN_MAIL_TYPES = ['update','updatefailed','syscheck','storage']`, `MAIL_PREF_TYPES = [...PERSON, ...ADMIN]`; default on except `digest` |
  | Dedupe (notice) | `update-avail-<channel>-<target>`, `update-failed-<jobId>`, `update-failed-portainer-<target>-<day>`, `syscheck-<day>-<ids>`, `disk-<id>-<level>-<day>`; outbox `n:<dedupe>-<adminId>` (notifyAdmins appends the id) |
  | Dedupe (digest) | `digest:<userId>:<week>`, test `digest-test:<userId>:<ms>` |
  | kv | `alerts:update:tick` 21 600 s; `alerts:syscheck:tick` 840 s; `alerts:syscheck:prev` 86 400 s; `alerts:syscheck:<id>:<day>` and `alerts:disk:<id>:<level>:<day>` 172 800 s |
  | Timers | update alert 3 600 s; Systemcheck alert 900 s; disk: inside `healthTick` (60 s) |
  | Links | update `/admin/update`, Systemcheck and disk `/admin/status`, recordings `/admin/livetv`, digest `/digest` |
  | Authentik route | `GET`/`POST /api/admin/authentik/branding`, POST 6/min, audit `authentik.branding` |
  | Day | server-local `yyyy-mm-dd` (like `digest.ts` `weekKey`) |

## Review Focus

1. **A non-admin with admin switches stored as on, or an admin demoted while an alert mail waits:** never mailed an admin alert; a non-admin cannot set an admin switch. Task 1 tests `admin types never reach a non-admin`, `worker drops an admin mail after a demotion`, `PUT of an admin type as a non-admin answers 403`.
2. **Alert storms:** a cascade (several Systemcheck lines at once), a flapping line, a persistent problem, two instances ticking together, a disk full for days: one mail per run, at most one per line per day, none for a problem that stays, one per disk and level per day. Task 3 tests `several lines turning in one run make one notice`, `a flapping line alerts once a day`, `a problem that stays alerts once`, `two runs at once alert once`, `a full disk alerts once a day and again on escalation`.
3. **The SMTP password reaching anything but Authentik, or Authentik without consent:** absent from every request without `smtp: true`; with it, only in the one stage PATCH; never in the answer, an audit row, a log line or kv. Task 6 tests `without consent no request carries a password`, `with consent only the stage PATCH carries it`, `consent without a fresh sign-in answers 401 and calls nothing`.
4. **A token that may read but not change:** the admin sees which part failed and which permission is missing, the other part still applies. Task 6 tests `brand refused, stage done` and `stage refused names change_emailstage`.
5. **The weekly digest with only one channel on** (in-app off and mail on, or the reverse), and the deploy (`digest` default off: nobody gets a digest mail until they opt in): Task 2 tests `mail only when weeklyDigest is off`, `in-app only when the mail switch is off`, `nobody is mailed by default`.

---

### Task 1: The new mail types, admin-only switches, and admin notices as mail

**Files:**
- Modify: `backend/src/mail/people.ts` (types, defaults, admin rule), `backend/src/mail/templates.ts` (`prefMail` covers the admin kinds; `KIND_LINE`), `backend/src/mail/worker.ts` (the `not_admin` drop code is logged like the others), `backend/src/mail/personRoutes.ts` (admin flag and filter), `backend/src/messages.ts` (keys below, 7 languages)
- Test: extend `backend/test/mail-people.test.ts`, `backend/test/mail-render.test.ts`, `backend/test/mail-notify.test.ts`, `backend/test/mail-outbox.test.ts`, `backend/test/mail-person-routes.test.ts`

**Interfaces:**
- Produces (`mail/people.ts`): `PERSON_MAIL_TYPES`, `ADMIN_MAIL_TYPES`, `MAIL_PREF_TYPES` (Global Constraints), `type AdminMailType`, `isAdminMailType(v: unknown): v is AdminMailType`, `MAIL_PREF_DEFAULTS: Readonly<Record<MailPrefType, boolean>>`; `readMailPrefs` returns all eight (missing or non-boolean → the default); `mailRecipient` returns null for an admin type unless `u.role = 'admin'`; `PersonMailBlock` gains `'not_admin'` (an admin type whose recipient's role is no longer `admin`), checked in the same query.
- Produces (routes): `GET /api/account/mail` → `{ configured, hasAddress, admin: boolean, prefs }` where `prefs` holds the person types, plus the admin types when `admin`; `PUT /api/account/mail` accepts every `MAIL_PREF_TYPES` value, an admin type from a non-admin → 403 `{ error: 'admin_only' }`, nothing written.
- Produces (`Notice.mail?: MailPrefType`, unchanged type name, now with the admin types): `notifyAdmins(ctx, { …, mail: 'storage' })` mails every admin whose switch is on, outbox kind = the type.
- Template: an admin kind is a pref-kind mail (stage B shape: title, body or the fallback line `mail.fallback.body`, button `mail.<kind>.button` to the notice link, reason `mail.<kind>.reason`, settings and unsubscribe links, `List-Unsubscribe` headers). `digest` is not rendered here (Task 2).
- German source strings: `mail.update.button` 'Zum Update', `mail.update.reason` 'Du bekommst diese E-Mail, weil du Admin von {app} bist und E-Mails zu neuen Versionen eingeschaltet hast.'; `mail.updatefailed.button` 'Zum Update', `….reason` '… zu fehlgeschlagenen Updates …'; `mail.syscheck.button` 'Zum Systemcheck', `….reason` '… zu Problemen im Systemcheck …'; `mail.storage.button` 'Details ansehen', `….reason` '… zu knappem Speicherplatz …'.

- [ ] **Step 1: Write the failing tests:**
  - `mail-people.test.ts`:
    - `prefs default: digest off, everything else on`: no row → `{ available: true, recording: true, licence: true, digest: false, update: true, updatefailed: true, syscheck: true, storage: true }`.
    - `admin types never reach a non-admin`: Ben (`role = 'friend'`) with `data.mail = { update: true }` → `mailRecipient(ctx, ben, 'update') === null`; Anna (`admin`) → `{ to: 'anna@friend.example.com', … }`; a disabled admin → null.
    - `personMailBlock answers not_admin after a demotion`: Anna's `update` row queued, then `role = 'friend'` → `'not_admin'`.
    - `token round-trip for the new types`: `verifyUnsubscribeToken(k, unsubscribeToken(k, anna, 'updatefailed'))` → `{ userId: anna, type: 'updatefailed' }`; the same for `digest`.
  - `mail-notify.test.ts`: `notifyAdmins with mail queues one row per admin with the switch on`: admins Anna (switch on) and Carla (`storage` off), friend Ben → `notifyAdmins(ctx, { kind: 'livetv.rec.storage', title: 'x', link: '/admin/livetv', dedupe: 'ltvrec-storage-2026-11-16', mail: 'storage' })` → two in-app rows (Anna, Carla; none for Ben), one outbox row `kind = 'storage'` for Anna with `dedupe = 'n:ltvrec-storage-2026-11-16-<anna id>'`.
  - `mail-outbox.test.ts`: `worker drops an admin mail after a demotion`: a queued `update` row for Anna, Anna demoted, `mailTick` → the row is gone, nothing sent, the log line carries `code: 'not_admin'` and no address.
  - `mail-render.test.ts`: `admin kinds render as notice mails with unsubscribe`: `renderMail(ctx, 'syscheck', 'de', { title: 'Systemcheck: ein neues Problem', body: null, link: '/admin/status' }, { userId: anna })` → button `https://friend.example.com/admin/status` labelled `Zum Systemcheck`, `List-Unsubscribe` with `unsubscribeToken(encKey, anna, 'syscheck')`, the text contains the `mail.syscheck.reason` sentence.
  - `mail-person-routes.test.ts`:
    - `account mail lists admin types only for admins`: Ben → `admin: false`, `Object.keys(prefs)` = the four person types; Anna → `admin: true`, all eight.
    - `PUT of an admin type as a non-admin answers 403`: Ben `{ type: 'update', on: false }` → 403 `admin_only`, no `user_prefs` change; Anna → 200 `prefs.update === false`.
    - `one-click unsubscribe works for digest and admin types`: Anna's `storage` token → 200 `{ type: 'storage', on: false }`.
- [ ] **Step 2: Run** `cd backend && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/ff_test_mailc npx vitest run test/mail-people.test.ts test/mail-notify.test.ts test/mail-outbox.test.ts test/mail-render.test.ts test/mail-person-routes.test.ts`. Expected: FAIL (unknown types, no `admin` flag, no role rule).
- [ ] **Step 3: Implement** the types and defaults, the role condition in `mailRecipient` and `personMailBlock` (one query each, as today), the route changes, the template cases and the message keys.
- [ ] **Step 4: Run** the same files plus `test/i18n-messages.test.ts test/export.test.ts test/mail-welcome.test.ts`, backend typecheck, eslint on touched files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): digest and admin alert mail types, admin-only switches`.

### Task 2: The weekly recap as a mail

**Files:**
- Modify: `backend/src/mail/html.ts` (`LayoutInput.sections`), `backend/src/mail/templates.ts` (kind `digest`), `backend/src/digest.ts` (`digestMailParams`, `sendDigest`, the tick's account query), `backend/src/routes/digest.ts` (`POST /api/admin/digest/test` answers `mailed` too), `backend/src/messages.ts`
- Test: extend `backend/test/mail-render.test.ts`, `backend/test/digest.test.ts`

**Interfaces:**
- Consumes: Task 1 `digest` type and default; stage B `mailPerson`, `unsubscribeToken`, `unsubscribeUrls`.
- Produces (`html.ts`): `LayoutInput.sections?: Array<{ heading: string; items: string[] }>`, rendered after the paragraphs and before the button: a bold 16 px heading cell, one table row per item (`•` + escaped text, no `<ul>`); plain text: the heading, then `- item` lines, then a blank line.
- Produces (`digest.ts`):
  ```ts
  export interface DigestMailParams {
    headline: Text; since: string; until: string;
    movies: { names: string[]; total: number };
    series: Array<{ name: string; count: number; followed: boolean }>;
    wishes: string[];
    recs: Array<{ name: string; from: string }>;
  }
  export function digestMailParams(d: DigestData): DigestMailParams
  ```
  (caps and the 120-character cut from Controller's call 7; `headline` = `digestText(d).title`). `sendDigest(ctx, user, w, test = false): Promise<{ sent: boolean; mailed: boolean; data: DigestData | null }>` (`sent` = the in-app notice was created; `mailed` = an outbox row was queued). The tick's query: `(coalesce(p.data->>'weeklyDigest','true') <> 'false' or p.data->'mail'->>'digest' = 'true')`; it counts an account as sent when `sent || mailed`.
- Template `digest` (zod params mirroring `DigestMailParams`, parse failure throws): subject/heading = rendered `headline`; paragraph `mail.digest.range` with `{from}`/`{to}` as dates; sections in the order of Controller's call 7, empty ones left out, the "more" line as the last item when `movies.total > movies.names.length`; button `mail.digest.button` → `<origin>/digest`; reason `mail.digest.reason`; footer and headers as every pref kind (settings, unsubscribe, `List-Unsubscribe`).
- German source strings: `mail.digest.range` 'Neu in {app} vom {from} bis {to}.'; `mail.digest.movies` 'Neue Filme'; `mail.digest.series` 'Neue Folgen'; `mail.digest.wishes` 'Deine Wünsche sind da'; `mail.digest.recs` 'Empfehlungen für dich'; `mail.digest.episodes` `{ one: '{name} ({n} neue Folge)', other: '{name} ({n} neue Folgen)' }`; `mail.digest.rec` '{name} – von {from}'; `mail.digest.more` `{ one: '… und {n} weiterer', other: '… und {n} weitere' }`; `mail.digest.button` 'Zum Wochenrückblick'; `mail.digest.reason` 'Du bekommst diese E-Mail, weil du in {app} den Wochenrückblick per E-Mail eingeschaltet hast.'

- [ ] **Step 1: Write the failing tests:**
  - `mail-render.test.ts`:
    - `digest lists titles as text with sections`: params with movies `['Nordlicht', 'Polarnacht']` (total 14), one followed series `{ name: 'Nordlicht TV', count: 3, followed: true }`, one wish, one rec `{ name: 'Polarnacht', from: 'Anna Beispiel' }` → the text contains `Neue Filme\n- Nordlicht\n- Polarnacht\n- … und 12 weitere`, `- Nordlicht TV (3 neue Folgen)`, `- Polarnacht – von Anna Beispiel`, `Zum Wochenrückblick: https://friend.example.com/digest`; HTML has no `<img` besides the brand symbol's `cid:`, and no `href` other than the button, the footer links and the brand links.
    - `digest escapes names`: a movie `'<b>"Nordlicht"</b>'` → HTML contains `&lt;b&gt;&quot;Nordlicht&quot;&lt;/b&gt;`.
    - `digest carries the unsubscribe headers` with `unsubscribeToken(encKey, anna, 'digest')`.
    - `a full digest stays under 100 000 bytes`: 12 movies, 20 series, 20 wishes, 5 recs, every name 120 characters, with the 200 KB symbol.
    - `empty sections are left out` (no `Empfehlungen für dich` without recs).
  - `digest.test.ts` (mocked Jellyfin as the existing tests do; mail configured, `PUBLIC_URL` set):
    - `nobody is mailed by default`: a normal digest run → in-app notice as before, zero `digest` outbox rows.
    - `opted in: one mail per week`: `digest: true` → one row `kind = 'digest'`, `dedupe = 'digest:<id>:<week>'`; a second tick in the same window → still one.
    - `mail only when weeklyDigest is off`: `weeklyDigest: false`, `digest: true` → selected by the tick, zero notices of kind `digest`, one outbox row; `sendDigest` answers `{ sent: false, mailed: true }`.
    - `in-app only when the mail switch is off`: defaults → `{ sent: true, mailed: false }`.
    - `digestMailParams caps and cuts`: 30 movies, 25 series, names of 300 characters → 12 names, total 30, 20 series, every name ≤ 120 characters, followed series first.
    - `admin test digest mails when the admin opted in`: `POST /api/admin/digest/test` → `{ sent: true, mailed: true, data }`, the row's dedupe starts with `digest-test:`.
- [ ] **Step 2: Run** `cd backend && TEST_DATABASE_URL=… npx vitest run test/mail-render.test.ts test/digest.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the layout sections, the template, `digestMailParams`, the `sendDigest` and tick changes, the route's `mailed` and the message keys.
- [ ] **Step 4: Run** the same files plus `test/i18n-messages.test.ts test/mail-outbox.test.ts`, typecheck, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): the weekly recap as an opt-in mail`.

### Task 3: Admin alerts — update available, update failed, Systemcheck, disk and recordings storage

**Files:**
- Create: `backend/src/adminAlerts.ts`
- Modify: `backend/src/updater.ts` (`reconcileAudit` calls `updateFailedAlert`; `autoUpdateTick`'s failed Portainer path calls `portainerFailedAlert`), `backend/src/health.ts` (`healthTick` passes the rebuilt snapshot to `diskAlerts`, errors swallowed), `backend/src/livetv/recsched.ts` and `backend/src/livetv/recstore.ts` (the `livetv.rec.storage` notices gain `mail: 'storage'`), `backend/src/server.ts` (two timers, behind `op()` like the others, failures through `jobFailed`), `backend/src/messages.ts`
- Test: create `backend/test/admin-alerts.test.ts`; extend `backend/test/updater.test.ts`, `backend/test/livetv-recstore.test.ts`, `backend/test/health.test.ts`

**Interfaces:**
- Consumes: Task 1 admin types; `notifyAdmins`; `updateInfo`, `UpdateInfo`; `UpdaterJob`; `getSystemcheck`, `CheckId`, `CheckGroup`; `HealthSnapshot`, `DiskHealth`.
- Produces (`adminAlerts.ts`; `AlertCtx = Pick<Ctx, 'db' | 'kv' | 'cfg' | 'fetchImpl' | 'encKey'>`):
  - `dayKey(d: Date): string` (server-local `yyyy-mm-dd`), `isoWeek(d: Date): string` (`2026-W47`)
  - `updateAlertTick(ctx: Ctx, now?: Date): Promise<number>` (admins notified; 0 when locked, skipped, nothing new)
  - `updateFailedAlert(ctx: AlertCtx, job: UpdaterJob): Promise<number>`
  - `portainerFailedAlert(ctx: AlertCtx, target: string, now?: Date): Promise<number>`
  - `syscheckAlertTick(ctx: Ctx, now?: Date): Promise<CheckId[]>` (the lines alerted in this run)
  - `diskAlerts(ctx: AlertCtx, snap: HealthSnapshot, now?: Date): Promise<Array<DiskHealth['id']>>`
  - Notices (all `notifyAdmins`, `kind` / `title` / `body` / `link` / `mail`):
    - `update_available`, `m('notify.update.available.title', { version })` (stable/pinned: the version; nightly: `nightly · <7-char sha>`), `m('notify.update.available.body')`, `/admin/update`, `update`
    - `update_failed`, `m('notify.update.failed.title', { version: job.to })`, `m('notify.update.failed.body')`; Portainer: `m('notify.update.portainerFailed.title')`; `/admin/update`, `updatefailed`
    - `syscheck_problem`, `m('notify.syscheck.problem.title', { n })`, `m('notify.syscheck.problem.body', { groups: { join: [m('syscheck.group.<g>'), …], sep: ', ' } })` (groups in `CHECK_GROUPS` order, each once), `/admin/status`, `syscheck`
    - `disk_low`, `m(level === 'err' ? 'notify.disk.full.title' : 'notify.disk.almostFull.title', { disk: m('notify.disk.<id>'), pct: usedPct })`, `m('notify.disk.free.body', { free: '<n> GB' })` when `freeBytes` is known, `/admin/status`, `storage`
  - A failure after a kv claim deletes that claim and rethrows (stage B licence-tick pattern).
- German source strings: `notify.update.available.title` 'Neue Version verfügbar: {version}'; `notify.update.available.body` 'Unter Admin → Update siehst du, was neu ist, und installierst sie.'; `notify.update.failed.title` 'Update auf {version} fehlgeschlagen'; `notify.update.failed.body` 'Die bisherige Version läuft weiter. Was schiefging, steht unter Admin → Update.'; `notify.update.portainerFailed.title` 'Automatisches Update über Portainer fehlgeschlagen'; `notify.syscheck.problem.title` `{ one: 'Systemcheck: ein neues Problem', other: 'Systemcheck: {n} neue Probleme' }`; `notify.syscheck.problem.body` 'Betroffen: {groups}. Ursache und Lösung stehen unter Admin → Status.'; `syscheck.group.*` the web's `syscheck.group` words (Grundlagen, Anmeldung, Medien, Live-TV, Updates, Reverse Proxy); `notify.disk.almostFull.title` 'Speicher fast voll: {disk} zu {pct} % belegt'; `notify.disk.full.title` 'Speicher voll: {disk} zu {pct} % belegt'; `notify.disk.free.body` 'Noch {free} frei.'; `notify.disk.downloads` 'Offline-Downloads'; `notify.disk.previews` 'Vorschauen'.

- [ ] **Step 1: Write the failing tests** in `admin-alerts.test.ts` (admins Anna and Carla with addresses, friend Ben; mail configured; fake `updateInfo` via a stubbed GitHub `fetchImpl` or `vi.spyOn` on the updates module; fake Systemcheck via `resetChecksForTests` + `registerChecks`; server-local times built with `new Date(2026, 10, 16, 10, 0)`):
  - `update available notifies each admin once per version`: stable, release `3.6.0` newer → returns 2, two notices `update_available`, two `update` outbox rows; run again after the 6-h lock → 0, no new rows; release `3.6.1` → 2 again.
  - `the update check runs at most every 6 hours`: two calls 1 h apart → the second returns 0 without a GitHub request.
  - `nightly alerts at most once a week`: two nightly shas on different days of `2026-W47` → one notice; a sha in `2026-W48` → another.
  - `no update alert while the nightly window installs updates` (`AUTO_UPDATE = 'nightly-window'`, `UPDATER_URL` set) and `none when updateAvailable is false or null`.
  - `failed and rolled-back update jobs alert once`: `updateFailedAlert` with `{ action: 'update', state: 'rolled_back', id: 'job-7', to: '3.6.0' }` → 2; again → 0; `state: 'succeeded'` → 0; `action: 'livetv-enable', state: 'failed'` → 0.
  - `several lines turning in one run make one notice`: `signin.authentik`, `signin.flows` and `core.database` turn `problem` → one notice per admin, title `Systemcheck: 3 neue Probleme`, body names `Grundlagen, Anmeldung`, returns the three ids.
  - `a problem that stays alerts once`: the same lines on the next run → `[]`.
  - `a flapping line alerts once a day`: problem → ok → problem on the same day → one alert; the next day → a second.
  - `two runs at once alert once`: `Promise.all([syscheckAlertTick(ctx), syscheckAlertTick(ctx)])` → one non-empty result, one notice per admin.
  - `browser lines and warnings never alert` (`proxy.*` with `runs: 'browser'`, a `warning`).
  - `the first run after the deploy alerts lines already in problem` (no `alerts:syscheck:prev`).
  - `a full disk alerts once a day and again on escalation`: `downloads` `warn`/`full` 87 % → one notice; the same snapshot 60 s later → none; `err`/`full` 96 % the same day → one more; the next day `err` → one more; `cap` and the database's `large` → none.
- [ ] **Step 2: Extend** `updater.test.ts` (`a rolled-back update job reported through updaterView alerts the admins`: the pending entry exists, `updaterView` sees `rolled_back` → one `update_failed` notice per admin, audit as before; `the failed automatic Portainer redeploy alerts once per target and day`), `livetv-recstore.test.ts` (`storage notice mails the admins with the switch on`: one `storage` outbox row per admin, none for an admin who switched it off) and `health.test.ts` (`healthTick hands its snapshot to the disk alerts`: a 96 %-full fake volume → one `disk_low` notice; a throwing `diskAlerts` leaves the snapshot stored).
- [ ] **Step 3: Run** `cd backend && TEST_DATABASE_URL=… npx vitest run test/admin-alerts.test.ts test/updater.test.ts test/livetv-recstore.test.ts test/health.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `adminAlerts.ts`, the hooks, the two timers (`setInterval(() => { if (op()) void updateAlertTick(ctx).catch(jobFailed(ctx, app.log, 'update-alert', 'update alert tick failed')); }, 3_600_000)` and the same for `syscheckAlertTick` every 900 000 ms) and the message keys.
- [ ] **Step 5: Run** the same files plus `test/livetv-recsched.test.ts test/syscheck.test.ts test/i18n-messages.test.ts test/mail-notify.test.ts`, typecheck, eslint. Expected: PASS.
- [ ] **Step 6: Commit** `feat(mail): admin alerts for updates, Systemcheck problems and full storage`.

### Task 4: The E-Mails card and the unsubscribe page learn the new types

**Files:**
- Modify: `web/src/lib/account/mail.ts`, `web/src/lib/account/MailCard.svelte`, `web/src/lib/i18n/locales/*/account.ts` (`account.account.mail.types.*`, `account.account.mail.admin*`), `web/src/lib/i18n/locales/*/login.ts` (`login.unsubscribe.types.*`), `e2e/mocks/api.ts` (`/api/account/mail` answers `admin`)
- Test: extend `web/src/lib/account/mail.test.ts`, `e2e/tests/account.spec.ts`, `e2e/tests/account.mobile.spec.ts`, `e2e/tests/mail-unsubscribe.spec.ts`

**Interfaces:**
- Consumes: Task 1 `GET/PUT /api/account/mail` (`admin`, the filtered `prefs`, 403 `admin_only`).
- Produces (`lib/account/mail.ts`): `PERSON_MAIL_TYPES`, `ADMIN_MAIL_TYPES`, `MAIL_TYPES = [...PERSON_MAIL_TYPES, ...ADMIN_MAIL_TYPES]` (same order as the backend), `MailState = { configured: boolean; hasAddress: boolean; admin: boolean; prefs: Partial<Record<MailType, boolean>> }`; `unsubscribeType` accepts all eight.
- **Card:** the four person switches (the new one *Wochenrückblick*, hint *Jede Woche eine E-Mail mit neuen Filmen und Folgen, deinen Wünschen und Empfehlungen.*); for admins a sub-heading *Für Admins* and four switches: *Neue Versionen* (*Wenn eine neue Version bereitsteht, einmal pro Version.*), *Fehlgeschlagene Updates* (*Wenn ein Update nicht geklappt hat.*), *Probleme im Systemcheck* (*Wenn eine Zeile im Systemcheck zum Problem wird, höchstens einmal am Tag.*), *Speicherplatz* (*Wenn der Speicher für Downloads, Vorschauen oder Aufnahmen fast voll ist, einmal am Tag.*). The admin block is part of the first render (the page already waits for the mail state), so nothing appears late. Same lock rules and error line as stage B.
- **Unsubscribe page:** `login.unsubscribe.types` gains `digest` *deinem Wochenrückblick*, `update` *neuen Versionen*, `updatefailed` *fehlgeschlagenen Updates*, `syscheck` *Problemen im Systemcheck*, `storage` *knappem Speicherplatz*.

- [ ] **Step 1: Write the failing tests:**
  - `mail.test.ts`: `unsubscribeType` → `'digest'`, `'updatefailed'`, `'storage'` for well-formed tokens; `MAIL_TYPES` equals the eight in backend order; `loadMailPrefs` passes `admin` through.
  - `account.spec.ts`: `mail card shows the recap switch off by default`; `an admin sees the admin switches and saves one` (PUT body `{ type: 'syscheck', on: false }`); `a non-admin sees no admin switches` (no *Für Admins* heading, four switches).
  - `account.mobile.spec.ts`: with the admin block, every switch ≥ 44 px, no horizontal overflow, the card's bounding box does not change between the first paint and 1 s later.
  - `mail-unsubscribe.spec.ts`: `a digest token names the recap` (*Keine E-Mails mehr zu deinem Wochenrückblick?*) and `an admin type token names it` (`storage` → *knappem Speicherplatz*). Tokens built from pieces (Global Constraints, gitleaks).
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/account/mail.test.ts` and the three e2e specs. Expected: FAIL.
- [ ] **Step 3: Implement** the lib, the card, the mock and the locale keys (7 languages, identical order).
- [ ] **Step 4: Run** the same tests plus `cd web && npx vitest run src/lib/i18n`, svelte-check, `npm run build -w web`, eslint on touched files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): recap and admin alert switches on the account page`.

### Task 5: `/confirm-email` loads the account page in full

**Files:**
- Modify: `web/src/routes/confirm-email/+page.svelte` (both *Zum Konto* links get `data-sveltekit-reload`)
- Test: extend `e2e/tests/account-security.spec.ts` (the `/confirm-email` describe)

**Interfaces:** none (markup only). Reason (stage B finding): `/confirm-email` is a public page, the app shell (sign-in check, navigation) never boots there, so a client-side navigation to `/me/account` shows a page without its shell.

- [ ] **Step 1: Write the failing test** `"Zum Konto" opens the account page with a full load` (done view, and again for the expired view): the link has `data-sveltekit-reload` = `''`; after `click()` the URL is `/me/account`, `/api/me` was requested at least once after the click (the shell booted), and the *Sicherheit* region is visible.
- [ ] **Step 2: Run** `cd e2e && E2E_PORT=<free> PW_CHROMIUM=… npx playwright test tests/account-security.spec.ts -g "Zum Konto" --trace off`. Expected: FAIL (attribute missing).
- [ ] **Step 3: Implement** the two attributes.
- [ ] **Step 4: Run** the whole `account-security.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(account): /confirm-email links load the account page in full`.

### Task 6: *Branding an Authentik übertragen*

**Files:**
- Modify: `backend/src/authentik.ts` (exports below, through the module's `call`/`json`), `backend/src/app.ts` (register `akBrandingRoutes` after `mailPersonRoutes`; `SENSITIVE_BODY` gains `api\/admin\/authentik\/branding`), `web/src/routes/admin/settings/+page.svelte` (render `AuthentikSync` after `MailStatus` in the `mail` group), `web/src/lib/i18n/locales/*/settings.ts` (`mail.authentik.*`), `e2e/mocks/api.ts`
- Create: `backend/src/akBranding.ts`, `web/src/lib/admin/settings/akBranding.ts`, `web/src/lib/admin/settings/AuthentikSync.svelte`
- Test: create `backend/test/ak-branding.test.ts`, `web/src/lib/admin/settings/akBranding.test.ts`; extend `e2e/tests/admin-settings.spec.ts`, `e2e/tests/admin-settings.mobile.spec.ts`

**Interfaces:**
- Produces (`authentik.ts`): `akBrandFor(ctx: AkCtx, host: string | null): Promise<{ uuid: string } | null>` (`GET api/v3/core/brands/?page_size=100`, Controller's call 9); `akPatchBrand(ctx: AkCtx, uuid: string, body: { branding_title: string; branding_logo?: string }): Promise<void>`; `akRecoveryEmailStage(ctx: AkCtx): Promise<string>` (the existing `emailStageOf` for the recovery flow); `akPatchEmailStage(ctx: AkCtx, pk: string, body: Record<string, unknown>): Promise<void>`. Errors as the module throws them today (`AkUpstreamError` with `failure.cls`).
- Produces (`akBranding.ts`):
  - `type AkPart = { state: 'done' } | { state: 'skipped'; code: 'nothing_to_send' } | { state: 'failed'; code: 'permission' | 'token_invalid' | 'not_found' | 'no_email_stage' | 'unreachable' | 'error'; permission?: string }`
  - `akBrandingPreview(ctx: Ctx): Promise<{ available: boolean; title: string; logoUrl: string | null; from: string | null; smtp: { available: boolean; host: string | null; port: number; tls: 'starttls' | 'tls' | 'none'; hasUser: boolean } }>` (never the password; `available` = `AUTHENTIK_URL` and `AUTHENTIK_API_TOKEN` set; `smtp.available` = `mailConfigured`)
  - `fromAddress(name: string, address: string): string`
  - `akSyncBranding(ctx: Ctx, o: { smtp: boolean }): Promise<{ brand: AkPart; stage: AkPart }>` (brand first, then stage; a failure of one never stops the other; `permission` = the codename of the refused call: brand list `authentik_brands.view_brand`, brand PATCH `authentik_brands.change_brand`, stage PATCH `authentik_stages_email.change_emailstage`; stage `skipped`/`nothing_to_send` when `MAIL_FROM` is unset and `smtp` is false)
  - `akBrandingRoutes(app, ctx)`: `GET /api/admin/authentik/branding` (admin, `no-store`) → the preview; `POST` (admin, 6/min) body `{ smtp: z.boolean() }`: Authentik not configured → 503 `authentik_unavailable`; `smtp` and not `mailConfigured` → 400 `mail_not_configured`; `smtp` and not `recentlyAuthenticated(req.session!, REAUTH_WINDOW_S)` → 401 `reauth_required`; else 200 `{ brand, stage }`, audit `authentik.branding` `{ smtp, brand: <state>[:<code>], stage: <state>[:<code>] }`.
- Web (`akBranding.ts`): `loadAkBranding()`, `syncAkBranding(smtp: boolean)` (a 401 `reauth_required` runs `reauthenticate` from `#lib/account/reauth` and retries once), `partText(part: 'brand' | 'stage', r: AkPart, smtp: boolean, tr): { tone: ResultTone; text: string }`.
- **Card** (only when `available`): title *Authentik*; *Überträgt Name und Logo aus dem Branding auf Authentiks Anmeldeseite und die Absenderadresse in die E-Mail-Stufe des Passwort-Resets.*; read-only rows *Titel*, *Logo* (the URL or *kein Logo*), *Absender*; a checkbox, unchecked on every load, *Auch die SMTP-Einstellungen übertragen (Server, Port, Verschlüsselung, Benutzer und Passwort)* with the hint *Authentik verschickt seine Mails dann über denselben Server. Das Passwort geht nur an Authentik und wird nirgends angezeigt.* (disabled while mail is not set up); the button *Branding an Authentik übertragen* (44 px, busy state without a size change); two result lines in reserved space, e.g. *Name und Logo übertragen.*, *Absender und SMTP-Einstellungen übertragen.*, *Dem Authentik-Token fehlt die Berechtigung „{permission}“.* with a link *Anleitung* to `docs/authentik.md#10b-e-mails-in-the-friendflix-look`.

- [ ] **Step 1: Write the failing tests** in `ak-branding.test.ts` (a recording `fetchImpl` fake of Authentik: brands list with `{ brand_uuid: 'b-1', domain: 'auth.example.com', default: false }` and a default brand, the recovery flow's bindings with one e-mail stage `s-1`; `OIDC_ISSUER = 'https://auth.example.com/application/o/friendflix/'`; `MAIL_SMTP_HOST = 'mail.example.com'`, `MAIL_SMTP_PORT = 587`, `MAIL_SMTP_TLS = 'starttls'`, `MAIL_SMTP_USER = 'kino'`, `MAIL_SMTP_PASSWORD = 'hunter2-fixture'`, `MAIL_FROM = 'kino@friend.example.com'`; brand name `Nordlicht TV` with a PNG logo):
  - `without consent no request carries a password`: `POST { smtp: false }` → 200 `{ brand: { state: 'done' }, stage: { state: 'done' } }`; the brand PATCH went to `…/core/brands/b-1/` with `{ branding_title: 'Nordlicht TV', branding_logo: 'https://friend.example.com/api/public/brand/img/<hash>.png' }`; the stage PATCH body equals `{ from_address: 'Nordlicht TV <kino@friend.example.com>' }`; no recorded body contains `password` or `hunter2-fixture`.
  - `with consent only the stage PATCH carries it`: a fresh sign-in, `{ smtp: true }` → the stage body `{ from_address, use_global_settings: false, host: 'mail.example.com', port: 587, username: 'kino', password: 'hunter2-fixture', use_tls: true, use_ssl: false, timeout: 10 }`; `hunter2-fixture` appears in no other request, not in the HTTP answer, not in any `audit_log` row, not in any kv value (`akdiag:last:api` included), not in the captured request log.
  - `consent without a fresh sign-in answers 401 and calls nothing` (zero Authentik requests); `consent without mail set up answers mail_not_configured`.
  - `tls none sends no credentials` (`username: ''`, `password: ''`, `use_tls: false`, `use_ssl: false`); `tls sends use_ssl`.
  - `brand refused, stage done`: brand PATCH 403 with a permission detail → `brand: { state: 'failed', code: 'permission', permission: 'authentik_brands.change_brand' }`, stage `done`.
  - `stage refused names change_emailstage`; `a rejected token answers token_invalid for both`; `a flow without e-mail stage answers no_email_stage`; `Authentik down answers unreachable for both`.
  - `the default brand is used when no domain matches`; `no logo and no symbol sends no branding_logo`; `no PUBLIC_URL sends the title only`.
  - `fromAddress strips header characters`: `fromAddress('Nordlicht "TV" <Kino>', 'kino@friend.example.com') === 'Nordlicht TV Kino <kino@friend.example.com>'`; `fromAddress('<>', a) === a`.
  - `preview never carries the password` and `non-admins get 403`; `not configured answers available: false` and `POST` 503 `authentik_unavailable`.
- [ ] **Step 2: Write the failing web tests:** `akBranding.test.ts` (`partText` for every state and code, the permission named in the text; `syncAkBranding` retries once after `reauth_required` and not a second time); `admin-settings.spec.ts` (`Authentik card hidden when Authentik is not set up`; `transfer without SMTP` → POST body `{ smtp: false }`, both lines shown; `the SMTP checkbox starts unchecked and is sent only when ticked`; `a missing permission names it`; `a 401 asks for the sign-in and repeats the transfer`); `admin-settings.mobile.spec.ts` (button and checkbox ≥ 44 px, no horizontal overflow, the result lines do not move the button: its bounding box is the same before and after a result).
- [ ] **Step 3: Run** `cd backend && TEST_DATABASE_URL=… npx vitest run test/ak-branding.test.ts`, `cd web && npx vitest run src/lib/admin/settings/akBranding.test.ts` and the two e2e specs. Expected: FAIL.
- [ ] **Step 4: Implement** the backend exports, `akBranding.ts`, the route registration, the web lib, the card, the mock and the locale keys. Before writing the PATCH bodies, check the field names (`branding_title`, `branding_logo`, `from_address`, `use_global_settings`, `host`, `port`, `username`, `password`, `use_tls`, `use_ssl`, `timeout`) and the three permission codenames against the Authentik 2026.8.3 source (the `compose.authentik.yaml` pin; the spec asks to verify on the installed version) and note the check in a comment, as `SERVICE_READS` does.
- [ ] **Step 5: Run** the same tests plus `test/authentik.test.ts test/admin-hardening.test.ts`, `cd web && npx vitest run src/lib/i18n`, both typechecks, `npm run build -w web`, eslint on touched files, and `cd web && npx vitest run --coverage` once: statements ≥ 94 %. Expected: PASS.
- [ ] **Step 6: Commit** `feat(mail): copy branding, sender and (on consent) SMTP settings into Authentik`.

### Task 7: Authentik templates in the FriendFlix look, docs and CHANGELOG

**Files:**
- Modify: `deploy/authentik/templates/friendflix-recovery.html`, `deploy/authentik/templates/friendflix-email-change.html` (restyled, Controller's call 10), `backend/test/email-change.test.ts` (the template assertions: no `{% extends %}` any more), `docs/authentik.md` (new section *10b. E-mails in the FriendFlix look*, its line in *Contents*, §8.2 a second table *Optional: for “Branding an Authentik übertragen”* with the three codenames, a pointer from §10 step 3 and §12), `docs/mail.md` (*Which mails people get* gains *Weekly recap*; new section *Mails for admins*; a short *Authentik's own mails* section pointing to `docs/authentik.md#10b-…`), `docs/security.md` (*E-Mail*: the SMTP consent and the fresh sign-in, the password only in the PATCH to Authentik, the optional permissions), `CHANGELOG.md`
- Create: `deploy/authentik/templates/friendflix-reset.html`, `deploy/authentik/templates/friendflix-confirm.html`, `backend/test/authentik-templates.test.ts`

**Interfaces:**
- Each template: line 1 a one-line `{# … #}` comment naming the value to edit (the two existing ones unchanged; the new ones: `{# FriendFlix: the link is Authentik's own ({{ url }}); edit the name and colour lines marked ff:brand if you like #}`), SPDX comment lines, `{% load i18n %}`, the shell between the markers of Controller's call 10, the content block (heading, one sentence, one button), English texts in `{% trans %}`, `{{ expires|naturaltime }}` sentence only in the reset and confirm files (`{% load humanize %}`).
- `docs/authentik.md` 10b: which file for which stage (recovery flow's stage: `friendflix-reset.html`, or `friendflix-recovery.html` with the in-app sign-in; enrollment stage: `friendflix-confirm.html`; e-mail change: unchanged), mounting `/templates` on server **and** worker, selecting the template and a subject per stage, the two `ff:brand` lines, and the *Branding an Authentik übertragen* action (what it writes, the consent, the three optional permissions, what each error means).

- [ ] **Step 1: Write the failing tests** in `authentik-templates.test.ts` (reads the four files):
  - `all four share one shell`: the text between `{# ff:head #}` and `{# /ff:head #}`, and between `{# ff:foot #}` and `{# /ff:foot #}`, is identical in all four files.
  - `one link each, to the right place`: `href` list equals `['https://friend.example.com/reset?token={{ token }}']`, `['https://friend.example.com/confirm-email?token={{ token }}']`, `['{{ url }}']`, `['{{ url }}']` for recovery, email-change, reset, confirm.
  - `no remote resources`: no `<img`, no `src=`, no `url(`, no `@import`, no `http` outside the one `href`.
  - `standalone`: no `{% extends`, contains `{% load i18n %}` and `{% trans `; nothing but `{# #}` comment lines before the first `{% load`.
  - `brand colour`: contains `deriveTokens(DEFAULT_BRAND.accent).accFill` and stage A's `#f4f4f6`, `#ffffff`, `#1a1d21`.
  - `email-change.test.ts`: keep the first-line and single-`href` assertions, replace the `extends` assertion with `not.toContain('{% extends')`.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/authentik-templates.test.ts test/email-change.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four templates.
- [ ] **Step 4: Docs.** The sections listed under Files. `CHANGELOG.md` `[Unreleased]`: under `### Everyone` a bullet **Your weekly recap by e-mail** (opt-in *Wochenrückblick* switch, titles as text, independent of the in-app recap, one-click unsubscribe), the stage B bullet unchanged; under `### Admin` a bullet **E-Mail alerts for admins** (the four alerts, when each fires and how often, the switches under *Konto → E-Mails → Für Admins*, the in-app notice each one also is) and a bullet **Authentik's mails in your look** (the four templates, *Branding an Authentik übertragen*, the consent for SMTP, the optional permissions); under `### Fixed` (create it if missing) *Zum Konto* after confirming a new address opens the account page fully.
- [ ] **Step 5: Run** the two test files, and check the new anchors exist: `grep -n "^## 10b. E-mails in the FriendFlix look" docs/authentik.md` and `grep -n "^## Mails for admins" docs/mail.md` each print one line. Expected: PASS.
- [ ] **Step 6: Commit** `docs(mail): Authentik templates in the FriendFlix look, recap and admin alert docs`.
