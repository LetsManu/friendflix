# E-mail, Stage B: mails for people, preferences and unsubscribe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People get mail for the events they care about (welcome, a wish is available, a recording finished or failed, downloads about to expire), an admin can send an invitation by mail, each person switches every mail type on or off on the account page, and every such mail carries a one-click unsubscribe that works without a sign-in.

**Architecture:**
- **Mail as a channel of `notify()`:** `Notice` gains `mail?: MailPrefType`. After the in-app row is inserted (its dedupe passed), `notify()` hands the notice to `mailPerson()`, which checks configured / address / account state / the person's switch and queues one outbox row whose kind is the type. The notice texts (`Text`) travel in the encrypted params and are rendered at send time in the language fixed at enqueue.
- **One-offs without a notice:** welcome (claimed once by `users.welcomed_at` in `issueSession`) and the invitation (admin invite dialog, to a typed address) call the outbox directly.
- **Preferences** live in `user_prefs.data.mail` (`{ available, recording, licence }`, default on). The account page's card and the public unsubscribe route both go through `setMailPref()`, which also drops queued mail of a type switched off.
- **Unsubscribe:** an HMAC token (HKDF `unsubscribe` subkey, per person and type, no expiry). The mail footer links to the web page `/mail/unsubscribe`; the `List-Unsubscribe` header points to `POST /api/public/mail/unsubscribe` (RFC 8058); a GET there only redirects to the page.
- **Stage A fixes:** the probe cache's HMAC uses its own HKDF subkey (M4); `mail_queue_stuck` looks at rows that are due and not sent, not at rows waiting by design (M7).

**Tech Stack:** Fastify, Postgres (migration 58), zod 4, nodemailer 10.3.1 (already in), SvelteKit SPA, vitest, Playwright e2e with mocks. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-16-mail-design.md` (sections "Unsubscribe (stage B)", "Preferences (stage B)", "Mail as a channel of notify() (stage B)", "Invitation path"; Controller's calls 24–29 apply). Stage A as built: `backend/src/mail/*`, `backend/src/syscheck/checks/mail.ts`, `web/src/lib/admin/settings/MailStatus.svelte`; stage A plan `docs/superpowers/plans/2026-11-16-mail-stage-a.md`.

## Controller's calls (stage B)

1. **Token and URLs.** Token `v1.<userId>.<type>.<mac>`, `mac` = base64url (43 chars, no padding) of HMAC-SHA256(`mailSubkey(encKey, 'unsubscribe')`, `` `v1|${userId}|${type}` ``); checked against `^v1\.([0-9a-f-]{36})\.([a-z]{1,20})\.([A-Za-z0-9_-]{43})$`, a known `MailPrefType`, compared with `timingSafeEqual`; no expiry. Page `<origin>/mail/unsubscribe?t=<token>`, one-click `<origin>/api/public/mail/unsubscribe?t=<token>`. Reason: every part is already URL-safe, so the spec's outer base64url adds length and a decode step but no secrecy; a readable type lets the confirm page name the mail type without a request. Rotating `APP_ENC_KEY` invalidates old links (spec).
2. **GET page versus one-click POST: both, one URL each purpose.** `List-Unsubscribe` → `POST /api/public/mail/unsubscribe?t=` (RFC 8058; the body `List-Unsubscribe=One-Click` is accepted as form or multipart and ignored, the token is the authorisation). A `GET` on that same URL never changes anything and answers `303` to `/mail/unsubscribe?t=…` (clients that open the header URL in a browser). The footer link goes to the web page, which shows one button and posts `{ t, on: false }` as JSON (token in the body, not the URL); after it, *Wieder anmelden* posts `{ t, on: true }`. Reason: link scanners and previews fetch GETs, so a GET must never unsubscribe; RFC 8058 needs a plain POST without a CSRF token.
3. **Dedupe.** Notice mails: outbox `dedupe` = `n:<notice.dedupe>`, and `notify()` mails only notices that carry a dedupe key (a retried webhook or tick never mails twice). Welcome: `welcome:<userId>` plus the durable `users.welcomed_at` claim (the outbox deletes rows after 30 days, so the outbox key alone is not "once"). Invitation: `invite:<inviteId>`. Licence: the notice's `dl-expiring-<userId>-<yyyy-mm-dd>` plus `downloads.expiry_warned_at` per licence.
4. **Welcome** fires in `issueSession` (the end of every successful sign-in, all three account-creating paths end there) when `update users set welcomed_at = now() where id = $1 and welcomed_at is null returning name` returns a row; the claim is made even when no mail can be sent (no address, mail not set up), so it is once per account ever. Migration 58 marks every existing account as welcomed (`welcomed_at = created_at`), so the deploy mails nobody. Reason: atomic across instances, survives outbox retention.
5. **Licence-expiry window: 48 h** (the spec's value), checked once a day between 09:00 and 21:00 server time (kv day key `mail:licence-day:<yyyy-mm-dd>`, `setnx`, TTL 2 days; tick every 10 min; a tick before 09:00 or from 21:00 on, e.g. after a deploy, a restart, a retry or downloads switched on late, waits for the next 09:00). A licence is warned once (`downloads.expiry_warned_at`), only while `pending`/`fetched`, expiring in `(now, now + 48 h]`, and only when it is at least 48 h old (a 1- or 2-day licence would otherwise warn right after the download). One notice per person per run: count + earliest expiry. Reason: a daily run keeps it to one mail a day; 09:00–21:00 keeps it out of the night; the window gives a licence of 4 days or more 24–48 h of warning (a 3-day licence is eligible only in its last 24 h; 1- and 2-day licences are never warned).
6. **Language.** Person mails: `userLanguage(ctx, userId)` (owner profile → instance default → German), fixed at enqueue. Invitation: chosen in the invite dialog, default the instance language (`broadcastLanguage`), because the recipient has no account yet. The unsubscribe page: the browser's language (`publicLocale`), like every public page.
7. **Kids profiles and people without an address.** Mail is account-level: kids profiles have no switches (the account page is owner-only) and never get mail of their own; an event caused on a kids profile (a licence, a wish) mails the account's address with the same notice text the account's inbox gets. No valid `users.email`, a disabled account, mail not set up or no `PUBLIC_URL` → no outbox row at all; the in-app notice is unchanged. The card shows the reason and disables the switches.
8. **Quiet hours and other prefs.** `notify()` has no quiet hours today, so mail has none; it sends as soon as the outbox and its rate limits allow. Mail switches are independent of Web Push, ntfy and `weeklyDigest`. The only time-of-day rule is the licence run between 09:00 and 21:00.
9. **Recording mails** (type `recording`): failed/partial (existing notice), a finished series episode (existing notice, mailed only when the recording is `done`, so a partial episode mails once), the recording about to be deleted for space (existing `livetv.rec.deleting`), and a **new** in-app + personal + mail notice `livetv.rec.done` for a finished recording that is not from a series rule. Reason: the spec lists "a recording finished"; only series episodes had a notice.
10. **Licence notice is new in-app too:** kind `download_expiring`, link `/downloads`, `personal: true`, `mail: 'licence'` (spec: "no in-app notice exists today"; mail is a channel of a notice, not a second event system).
11. **Switching a type off** (card or link) deletes that person's `queued` rows of that type. Reason: a mail waiting out a backoff or an outage must not arrive after the person said no; a row already `sending` under a lease finishes.
12. **Invitation mail** only for single-use invites (`maxUses` 1; else 400 `invite_mail_single_use`), rejected before the invite is created when mail is not set up (400 `mail_not_configured`) or the admin sent 20 today (429 `rate_limited`, kv `mail:invite:<adminId>`, TTL 86 400 s). Delivered at once through `deliverNow` so the dialog can say *verschickt*. The audit row `invite.create` gains `mail: { to: <masked>, state }`. No unsubscribe (no account, no preference); the reason line says to ignore it.
13. **Systemcheck (M7):** `mail_queue_stuck` when a row has been **overdue** for more than 15 min: `state = 'queued' and next_at <= now()`, or `state = 'sending' and lease_until < now()`, measured from `next_at` / `lease_until`. Rows deferred by backoff, the rate limit or a transport failure have a future `next_at` and never count. The probe cache HMAC (M4) uses `mailSubkey(encKey, 'probe')`.

## Global Constraints

- **Secrets and personal data never reach a log, an audit row, an error text or an API answer:** unsubscribe tokens, invite tokens, full e-mail addresses, the SMTP password. Logs and audit rows carry codes only; an address appears at most masked by `maskAddress` (`a…@friend.example.com`). The request log redacts `t=` (Task 4); the unsubscribe and account-mail routes are in `SENSITIVE_BODY`.
- **Never "Netflix" or "Seerr"** in user-facing text, code comments or docs; the request service is "request service" / "Wünsche" (existing file names like `routes/seerr.ts` stay).
- **Fictional names and placeholder hosts only:** Anna Beispiel, Ben Muster, Nordlicht TV; `friend.example.com`, `mail.example.com`, `192.0.2.x`. Test addresses `anna@friend.example.com`, `ben@friend.example.com`, sender `kino@friend.example.com`.
- **7 locales** de, en, es, fr, it, pl, tr with identical key order (web locale files and `backend/src/messages.ts`); German is the source, "du" form; real umlauts; "…" not "...".
- **UI:** animate only transform/opacity, never `scale()` on text, nothing may jump (reserve space for results and errors), 44 px touch targets, glass look (`.frost`, `--fr-r-*`), brand tokens `--acc*`.
- **Docker socket** is never given to web, backend, gateway or livetv.
- **Web coverage gate** ≥ 94 % statements.
- **Checks agents run:** typecheck (backend: `cd backend && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`; web: `cd web && npx svelte-kit sync && npx svelte-check --threshold error`, 4 known env errors in `routes/manifest.webmanifest/+server.ts` and `routes/cast-receiver/+server.ts`), `npm run build -w web`, `npx eslint <touched files>`, and the specific test files only. Backend vitest uses a private database via `TEST_DATABASE_URL` (Postgres at 127.0.0.1:5433, e.g. `ff_test_mailb`). e2e from `e2e/`: `E2E_PORT=<free> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off`. CI runs the rest. `node_modules` is a symlink: never `npm install`.
- **Git:** merge, never rebase or force-push; never `git stash`. Every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- **Exact values:**

  | What | Value |
  |---|---|
  | Pref types | `MAIL_PREF_TYPES = ['available', 'recording', 'licence'] as const`, all default `true`, stored `user_prefs.data.mail` |
  | One-off kinds | `welcome`, `invite` (no switch); `MailKind = 'test' \| 'welcome' \| 'invite' \| MailPrefType` |
  | Token / URLs / headers | Controller's call 1–2; `List-Unsubscribe: <…/api/public/mail/unsubscribe?t=…>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on pref kinds only |
  | Settings link | `<origin>/me/account#mail` in the footer of pref kinds and the welcome mail |
  | Dedupe | `n:<notice.dedupe>`, `welcome:<userId>`, `invite:<inviteId>` |
  | Licence | window 48 h, min age 48 h, daily between 09:00 and 21:00 server time, kv `mail:licence-day:<yyyy-mm-dd>` TTL 172 800 s, tick 600 s |
  | Rate limits | unsubscribe routes 20/min per IP; `PUT /api/account/mail` 30/min; invite mail 20/day per admin |
  | Stuck | overdue > 900 000 ms |
  | Migration | 58 (next free number when the builder starts): `users.welcomed_at timestamptz`, `downloads.expiry_warned_at timestamptz` |

## Review Focus

1. **The deploy of stage B** on an instance with accounts and active downloads: nobody gets a welcome mail, and the licence run happens at the first tick between 09:00 and 21:00 server time (Controller's call 5: a deploy at 14:00 warns about licences expiring within 48 h at about 14:10; a deploy before 09:00 or from 21:00 on waits for the next 09:00). These are real warnings, not a backlog. Task 3 test `migration 58 marks existing accounts as welcomed`.
2. **A person switches a type off while a mail of that type waits** (backoff, outage, rate limit): it is never sent. Task 1 test `switching a type off drops its queued mail`.
3. **A forged, altered or old unsubscribe token** (another user id, another type, a cut MAC, signed with an older `APP_ENC_KEY`): 400 `invalid_token`, no switch changes, nothing logged but the code. Task 1 test `verify rejects tampered tokens`; Task 4 test `invalid token answers 400 and changes nothing`.
4. **Unsubscribing in a browser where the person is signed in** (the CSRF hook would demand a token), and a mail scanner fetching the header URL: the POST works without `x-csrf-token`; the GET changes nothing. Task 4 tests `one-click POST works next to a session cookie without csrf header` and `GET only redirects`.
5. **Saving the settings page after the mail switches were set** (`PUT /api/prefs` used to replace `user_prefs.data`): the switches survive. Task 1 test `PUT /api/prefs keeps the mail switches`.

---

### Task 1: Preferences, recipients, the unsubscribe token, and the stage A fixes (M4, M7)

**Files:**
- Modify: `backend/src/mail/address.ts` (`mailSubkey` purpose gains `'probe'`), `backend/src/mail/templates.ts` (the `MailKind` union only), `backend/src/syscheck/checks/mail.ts` (M4 fingerprint, M7 rule), `backend/src/mail/outbox.ts` (`MailStatus.oldestQueuedAt` → `oldestOverdueAt`), `backend/src/mail/routes.ts` (strip `oldestOverdueAt` from the status answer), `backend/src/routes/prefs.ts` (the `user_prefs` upsert merges: `set data = user_prefs.data || excluded.data`), `backend/src/export.ts` (the `notifications` field gains `mail: <prefs>`)
- Create: `backend/src/mail/people.ts`, `backend/src/mail/unsubscribe.ts`
- Test: create `backend/test/mail-people.test.ts`; extend `backend/test/syscheck-mail.test.ts`, `backend/test/mail-outbox.test.ts` (status field rename), `backend/test/export.test.ts`

**Interfaces:**
- Produces (`mail/people.ts`):
  - `MAIL_PREF_TYPES`, `type MailPrefType = (typeof MAIL_PREF_TYPES)[number]`, `isMailPrefType(v: unknown): v is MailPrefType`
  - `readMailPrefs(ctx: Pick<Ctx, 'db'>, userId: string): Promise<Record<MailPrefType, boolean>>` (missing or non-boolean → `true`; unknown keys ignored)
  - `setMailPref(ctx: Pick<Ctx, 'db'>, userId: string, type: MailPrefType, on: boolean): Promise<Record<MailPrefType, boolean>>` (jsonb merge into `user_prefs.data.mail`, insert when no row; `on = false` also `delete from mail_outbox where user_id = $1 and kind = $2 and state = 'queued'`)
  - `mailRecipient(ctx: Pick<Ctx, 'db' | 'cfg'>, userId: string, kind: PersonMailKind): Promise<{ to: string; lang: Language; name: string } | null>` (null per Controller's call 7, and when `kind` is a pref type that is off)
  - `mailPerson(ctx: Pick<Ctx, 'db' | 'cfg' | 'encKey'>, userId: string, kind: PersonMailKind, params: Record<string, unknown>, dedupe: string): Promise<string | null>` (`mailRecipient` then `enqueueMail`; the row id, or null)
- Produces (`mail/unsubscribe.ts`): `unsubscribeToken(encKey: Buffer, userId: string, type: MailPrefType): string`; `verifyUnsubscribeToken(encKey: Buffer, token: string): { userId: string; type: MailPrefType } | null`; `unsubscribeUrls(origin: string, token: string): { page: string; oneClick: string }`
- Produces (`mail/outbox.ts`): `MailStatus.oldestOverdueAt: string | null` (replaces `oldestQueuedAt`)
- Produces (`mail/templates.ts`, type only): `type MailKind = 'test' | 'welcome' | 'invite' | MailPrefType` (the union in Global Constraints), so `enqueueMail` accepts the new kinds; the template bodies come in Task 2. `mailPerson` and `mailRecipient` take `PersonMailKind = MailPrefType | 'welcome'` (exported from `people.ts`).

- [ ] **Step 1: Write the failing tests** in `mail-people.test.ts` (users `anna@friend.example.com` / `ben@friend.example.com`, `MAIL_SMTP_HOST='mail.example.com'`, `MAIL_FROM='kino@friend.example.com'`, `PUBLIC_URL='https://friend.example.com'`):
  - `prefs default to on`: no `user_prefs` row → `{ available: true, recording: true, licence: true }`.
  - `setMailPref merges and keeps other user_prefs keys`: with `data = { weeklyDigest: false, ntfyTopic: 'anna-kino' }`, `setMailPref(…, 'recording', false)` → `data.weeklyDigest === false`, `data.ntfyTopic === 'anna-kino'`, `data.mail.recording === false`.
  - `switching a type off drops its queued mail`: two queued rows for Anna (`available`, `recording`) and one `sending` `recording` row; `setMailPref(anna, 'recording', false)` → the queued `recording` row is gone, the `available` and `sending` rows stay.
  - `PUT /api/prefs keeps the mail switches`: set `licence` off, then `PUT /api/prefs` with `prefsSchema.parse({})` as the owner → `readMailPrefs` still has `licence: false`.
  - `mailRecipient` returns null for: no email; `email = 'not-an-address'`; `disabled = true`; `MAIL_SMTP_HOST` undefined; `PUBLIC_URL = ''`; type switched off. Returns `{ to: 'anna@friend.example.com', lang: 'en', name: 'Anna Beispiel' }` when the owner profile's language is `en`. `welcome` ignores the switches.
  - `mailPerson queues once per dedupe key`: two calls with `n:avail-7` → one row, second call returns null; the row's `rcpt_mask` is `a…@friend.example.com` and `params_enc` is not plaintext JSON.
  - `token round-trip`: `verifyUnsubscribeToken(k, unsubscribeToken(k, anna, 'licence'))` → `{ userId: anna, type: 'licence' }`; the token matches `/^v1\.[0-9a-f-]{36}\.licence\.[A-Za-z0-9_-]{43}$/`.
  - `verify rejects tampered tokens`: another user id with the same mac, `licence` → `available` with the same mac, the mac cut by one char, a mac of another key, `v2.` prefix, an unknown type `digest`, 2 000 characters of `a` → all `null`.
  - `unsubscribeUrls` → `page: 'https://friend.example.com/mail/unsubscribe?t=<token>'`, `oneClick: 'https://friend.example.com/api/public/mail/unsubscribe?t=<token>'`.
  - `export.test.ts`: `export lists the mail switches` → `notifications.mail` equals the stored prefs.
  - `syscheck-mail.test.ts`:
    - `probe cache fingerprint uses the probe subkey`: the cached `fp` equals the HMAC with `mailSubkey(encKey, 'probe')` and differs from the HMAC keyed with `encKey`.
    - `queue stuck ignores mail waiting for its backoff`: a queued row created 3 h ago with `next_at = now + 1 h` → line `ok`.
    - `queue stuck ignores mail held by the rate limit`: the same with `attempts = 0`, `next_at = now + 40 min` → `ok`.
    - `queue stuck fires for a row overdue 16 minutes`: `next_at = now − 16 min` → `warning`/`mail_queue_stuck`; `next_at = now − 14 min` → `ok`.
    - `queue stuck fires for a lease that ran out 16 minutes ago`: `state = 'sending'`, `lease_until = now − 16 min` → `warning`/`mail_queue_stuck`.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-people.test.ts test/syscheck-mail.test.ts test/mail-outbox.test.ts test/export.test.ts`. Expected: FAIL (modules missing, old stuck rule).
- [ ] **Step 3: Implement** `people.ts`, `unsubscribe.ts` (constant-time compare on equal-length buffers; any parse failure → null), the `probe` subkey, `oldestOverdueAt` (`min(case when state='queued' and next_at <= now() then next_at when state='sending' and lease_until < now() then lease_until end)`), the 900 000 ms rule, the `prefs.ts` merge and the export field.
- [ ] **Step 4: Run** the same tests, plus `test/profiles.test.ts test/mail-routes.test.ts`, backend typecheck, eslint on touched files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): mail preferences, recipients, unsubscribe token; probe subkey and overdue-based queue check`.

### Task 2: Templates for every stage B kind, unsubscribe headers, and the `notify()` channel

**Files:**
- Modify: `backend/src/mail/templates.ts`, `backend/src/mail/worker.ts` (`Claimed.user_id`, passed to `renderMail`), `backend/src/notify.ts`, `backend/src/reminders.ts` and any other narrowed ctx type the compiler names (they gain `'encKey'`), `backend/src/messages.ts` (keys below, 7 languages)
- Test: extend `backend/test/mail-render.test.ts`, `backend/test/mail-outbox.test.ts`; create `backend/test/mail-notify.test.ts`; run `backend/test/i18n-messages.test.ts`, `backend/test/fixes-notify.test.ts`, `backend/test/push.test.ts`

**Interfaces:**
- Consumes: Task 1 `MailPrefType`, `isMailPrefType`, `mailPerson`, `unsubscribeToken`, `unsubscribeUrls`.
- Produces (`templates.ts`): `type MailKind = 'test' | 'welcome' | 'invite' | MailPrefType`; `renderMail(ctx: Pick<Ctx, 'db' | 'cfg' | 'encKey'>, kind: MailKind, lang: Language, params: Record<string, unknown>, o?: { userId: string | null }): Promise<RenderedMail>`. Params by kind (zod, parse failure throws): `test` `{}`; `welcome` `{ name: string }`; `invite` `{ link: string (http(s) URL), expiresAt: string (ISO), inviter: string }`; pref kinds `{ title: Text, body?: Text | null, link?: string | null }`.
- Produces (`notify.ts`): `Notice.mail?: MailPrefType`; `notify(ctx: Pick<Ctx, 'db' | 'cfg' | 'fetchImpl' | 'encKey'>, n)` mails only when `n.userId && n.dedupe && n.mail`, after the insert succeeded, via `mailPerson(ctx, n.userId, n.mail, { title: n.title, body: n.body ?? null, link: n.link ?? null }, \`n:${n.dedupe}\`)`, failures swallowed like `pushPersonal`. `notifyAdmins` is unchanged (stage C).
- German source strings (the builder writes the other six):
  - `mail.footer.unsubscribe` 'Diese E-Mails abbestellen'; `mail.footer.settings` 'E-Mail-Einstellungen'
  - `mail.available.body` 'Viel Spaß beim Ansehen in {app}!'; `mail.available.button` 'Zu deinen Wünschen'; `mail.available.reason` 'Du bekommst diese E-Mail, weil du in {app} E-Mails zu verfügbaren Wünschen eingeschaltet hast.'
  - `mail.recording.body` 'Alle Aufnahmen findest du in {app} unter „Aufnahmen“.'; `mail.recording.button` 'Zu deinen Aufnahmen'; `mail.recording.reason` '… E-Mails zu deinen Aufnahmen eingeschaltet hast.'
  - `mail.licence.body` 'Danach lassen sie sich offline nicht mehr abspielen. Du kannst sie in {app} erneut herunterladen.'; `mail.licence.button` 'Zu deinen Downloads'; `mail.licence.reason` '… E-Mails zu ablaufenden Downloads eingeschaltet hast.'
  - `mail.welcome.subject` 'Willkommen bei {app}'; `mail.welcome.heading` 'Willkommen, {name}!'; `mail.welcome.body` 'Dein Konto bei {app} ist bereit. Filme, Serien und deine Wünsche findest du jetzt an einem Ort.'; `mail.welcome.body2` 'Welche E-Mails du von {app} bekommst, stellst du in deinem Konto unter „E-Mails“ ein.'; `mail.welcome.reason` 'Du bekommst diese E-Mail einmalig, weil dein Konto bei {app} gerade angelegt wurde.'
  - `mail.invite.subject` '{inviter} lädt dich zu {app} ein'; `mail.invite.heading` 'Du bist eingeladen'; `mail.invite.body` '{inviter} lädt dich zu {app} ein. Mit dem Link legst du dein Konto an oder meldest dich mit einem bestehenden an.'; `mail.invite.expires` 'Die Einladung gilt bis {date}.'; `mail.invite.button` 'Einladung annehmen'; `mail.invite.reason` 'Du bekommst diese E-Mail, weil {inviter} dich zu {app} eingeladen hat. Wenn du nicht mitmachen willst, ignoriere sie einfach.'
- Shape of a pref-kind mail: subject and heading = rendered `title` (subject through `oneLine`); paragraph = rendered `body`, else `mail.<kind>.body`; button `mail.<kind>.button` → `link` made absolute with the origin (relative path only; anything else drops the button), else `<origin>/`; reason `mail.<kind>.reason`; footer links: website/legal as in stage A, then *E-Mail-Einstellungen* and *Diese E-Mails abbestellen*. Welcome: heading, `body` + `body2`, button `mail.open` → `<origin>/`, footer *E-Mail-Einstellungen*. Invite: `body` + `expires`, button → `link`, no settings or unsubscribe link.

- [ ] **Step 1: Write the failing tests:**
  - `mail-render.test.ts`:
    - `pref kinds carry the unsubscribe headers and links`: `renderMail(ctx, 'licence', 'de', { title: m('download.expiring.title', { n: 2 }), body: null, link: '/downloads' }, { userId: anna })` → `headers['List-Unsubscribe'] === '<https://friend.example.com/api/public/mail/unsubscribe?t=' + unsubscribeToken(encKey, anna, 'licence') + '>'`, `headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click'`, the text contains `Diese E-Mails abbestellen: https://friend.example.com/mail/unsubscribe?t=` and `E-Mail-Einstellungen: https://friend.example.com/me/account#mail`, the button URL is `https://friend.example.com/downloads`.
    - `welcome and invite have no unsubscribe header`; `test` keeps exactly its stage A headers.
    - `notice title with markup is escaped`: title `'<b>"Nordlicht"</b> ist jetzt verfügbar'` → HTML contains `&lt;b&gt;&quot;Nordlicht&quot;&lt;/b&gt;`, subject has no line break.
    - `invite renders link, inviter and date in the stored language`: `('invite', 'en', { link: 'https://friend.example.com/invite/abc…', expiresAt: '2026-11-18T10:00:00.000Z', inviter: 'Anna Beispiel' })` → subject `Anna Beispiel invites you to <app>` (en catalogue), the button href is the link.
    - `a link that is not a relative path drops the button`: `link: 'javascript:alert(1)'` and `'https://evil.example.com/'` → no button, mail still renders.
    - `every stage B kind stays under 100 000 bytes` (de, with a 200 KB-limit PNG symbol).
    - `bad params throw`: `('invite', 'de', { link: 'ftp://x' })` rejects.
  - `mail-outbox.test.ts`: `worker renders with the row's user` — a queued `licence` row for Anna sent through the fake SMTP server carries `List-Unsubscribe` with Anna's token.
  - `mail-notify.test.ts`:
    - `notice with mail queues one row of that kind`: `notify(ctx, { userId: anna, kind: 'available', title: m('title.available', { title: 'Nordlicht' }), link: '/requests', dedupe: 'avail-7', mail: 'available' })` → one `notifications` row, one `mail_outbox` row `kind = 'available'`, `dedupe = 'n:avail-7'`, `lang` = Anna's language.
    - `the same notice twice mails once` (second call returns false, still one row).
    - `no mail without dedupe, without userId, with the type off, without address, when not configured` → notification rows as before, zero outbox rows.
    - `a mail failure never fails notify`: `vi.spyOn` the outbox module's `enqueueMail` to reject → `notify` resolves `true` and the notification row exists.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-render.test.ts test/mail-outbox.test.ts test/mail-notify.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the templates (one function per kind group, all text through `layout()`), the worker's `user_id`, the `notify()` channel and the message keys.
- [ ] **Step 4: Run** the three files plus `test/i18n-messages.test.ts test/fixes-notify.test.ts test/push.test.ts test/reminders.test.ts`, backend typecheck, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): person mail templates with unsubscribe headers, and mail as a notify() channel`.

### Task 3: The events — wish available, recordings, welcome, licence expiry (migration 58)

**Files:**
- Modify: `backend/src/db.ts` (migration 58, rerunnable: `alter table users add column if not exists welcomed_at timestamptz; update users set welcomed_at = created_at where welcomed_at is null; alter table downloads add column if not exists expiry_warned_at timestamptz;`), `backend/src/routes/seerr.ts` (the per-person `available` notice gains `mail: 'available'`), `backend/src/livetv/recsched.ts` (`noticeFailed` gains `mail: 'recording'`; the series-episode notice gains it only when `state === 'done'`; new `livetv.rec.done` notice), `backend/src/livetv/recstore.ts` (`livetv.rec.deleting` gains `mail: 'recording'`), `backend/src/loginFinish.ts` (`issueSession` calls `welcomeOnce` after `saveSession`, errors swallowed), `backend/src/server.ts` (licence tick every 600 s, only while `downloadsOn()`), `backend/src/messages.ts` (`livetv.rec.done.title` '„{title}“ ist aufgenommen'; `download.expiring.title` `{ one: 'Ein Download läuft bald ab', other: '{n} Downloads laufen bald ab' }`; `download.expiring.body` `{ one: 'Er läuft am {date} ab.', other: 'Der erste läuft am {date} ab.' }`)
- Create: `backend/src/mail/welcome.ts`, `backend/src/downloadExpiry.ts`
- Test: create `backend/test/download-expiry.test.ts`, `backend/test/mail-welcome.test.ts`; extend `backend/test/seerr.test.ts`, `backend/test/livetv-recsched.test.ts`, `backend/test/livetv-recstore.test.ts`, `backend/test/login-finish.test.ts`

**Interfaces:**
- Consumes: Task 2 `Notice.mail`; Task 1 `mailPerson`.
- Produces: `welcomeOnce(ctx: Pick<Ctx, 'db' | 'cfg' | 'encKey'>, userId: string): Promise<boolean>` (true when this call claimed `welcomed_at`; queues `welcome` with `{ name }` and dedupe `welcome:<userId>`); `licenceExpiryTick(ctx: Pick<Ctx, 'db' | 'kv' | 'cfg' | 'fetchImpl' | 'encKey'>, now?: Date): Promise<{ warned: number; people: number } | null>` (null when it is before 09:00, from 21:00 on, or the day key is taken). The claim (Controller's call 5):
  ```sql
  update downloads set expiry_warned_at = $1
   where status in ('pending','fetched') and expiry_warned_at is null
     and expires_at > $1 and expires_at <= $1::timestamptz + interval '48 hours'
     and created_at <= $1::timestamptz - interval '48 hours'
  returning user_id, expires_at
  ```
  then per `user_id`: `notify(ctx, { userId, kind: 'download_expiring', title: m('download.expiring.title', { n }), body: m('download.expiring.body', { n, date: { date: <earliest ISO> } }), link: '/downloads', dedupe: \`dl-expiring-${userId}-${yyyy-mm-dd}\`, personal: true, mail: 'licence' })`. A failure after `setnx` deletes the day key and rethrows (epg prune pattern).
- `livetv.rec.done`: in the finish path, when `state === 'done'` and the recording has no series rule: `{ userId: row.user_id, kind: 'livetv.rec.done', title: m('livetv.rec.done.title', { title: row.title }), link: \`/live/recordings/${row.id}\`, dedupe: \`ltvrec-done-${row.id}\`, personal: true, mail: 'recording' }`.

- [ ] **Step 1: Write the failing tests:**
  - `mail-welcome.test.ts`:
    - `migration 58 marks existing accounts as welcomed`: rewind `schema_migrations` to 57 with two users whose `welcomed_at` is dropped, migrate → both have `welcomed_at = created_at`.
    - `welcomeOnce queues one welcome and claims once`: a new user (`welcomed_at` null) → true, one `welcome` row with dedupe `welcome:<id>`; a second call → false, still one row; two concurrent calls → exactly one true.
    - `welcome is claimed without an address or without mail set up` → true, zero rows; a later call → false.
  - `login-finish.test.ts`: `first sign-in of an invited person queues the welcome mail` (invite path through `resolveLogin`, mail configured) and `a second sign-in queues nothing`.
  - `seerr.test.ts`: `available webhook mails the requester once`: `MEDIA_AVAILABLE` posted twice → one `available` outbox row for the requester with dedupe `n:avail-<requestId>`; the broadcast `available_all` notice queues nothing.
  - `livetv-recsched.test.ts`: `failed recording mails the owner` (one `recording` row, dedupe `n:ltvrec-failed-<id>`); `done one-off recording creates the done notice and mail`; `done series episode mails via the episode notice only` (no `livetv.rec.done` notice); `partial series episode mails once` (the partial notice only).
  - `livetv-recstore.test.ts`: `recording marked for deletion mails its owner` (dedupe `n:ltvrec-deleting-<id>`).
  - `download-expiry.test.ts` (now = `2026-11-16T09:05:00` server time):
    - `before 09:00 nothing runs` (`08:59` → null, day key unset).
    - `licences inside the window are warned once per person`: Anna has two licences expiring in 30 h and 47 h (created 10 days ago) and one expiring in 60 h; Ben's licence expires in 20 h but was created 30 h ago → one Anna notice with `n = 2` and the earliest date, one `licence` outbox row, both licences have `expiry_warned_at`; Ben gets nothing.
    - `a second run the same day does nothing` (day key) and `the next day skips warned licences`.
    - `deleted or revoked licences are never warned`.
    - `a licence of a kids profile mails the account address`.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-welcome.test.ts test/download-expiry.test.ts test/seerr.test.ts test/livetv-recsched.test.ts test/livetv-recstore.test.ts test/login-finish.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** migration 58, `welcome.ts`, `downloadExpiry.ts`, the notice fields and the server timer (`if (downloadsOn()) void licenceExpiryTick(ctx).catch(jobFailed(ctx, app.log, 'licence-expiry', 'licence expiry tick failed'))`).
- [ ] **Step 4: Run** the same files plus `test/approval.test.ts test/expiry.test.ts test/downloads.test.ts test/i18n-messages.test.ts`, typecheck, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): welcome, wish available, recording and licence-expiry mails`.

### Task 4: Public unsubscribe route and the account's mail API

**Files:**
- Create: `backend/src/mail/personRoutes.ts` (registered in `app.ts` right after `mailRoutes`)
- Modify: `backend/src/app.ts` (`CSRF_EXEMPT` gains `'/api/public/mail/unsubscribe'`; `SENSITIVE_BODY` gains `api\/public\/mail\/` and `api\/account\/mail`; `reqSerializer` redacts `sig` **and** `t`: `/([?&](?:sig|t)=)[^&#]*/g`)
- Test: create `backend/test/mail-person-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 `readMailPrefs`, `setMailPref`, `verifyUnsubscribeToken`, `MAIL_PREF_TYPES`; stage A `mailConfigured`, `isMailAddress`; `publicOrigin`.
- Produces (routes):
  - `GET /api/account/mail` (`requireOwner`, `cache-control: no-store`) → `{ configured: boolean, hasAddress: boolean, prefs: Record<MailPrefType, boolean> }` (`configured` = `mailConfigured(cfg) && publicOrigin(cfg) !== null`). No address in the answer: the page already has it from `/api/account`.
  - `PUT /api/account/mail` (`requireOwner`, rate limit 30/min) body `{ type: z.enum(MAIL_PREF_TYPES), on: z.boolean() }` → `{ prefs }`; audit `mail.pref` `{ type, on, via: 'account' }`.
  - `POST /api/public/mail/unsubscribe` (no session, rate limit 20/min per IP): the token is `t` from the JSON body or else the query; `on` from the JSON body, default `false`; form and multipart bodies (RFC 8058) are parsed to `{}` in an encapsulated plugin (`bodyLimit` 4 096). Valid → `{ ok: true, type, on }` (an account that no longer exists: the same answer, nothing written); invalid → 400 `{ error: 'invalid_token' }`. Audit `mail.pref` `{ type, on, via: 'one_click' | 'page' }` (`page` when the token came in a JSON body), actor = the token's user. `cache-control: no-store`.
  - `GET /api/public/mail/unsubscribe` (rate limit 20/min per IP) → `303`, `location: /mail/unsubscribe?t=<t>` when `t` matches `^[A-Za-z0-9._-]{1,200}$`, else `/mail/unsubscribe`. Changes nothing.

- [ ] **Step 1: Write the failing tests** in `mail-person-routes.test.ts`:
  - `one-click POST switches the type off`: `POST /api/public/mail/unsubscribe?t=<anna licence>` with `content-type: application/x-www-form-urlencoded`, body `List-Unsubscribe=One-Click` → 200 `{ ok: true, type: 'licence', on: false }`; the same as `multipart/form-data` → 200; `readMailPrefs(anna).licence === false`; audit row `mail.pref` with `{ type: 'licence', on: false, via: 'one_click' }` and no `t` anywhere in the audit meta.
  - `page POST with a JSON body can switch back on`: `{ t, on: true }` → 200 `{ on: true }`, `via: 'page'`.
  - `one-click POST works next to a session cookie without csrf header`: Anna's `ff_sid` cookie, no `x-csrf-token` → 200.
  - `invalid token answers 400 and changes nothing`: Ben's id with Anna's mac, an unknown type, an empty `t` → 400 `invalid_token`; prefs unchanged.
  - `token of a deleted account answers ok and writes nothing`: no `user_prefs` row inserted.
  - `GET only redirects`: `GET /api/public/mail/unsubscribe?t=<token>` → 303, `location` `/mail/unsubscribe?t=<token>`, prefs unchanged; `?t=<script>` → `location: /mail/unsubscribe`.
  - `the unsubscribe routes are rate limited per IP`: the 21st POST within a minute → 429.
  - `reqSerializer redacts the unsubscribe token`: `reqSerializer({ url: '/api/public/mail/unsubscribe?t=v1.abc&x=1' }).url === '/api/public/mail/unsubscribe?t=[redacted]&x=1'`; `sig` is still redacted.
  - `account mail GET and PUT`: owner GET → `{ configured: true, hasAddress: true, prefs: all true }`; PUT `{ type: 'recording', on: false }` → prefs reflect it and the queued `recording` row is gone; a kids profile session → 403; an unknown type → 400; without mail settings → `configured: false`.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-person-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `personRoutes.ts` and the `app.ts` changes.
- [ ] **Step 4: Run** it plus `test/mail-routes.test.ts test/admin-hardening.test.ts` (CSRF and logging rules), typecheck, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): one-click unsubscribe and the account's mail switches API`.

### Task 5: The invitation mail (backend and invite dialog)

**Files:**
- Modify: `backend/src/routes/adminUsers.ts` (`POST /api/admin/invites`), `web/src/lib/admin/InvitesPanel.svelte`, `web/src/lib/i18n/locales/*/adminPeople.ts` (7 languages)
- Test: create `backend/test/mail-invite.test.ts`; extend `e2e/tests/admin-people.spec.ts`, `e2e/tests/admin-people.mobile.spec.ts`

**Interfaces:**
- Consumes: stage A `enqueueMail`, `deliverNow`, `mailConfigured`, `maskAddress`, `mailStatus` route (`GET /api/admin/mail/status` → `configured`); Task 2 `invite` params.
- Produces: the request body gains `email: z.email().max(254).optional()` and `lang: z.enum(LANGUAGES).optional()`. With `email`, checked in this order before `createInvite`: `maxUses !== 1` → 400 `invite_mail_single_use`; not `mailConfigured` or no `publicOrigin` → 400 `mail_not_configured`; `kv.incr('mail:invite:<adminId>', 86400) > 20` → 429 `rate_limited`. After `createInvite`: `enqueueMail({ kind: 'invite', to: email, userId: null, lang: lang ?? await broadcastLanguage(ctx), params: { link: inv.link, expiresAt: inv.expiresAt.toISOString(), inviter: req.user!.name }, dedupe: \`invite:${inv.id}\` })`, then `deliverNow`. The answer gains `mail?: { state: 'sent' | 'queued' | 'failed', code?: string, smtp?: number }`; the audit meta gains `mail: { to: maskAddress(email), state }`. Without `email` the route behaves exactly as today.
- Web: under the existing fields, when `/api/admin/mail/status` says `configured`: a `Field` *E-Mail-Adresse (optional)* (`type="email"`, `autocomplete="off"`) and, once an address is typed, a language `select` defaulting to the instance language; the field is disabled with the hint *Nur für Einladungen für eine Person* while `maxUses > 1`. The result box (the existing link box) gets one line in reserved space: *Einladung an {masked} verschickt.* / *Einladung wartet im Postausgang.* / the `mail.code.*` sentence for `failed` (stage A texts). `{masked}` is built in the browser from the typed address with the same rule as `maskAddress`.

- [ ] **Step 1: Write the failing tests:**
  - `mail-invite.test.ts` (fake SMTP server from stage A):
    - `invite with email sends the mail and answers sent`: body `{ role: 'friend', email: 'ben@friend.example.com', lang: 'en' }` → 200 with `mail.state === 'sent'`; the received mail's text contains the answer's `link`; the outbox row is `kind = 'invite'`, `user_id` null, `dedupe = 'invite:<id>'`, `lang = 'en'`; audit meta `mail.to === 'b…@friend.example.com'` and no full address or token in any audit row.
    - `invite mail defaults to the instance language`.
    - `multi-use invite with email answers invite_mail_single_use and creates no invite`.
    - `not configured answers mail_not_configured and creates no invite`.
    - `the 21st invite mail of the day answers rate_limited`.
    - `invite without email is unchanged` (no `mail` field, no outbox row).
  - `admin-people.spec.ts` (mocked API): `invite with e-mail shows the sent line`; `e-mail field hidden when mail is not set up`; `multi-use disables the e-mail field`; `a failed invite mail shows its sentence` (`{ state: 'failed', code: 'recipient_refused', smtp: 550 }`). No mock answer's full address appears in the DOM except inside the input.
  - `admin-people.mobile.spec.ts`: the dialog with the e-mail field has no horizontal overflow at phone width; field and select ≥ 44 px.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-invite.test.ts` and the two e2e specs. Expected: FAIL.
- [ ] **Step 3: Implement** the route change and the dialog.
- [ ] **Step 4: Run** the tests plus `test/invites.test.ts`, `cd web && npx vitest run src/lib/i18n`, svelte-check, `npm run build -w web`, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): send an invitation by mail from the invite dialog`.

### Task 6: Account card, unsubscribe page, docs and coverage

**Files:**
- Create: `web/src/lib/account/MailCard.svelte`, `web/src/lib/account/mail.ts`, `web/src/routes/mail/unsubscribe/+page.svelte`, `e2e/tests/mail-unsubscribe.spec.ts`, `e2e/tests/mail-unsubscribe.mobile.spec.ts`
- Modify: `web/src/routes/me/account/+page.svelte` (the card between the sessions row and `DataCard`, `id="mail"` on its section), `web/src/routes/+layout.svelte` (`publicPage` includes `path === '/mail/unsubscribe'`), `web/src/lib/i18n/locales/*/account.ts` (`account.mail.*`), `web/src/lib/i18n/locales/*/login.ts` (`login.unsubscribe.*`), `docs/mail.md`, `docs/security.md`, `CHANGELOG.md`
- Test: create `web/src/lib/account/mail.test.ts`; extend `e2e/tests/account.spec.ts`, `e2e/tests/account.mobile.spec.ts`

**Interfaces:**
- Consumes: Task 4 routes; `Account.email` from `/api/account`.
- Produces (`lib/account/mail.ts`): `MAIL_TYPES = ['available', 'recording', 'licence'] as const`; `loadMailPrefs(): Promise<{ configured: boolean; hasAddress: boolean; prefs: Record<MailType, boolean> }>`; `saveMailPref(type: MailType, on: boolean): Promise<Record<MailType, boolean>>`; `unsubscribeType(token: string): MailType | null` (the same regex as the backend, type from the third part); `postUnsubscribe(token: string, on: boolean): Promise<'ok' | 'invalid' | 'limited' | 'failed'>` (`POST /api/public/mail/unsubscribe` with JSON `{ t, on }`).
- **MailCard:** title *E-Mails*; the address the mails go to (`account.email`) or *Keine E-Mail-Adresse hinterlegt* with a link to `#sec-email`; when `!configured` the note *Dein Server verschickt noch keine E-Mails.*; one switch per type (`role="switch"`, `aria-checked`, 44 px) labelled *Verfügbare Wünsche* / *Aufnahmen* / *Ablaufende Downloads*, each with a one-line hint; switches disabled when `!configured || !hasAddress`; a toggle saves at once, reverts on error and shows the error in a line with reserved `min-height`.
- **Unsubscribe page** (modelled on `routes/confirm-email/+page.svelte`): `AuthShell`, `publicLocale`, the token read into memory and removed from the address bar with `history.replaceState(history.state, '', location.pathname)`; nothing is sent until the button is pressed. Views: `ready` (*Keine E-Mails mehr zu {type}?* + button *Abbestellen*), `busy`, `done` (*Abbestellt.* + *Wieder anmelden* + link *E-Mail-Einstellungen* to `/me/account#mail`), `resubscribed`, `invalid` (*Dieser Link ist ungültig.* + the settings link), `limited`, `failed` (retry). Never shows an address. Views swap with opacity only, inside a box of fixed `min-height`.

- [ ] **Step 1: Write the failing tests:**
  - `mail.test.ts`: `unsubscribeType` → `'licence'` for a well-formed token, null for `v2.…`, an unknown type, a 42-char mac, `''`; `postUnsubscribe` maps 200 → `ok`, 400 → `invalid`, 429 → `limited`, a network error → `failed`, and sends the token in the JSON body, never in the URL; `loadMailPrefs`/`saveMailPref` call the right routes.
  - `account.spec.ts`: `mail card shows the switches and saves one` (PUT body `{ type: 'recording', on: false }`); `mail card reverts a switch when saving fails`; `mail card without address disables the switches and links to the e-mail section`; `mail card when mail is not set up shows the note`.
  - `account.mobile.spec.ts`: switches ≥ 44 px, no horizontal overflow.
  - `mail-unsubscribe.spec.ts`: `unsubscribe page names the type and sends nothing until pressed` (no POST before the click; the address bar has no `t=` after load); `pressing Abbestellen then Wieder anmelden` (two POSTs with `on: false` then `on: true`); `an invalid token shows the invalid view` (shape check, no request) and `a 400 shows the invalid view`; `the page works without a session` (no `/api/me` request).
  - `mail-unsubscribe.mobile.spec.ts`: button ≥ 44 px, no horizontal overflow, the view swap does not move the heading (bounding box of `h1` unchanged before and after).
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/account/mail.test.ts` and the e2e specs. Expected: FAIL.
- [ ] **Step 3: Implement** the card, the page, the layout line and the locale keys (German source: card title *E-Mails*; hints *Wenn etwas, das du dir gewünscht hast, da ist.*, *Wenn eine Aufnahme fertig ist, fehlschlägt oder gelöscht wird.*, *Zwei Tage bevor Downloads auf deinen Geräten ablaufen.*).
- [ ] **Step 4: Docs.** `docs/mail.md`: a section *Which mails people get* (the three types with their triggers, welcome once, invitations, the licence run between 09:00 and 21:00, the switches on the account page, kids profiles and missing addresses, one-click unsubscribe and `List-Unsubscribe`; that the provider's DKIM signature must cover `List-Unsubscribe` and `List-Unsubscribe-Post` for one-click to show in big mailbox providers; that a reverse proxy's own access log sees `/mail/unsubscribe?t=` like it sees `/invite/<token>` links). `docs/security.md` *E-Mail*: the unsubscribe token (HKDF subkey, per person and type, no expiry, invalidated by rotating `APP_ENC_KEY`), redaction of `t=` in the request log, the CSRF exemption and why. `CHANGELOG.md` `[Unreleased]`: a `### Everyone` bullet **E-Mails for you** (the mails, the account card, one-click unsubscribe) and an `### Admin` bullet **Invitations by e-mail**; the stage A bullet unchanged.
- [ ] **Step 5: Run** the unit and e2e tests above, `npx vitest run src/lib/i18n`, svelte-check, `npm run build -w web`, eslint on touched files, and `cd web && npx vitest run --coverage` once: statements ≥ 94 %. Expected: PASS.
- [ ] **Step 6: Commit** `feat(mail): e-mail switches on the account page, unsubscribe page, docs`.
