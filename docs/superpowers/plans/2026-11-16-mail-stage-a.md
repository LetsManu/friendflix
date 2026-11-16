# E-mail, Stage A: transport, outbox, layout and the test mail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin enters the SMTP settings on *Admin → Einstellungen → Benachrichtigungen*, tests the connection, sends a branded test mail to their own address in their own language, and sees the mail state on the same card and as one Systemcheck line.

**Architecture:**
- **Settings:** six registry keys in a new group `mail` with a probe `mail` (connect + TLS + login, never a send). The password is a secret stored like every other (`settings/repo.ts`, AES-256-GCM).
- **Transport:** nodemailer, built per tick from the live config, logging off, certificates always verified. Errors become codes.
- **Outbox:** a Postgres table; `mailTick` claims due rows with `for update skip locked` and a lease, renders them at send time, sends, retries with backoff, enforces rate limits counted from its own rows. Address and params are encrypted while queued and dropped when final.
- **Layout:** plain TS functions produce escaped HTML and a separate plain text from the brand (name, byline, website, `accFill`, inline PNG symbol or the letter tile).
- **Admin:** `GET /api/admin/mail/status`, `POST /api/admin/mail/test` and a `core.mail` Systemcheck line.

**Tech Stack:** Fastify, Postgres (migration 57), zod 4, nodemailer 10.3.1 (new dependency), smtp-server 3.21.3 (new dev dependency, tests only), SvelteKit SPA, vitest, Playwright e2e with mocks.

**Spec:** `docs/superpowers/specs/2026-11-16-mail-design.md` (decisions, Controller's calls and the later stages B and C).

## Global Constraints

- **Secrets and personal data never reach a log, an audit row, an error text or an API answer:** the SMTP password, nodemailer's debug output (it carries the base64 `AUTH` exchange), tokens, full e-mail addresses. Logs and audit rows carry codes only; an address appears at most masked by `maskAddress` (`a…@friend.example.com`). nodemailer options always have `logger: false` and `debug: false`. The SMTP server's reply text is never stored or returned; only its 3-digit status.
- **Never "Netflix" or "Seerr"** in user-facing text, code comments or docs; the request service is "request service" / "Wünsche".
- **Fictional names and placeholder hosts only:** Anna Beispiel, Nordlicht TV; `friend.example.com`, `mail.example.com`, `192.0.2.x`. Test addresses: `anna@friend.example.com`, sender `kino@friend.example.com`. No real domains, also not in `docs/mail.md` (providers by name, every host as `mail.example.com`).
- **7 locales** de, en, es, fr, it, pl, tr with identical key order (web locale files and `backend/src/messages.ts`); German is the source; real umlauts; "…" not "...".
- **UI:** animate only transform/opacity, never `scale()` on text, nothing may jump (reserve space for results), 44 px touch targets (36 px only for mouse-only small buttons), glass look (`.frost`, `--fr-r-*`), brand tokens `--acc*`.
- **Docker socket** is never given to web, backend, gateway or livetv.
- **Web coverage gate** ≥ 94 % statements.
- **Checks agents run:** typecheck (backend: `cd backend && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`; web: `cd web && npx svelte-kit sync && npx svelte-check --threshold error`, 4 known env errors in `routes/manifest.webmanifest/+server.ts` and `routes/cast-receiver/+server.ts`), `npm run build -w web`, `npx eslint <touched files>`, and the specific test files (backend vitest needs Postgres at 127.0.0.1:5433, `TEST_DATABASE_URL` per the helpers; e2e from `e2e/`: `E2E_PORT=<free> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off`). CI runs the rest.
- **Dependencies:** `nodemailer@10.3.1` in `backend` dependencies and `smtp-server@3.21.3` in `backend` devDependencies, both written to `backend/package.json` and the root `package-lock.json` (CI runs `npm ci`). Install with `npm install nodemailer@10.3.1 -w backend && npm install -D smtp-server@3.21.3 -w backend` from the repo root, then check that `git diff package-lock.json` adds only these two plus `punycode.js` and `ipv6-normalize` (smtp-server's) and exactly one `nodemailer` entry. Both ship their own types; no `@types/*`. If `node_modules` is a symlink into another checkout, the install adds the packages there too, which is harmless.
- **Git:** merge, never rebase or force-push; never `git stash`. Every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- **Exact values** (from the spec):

  | What | Value |
  |---|---|
  | Settings | `MAIL_SMTP_HOST` (hostSchema), `MAIL_SMTP_PORT` (int 1–65535, default 587), `MAIL_SMTP_TLS` (`starttls` \| `tls` \| `none`, default `starttls`), `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD` (secret, no hint), `MAIL_FROM` (address, error `invalid_email`) |
  | Configured | `MAIL_SMTP_HOST` and `MAIL_FROM` set |
  | TLS | `starttls` → `requireTLS: true`; `tls` → `secure: true`; `none` → no login ever (probe `invalid`/`insecure_auth`); `tls.minVersion: 'TLSv1.2'`; never `rejectUnauthorized: false` |
  | Timeouts | send: connection 10 s, greeting 10 s, socket 30 s; probe: 5 s each (or the caller's smaller limit) |
  | Pool | `pool: true`, `maxConnections: 1`, `maxMessages: 50`, closed at the end of each tick |
  | EHLO name | host of `PUBLIC_URL`, else `'friendflix.invalid'` |
  | Backoff | 60, 300, 1800, 7200, 21600 s; the 6th failed attempt is final |
  | Lease | 2 min; claim batch 20 |
  | Expiry | queued for 72 h → `failed`/`expired` |
  | Retention | final rows deleted 30 days after `finished_at` |
  | Rate limits | per recipient 10/h and 50/day, instance 200/h (counted from `sent` rows); test mail 3 per 10 min per admin (kv `mail:test:<userId>`, TTL 600 s) plus route `rateLimit` 10/min |
  | Tick | every 30 s, only with `BACKGROUND_JOBS=true` and `isOperational`, busy flag |
  | Logo | inline CID `brand-symbol` only when the symbol is `image/png` and ≤ 200 KB, shown at 48 × 48; else the letter tile on `accFill` |
  | Layout colours | page `#f4f4f6`, card `#ffffff`, text `#1a1d21`, muted `#5b6370`, accent bar 4 px and button in `accFill` with `#ffffff` text, width 600 px |
  | HTML size | < 100 000 bytes |
  | Headers | `Auto-Submitted: auto-generated`, `Content-Language: <lang>` |
  | Systemcheck | line `core.mail` after `core.env`; probe cached in kv `mail:probe` for 600 s, *Jetzt prüfen* re-probes; queue stuck = oldest queued row older than 1 h |

## Review Focus

1. **A wrong password or an unreachable server while 30 mails wait:** the attempts of the waiting mails stay unchanged, the tick stops after the first transport error, and the next tick waits the transport backoff. Task 3 test `transport error gives the claimed rows back without using an attempt`.
2. **A server that does not offer STARTTLS, or presents an untrusted certificate:** the mail fails with `tls` and no `AUTH` command is ever sent. Task 1 tests `starttls without STARTTLS fails with tls and never authenticates` and `untrusted certificate fails with tls`.
3. **A brand name or byline with markup or quotes** (`<b>Nordlicht "TV"</b>`): the HTML shows it as text, the `From` display name is quoted correctly, the subject has no line break. Task 2 test `brand text is escaped in html and subject`; Task 3 test `brand name with quotes is a safe From display name`.
4. **Two backend instances ticking at once, or a crash mid-send:** each due row is claimed by one tick only; a row whose lease ran out is picked up again. Task 3 tests `two concurrent ticks send each mail once` and `expired lease is claimed again`.
5. **An admin without an e-mail address, or mail not configured, presses *Testmail senden*:** a 400 with `no_address` / `mail_not_configured` and a sentence on the card, no row queued. Task 4 tests `test mail without address answers no_address` and `test mail unconfigured answers mail_not_configured`; Task 5 e2e `test mail errors show a sentence`.

---

### Task 1: Settings, transport and the `mail` probe

**Files:**
- Modify: `backend/package.json`, `package-lock.json` (Global Constraints "Dependencies")
- Modify: `backend/src/config.ts` (six keys), `backend/src/settings/registry.ts` (group `mail`, `ProbeId` `mail`, six `setting(...)` lines after the push group), `backend/src/settings/probes.ts` (`probeConfigured` case, `runProbe` case forwarding `timeoutMs`), `backend/src/routes/adminSettings.ts` (`SETTING_GROUPS` gains `'mail'`; `CREDENTIAL_DESTINATIONS` gains `MAIL_SMTP_PASSWORD: ['MAIL_SMTP_HOST', 'MAIL_SMTP_PORT', 'MAIL_SMTP_TLS']`), `compose.yaml` and `compose.prod.yaml` (run `npm run compose:env`), `backend/test/helpers.ts` (`cfg` lists the six keys: host/user/password/from `undefined`, port 587, tls `'starttls'`)
- Create: `backend/src/mail/transport.ts`, `backend/src/mail/address.ts`, `backend/test/smtpfake.ts`, `backend/test/fixtures/smtp/cert.pem`, `backend/test/fixtures/smtp/key.pem` (self-signed for `localhost` + `IP:127.0.0.1`, 36500 days, generated once with `openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1`)
- Test: `backend/test/mail-transport.test.ts`, extend `backend/test/settings-registry.test.ts`, `backend/test/settings-probes.test.ts`, `backend/test/admin-settings.test.ts`, run `backend/test/compose-env.test.ts`

**Interfaces:**
- Produces (`mail/address.ts`): `isMailAddress(s: string): boolean`; `maskAddress(addr: string): string` (first character of the local part, `…`, `@`, the domain; anything unparsable → `'…'`); `mailSubkey(encKey: Buffer, purpose: 'recipient' | 'unsubscribe'): Buffer` (HKDF-SHA256, salt `'friendflix-mail'`, info `` `${purpose} v1` ``, 32 bytes); `recipientKey(encKey: Buffer, addr: string): string` (hex HMAC-SHA256 with the `recipient` subkey over the trimmed, lower-cased address).
- Produces (`mail/transport.ts`):
  - `type MailErrorCode = 'not_configured' | 'insecure_auth' | 'unreachable' | 'timeout' | 'tls' | 'auth' | 'sender_refused' | 'recipient_refused' | 'message_refused' | 'unexpected'`
  - `interface MailFailure { code: MailErrorCode; smtp: number | null; scope: 'transport' | 'message'; permanent: boolean }`
  - `mailConfigured(cfg: Config): boolean`
  - `transportOptions(cfg: Config, o?: { probe?: boolean; timeoutMs?: number }): SMTPTransport.Options` (throws `MailError` with `not_configured` / `insecure_auth`)
  - `createMailTransport(cfg: Config, o?): Transporter`
  - `classifyMailError(e: unknown): MailFailure` (internal reasoning may read `e.code`, `e.command`, `e.responseCode` and, for TLS detection only, the message; nothing but the result leaves)
  - `class MailError extends Error { constructor(readonly failure: MailFailure) }` with message = the code
  - `probeMail(cfg: Config, o?: { timeoutMs?: number }): Promise<ProbeResult>`: `not_configured` → `fail('invalid','not_set')`, `insecure_auth` → `fail('invalid','insecure_auth')`, `auth` → `fail('unauthorized')`, `tls` → `fail('invalid','tls')`, `timeout` → `fail('timeout')`, else `fail('unreachable')`; `verify()` then `close()`
  - `setMailTestCa(pem: string | null): void` — tests only; adds `tls.ca` to the options. Comment says so.
- Produces (`test/smtpfake.ts`): `startSmtp(o: { mode: 'starttls' | 'tls' | 'none'; user?: string; pass?: string; noStarttls?: boolean; rcpt?: (addr: string) => number | null }): Promise<{ port: number; messages: Array<{ from: string; to: string[]; raw: string }>; auths: number; close(): Promise<void> }>` on `127.0.0.1` with the fixture cert, `rcpt` returning a status to refuse with (e.g. 550, 450).

- [ ] **Step 1: Failing tests.**
  - `settings-registry.test.ts`: `mail keys are registered`: the six keys exist in group `mail`, `MAIL_SMTP_PASSWORD` has `secret: true` and no `hint`, `MAIL_SMTP_PORT` default 587 with min 1 / max 65535, `MAIL_SMTP_TLS` options `['starttls','tls','none']`; `parseSettingValue(def('MAIL_FROM'), 'kein-at')` → `{ ok: false, code: 'invalid_email' }`; `'mail.example.com:587'` for the host → `invalid_host`.
  - `admin-settings.test.ts`: `changing the smtp host with a saved password needs a fresh sign-in` (`redirectsSavedCredential` true for host, port and TLS changes; false for a `MAIL_FROM` change).
  - `mail-transport.test.ts` (smtp-server via `startSmtp`, `setMailTestCa(fixture)` in `beforeAll`, reset in `afterAll`):
    - `options never log and always verify`: `transportOptions(cfg)` has `logger: false`, `debug: false`, `requireTLS: true` (starttls), no `rejectUnauthorized`, `tls.minVersion === 'TLSv1.2'`, `name === 'portal.example.com'` (helpers' `PUBLIC_URL`), `pool: true`, `maxConnections: 1`.
    - `none with credentials is refused`: `transportOptions({ …, MAIL_SMTP_TLS: 'none', MAIL_SMTP_USER: 'anna' })` throws `MailError` code `insecure_auth`; `probeMail` → `{ ok: false, code: 'invalid', detail: 'insecure_auth' }`.
    - `probe ok on starttls with login`: server `{ mode: 'starttls', user: 'anna', pass: 'pw-1' }` → `{ ok: true, code: 'ok' }`, `messages.length === 0`.
    - `probe ok on implicit tls` (`mode: 'tls'`, port from the fake, `MAIL_SMTP_TLS: 'tls'`).
    - `wrong password is auth`: → `{ ok: false, code: 'unauthorized' }`.
    - `starttls without STARTTLS fails with tls and never authenticates`: `noStarttls: true` → `detail: 'tls'`, `auths === 0`.
    - `untrusted certificate fails with tls`: `setMailTestCa(null)` for this case → `detail: 'tls'`.
    - `closed port is unreachable`: a port the fake closed → `code: 'unreachable'`.
    - `classify 550 at RCPT is a permanent recipient refusal`: send through `createMailTransport` to an `rcpt` returning 550 → `classifyMailError` gives `{ code: 'recipient_refused', smtp: 550, scope: 'message', permanent: true }`; with 450 → `permanent: false`.
    - `nothing secret is printed`: spy on `console.log/info/warn/error` and `process.stdout.write` during a successful send and a failed login; no call contains `pw-1`, `Buffer.from('\0anna\0pw-1').toString('base64')` (the `AUTH PLAIN` payload) or `anna@friend.example.com`.
    - `maskAddress` cases: `anna@friend.example.com` → `a…@friend.example.com`; `x` → `…`; `recipientKey` equal for `Anna@Friend.example.com ` and `anna@friend.example.com`, 64 hex chars.
  - `settings-probes.test.ts`: `mail probe is not run when the host is empty` (`probeConfigured('mail', cfg)` false).
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-transport.test.ts test/settings-registry.test.ts test/settings-probes.test.ts test/admin-settings.test.ts`. Expected: FAIL (missing module / keys).
- [ ] **Step 3: Install the dependencies** (Global Constraints) **and implement.** `MAIL_FROM` uses a schema like `hostSchema`: `z.preprocess(emptyAsUnset, z.string().trim().transform(...addIssue params.code 'invalid_email' unless z.email() accepts it).optional())`. `MAIL_SMTP_HOST` reuses the `LIVETV_SRT_HOST` preprocess + `hostSchema.optional()`. Run `npm run compose:env` to regenerate the compose blocks.
- [ ] **Step 4: Run** the four test files plus `test/compose-env.test.ts` and the backend typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): SMTP settings, the nodemailer transport and the connection probe`.

### Task 2: Layout, the `test` template and the backend texts

**Files:**
- Create: `backend/src/mail/html.ts` (escaping and the layout), `backend/src/mail/templates.ts` (one function per kind; stage A: `test`), `backend/src/mail/brand.ts` (the brand as the layout needs it)
- Modify: `backend/src/messages.ts` (the `mail.*` keys in all 7 catalogues, same order)
- Test: `backend/test/mail-render.test.ts`, `backend/test/i18n-messages.test.ts` (runs unchanged; must stay green)

**Interfaces:**
- Consumes: `readBrand`, `readImage` (`brand/repo.ts`), `deriveTokens` (`brand/colors.ts`), `msg`, `Language` (`i18n.ts`), `publicOrigin` (`config.ts`).
- Produces (`mail/html.ts`): `esc(s: string): string` (`& < > " '`); `safeHref(url: string): string | null` (http/https only, else null); `interface LayoutInput { lang: Language; brand: MailBrand; heading: string; paragraphs: string[]; button?: { label: string; url: string }; reason: string; footerLinks: Array<{ label: string; url: string }> }`; `layout(i: LayoutInput): { html: string; text: string }`.
- Produces (`mail/brand.ts`): `interface MailBrand { name: string; byline: string; website: string; fill: string; letter: string; symbol: { cid: 'brand-symbol'; png: Buffer } | null; legal: { imprint?: string; privacy?: string; help?: string } }`; `mailBrand(ctx: Pick<Ctx, 'db'>): Promise<MailBrand>` (`legal` is `{}` until Branding stage B adds the fields; `letter` = first code point of the name, upper-cased).
- Produces (`mail/templates.ts`): `type MailKind = 'test'`; `interface RenderedMail { subject: string; html: string; text: string; attachments: Array<{ cid: string; filename: string; content: Buffer; contentType: 'image/png' }> ; headers: Record<string, string> }`; `renderMail(ctx: Pick<Ctx, 'db' | 'cfg'>, kind: MailKind, lang: Language, params: Record<string, unknown>): Promise<RenderedMail>`.
- German texts (exact; the other six languages translate them, `{app}` is the brand name passed as a param):
  - `'mail.test.subject': 'Testmail von {app}'`
  - `'mail.test.heading': 'E-Mail-Versand funktioniert'`
  - `'mail.test.body': 'Diese Testmail hat {app} über deinen Mailserver geschickt. Wenn du sie lesen kannst, kommen E-Mails von {app} an.'`
  - `'mail.test.reason': 'Du bekommst diese E-Mail, weil du in {app} unter „Einstellungen → Benachrichtigungen“ eine Testmail angefordert hast.'`
  - `'mail.open': '{app} öffnen'`
  - `'mail.footer.website': 'Website'`, `'mail.footer.imprint': 'Impressum'`, `'mail.footer.privacy': 'Datenschutz'`, `'mail.footer.help': 'Hilfe'`

- [ ] **Step 1: Failing tests** in `mail-render.test.ts` (database from the helpers; brand rows written through `saveBrand` / `storeImage`):
  - `default brand renders the letter tile and no attachment`: `attachments.length === 0`, HTML contains `>F<` inside the tile cell with `background-color:#d6325a` (the default `accFill`), no `<img`.
  - `png symbol under 200 KB is inline`: one attachment, `cid === 'brand-symbol'`, HTML has `src="cid:brand-symbol"` with `width="48" height="48"`, and no `http` image source anywhere (`/<img[^>]+src="http/` does not match).
  - `webp symbol falls back to the letter tile` and `png symbol over 200 KB falls back to the letter tile`.
  - `brand text is escaped in html and subject`: name `<b>Nordlicht "TV"</b>` → HTML contains `&lt;b&gt;Nordlicht &quot;TV&quot;&lt;/b&gt;`, never `<b>Nordlicht`; subject has no `\r` or `\n`.
  - `button uses the contrast-safe fill`: accent `#f2e94e` → button `background-color` equals `deriveTokens('#f2e94e').accFill`, text `#ffffff`.
  - `text alternative carries the same content`: `text` contains the heading, the body, `{app} öffnen: https://portal.example.com/` and no `<`.
  - `renders in the requested language`: `lang: 'en'` subject equals the English catalogue entry; `lang: 'pl'` likewise.
  - `footer shows the website only when set`: brand `website: 'https://friend.example.com/'` → link present in HTML and text; empty → absent.
  - `html stays under 100 KB` for the `test` mail with a 24-character name and a 32-character byline.
  - `headers`: `Auto-Submitted: auto-generated`, `Content-Language: de`.
  - `safeHref` refuses `javascript:alert(1)` and `mailto:x`.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Table layout with inline styles, colours from Global Constraints; the button is a table cell with the link inside (works without CSS support); `<html lang>` and `<meta charset="utf-8">`; a hidden preheader with the first paragraph.
- [ ] **Step 4: Run** `npx vitest run test/mail-render.test.ts test/i18n-messages.test.ts` and the backend typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): branded HTML and text layout and the test mail texts in seven languages`.

### Task 3: Outbox and worker

**Files:**
- Modify: `backend/src/db.ts` (migration 57, the SQL from the spec "Outbox"; if 57 is taken when you start, the next free number), `backend/src/server.ts` (a `mailTick` timer inside the `BACKGROUND_JOBS` block, busy flag, `jobFailed(ctx, app.log, 'mail', 'mail tick failed')`)
- Create: `backend/src/mail/outbox.ts`, `backend/src/mail/worker.ts`
- Test: `backend/test/mail-outbox.test.ts`

**Interfaces:**
- Consumes: Task 1 `createMailTransport`, `classifyMailError`, `mailConfigured`, `maskAddress`, `recipientKey`; Task 2 `renderMail`, `mailBrand`; `encrypt`/`decrypt` (`crypto.ts`).
- Produces (`mail/outbox.ts`):
  - `interface EnqueueInput { kind: MailKind; to: string; userId: string | null; lang: Language; params?: Record<string, unknown>; dedupe?: string }`
  - `enqueueMail(ctx: Pick<Ctx, 'db' | 'encKey'>, m: EnqueueInput): Promise<string | null>` (the row id; null when the dedupe key exists; an address `isMailAddress` refuses throws `HttpError(400, 'no_address')`; enqueueing never needs the transport)
  - `interface MailStatus { configured: boolean; queued: number; failed24h: number; lastSentAt: string | null; lastFailure: { kind: string; code: string; smtp: number | null; at: string } | null; transport: { code: string; at: string } | null; oldestQueuedAt: string | null }`
  - `mailStatus(ctx: Pick<Ctx, 'db' | 'kv' | 'cfg'>): Promise<MailStatus>`
  - `BACKOFF_S = [60, 300, 1800, 7200, 21600]`, `MAX_ATTEMPTS = 6`, `LIMITS = { perRcptHour: 10, perRcptDay: 50, instanceHour: 200 }`
- Produces (`mail/worker.ts`):
  - `mailTick(ctx: Ctx, now?: Date): Promise<{ sent: number; failed: number; deferred: number }>`
  - `deliverNow(ctx: Ctx, id: string): Promise<{ state: 'sent' | 'queued' | 'failed'; code?: string; smtp?: number }>` (claims only this row, same path)
  - kv key `mail:transport` = JSON `{ code, at }` of the last transport failure (cleared on a successful send), `mail:transport:fails` the consecutive count (TTL 86400)

- [ ] **Step 1: Failing tests** in `mail-outbox.test.ts` (smtp-server fake from Task 1, `setMailTestCa`; a test user Anna Beispiel with `anna@friend.example.com`; `now` passed in):
  - `queued row holds no readable address or params`: after `enqueueMail`, the row's `rcpt_enc` and `params_enc` do not contain `anna` or the param value; `rcpt_mask === 'a…@friend.example.com'`.
  - `tick sends and finalises`: one row → fake receives one message with `To: anna@friend.example.com`, `From: "FriendFlix" <kino@friend.example.com>`; row `state = 'sent'`, `rcpt_enc` and `params_enc` null, `sent_at` set.
  - `brand name with quotes is a safe From display name`: brand name `Nordlicht "TV"` → the worker passes `from` as `{ name, address }` (never a built string); the received raw `From:` header is one line, ends with `<kino@friend.example.com>` and nothing else is a recipient.
  - `dedupe key queues once`: second `enqueueMail` with the same key → null, one row.
  - `450 is retried with backoff`: `rcpt` → 450 → row `queued`, `attempts = 1`, `next_at = now + 60 s`, `last_code = 'recipient_refused'`, `last_smtp = 450`; after five more failing ticks (advancing `now` past each `next_at`) → `failed`, `attempts = 6`, `finished_at` set.
  - `550 fails at once`: → `failed` after one attempt, `last_smtp = 550`.
  - `transport error gives the claimed rows back without using an attempt`: 3 rows, wrong password → all 3 `queued`, `attempts = 0`, `next_at = now + 60 s`, kv `mail:transport` has `code: 'auth'`, fake saw at most one connection; the second failing tick moves `next_at` by 300 s.
  - `two concurrent ticks send each mail once`: 10 rows, `Promise.all([mailTick(ctx), mailTick(ctx)])` → fake has 10 messages, each recipient/param once.
  - `expired lease is claimed again`: a row in `sending` with `lease_until` in the past is sent by the next tick.
  - `per-recipient limit defers instead of dropping`: 12 rows for Anna → 10 sent, 2 `queued` with `next_at` ≥ the hour window's end, `attempts = 0`.
  - `old queued mail expires`: a row created 73 h before `now` → `failed`, `last_code = 'expired'`, nothing sent.
  - `final rows are deleted after 30 days`.
  - `deleted user removes queued mail` (`on delete cascade`).
  - `unconfigured tick does nothing`: `MAIL_SMTP_HOST` unset → rows stay `queued`, `attempts = 0`.
  - `mailStatus counts and last failure carry no address`: JSON of the status does not contain `anna@`.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-outbox.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, the outbox and the worker. Claim SQL and the transport-error rule as in the spec "Outbox". The rate-limit check runs per claimed row before sending, counting `sent` rows by `rcpt_key` in the last hour / day and all `sent` rows in the last hour; a row over a limit goes back to `queued` with `attempts = attempts - 1` and `next_at` = the time the oldest counted row leaves the window. Expiry and the 30-day delete run at the start of each tick. Log lines: `{ mail: id, code }` only.
- [ ] **Step 4: Run** the test file and the backend typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): durable outbox with retries, rate limits and a background sender`.

### Task 4: Admin routes and the Systemcheck line

**Files:**
- Create: `backend/src/mail/routes.ts`, `backend/src/syscheck/checks/mail.ts`
- Modify: `backend/src/app.ts` (register `mailRoutes`; add `^/api/admin/mail` to `SENSITIVE_BODY`), `backend/src/syscheck/types.ts` (`'core.mail'` after `'core.env'` in `CHECK_IDS`), `backend/src/syscheck/checks/index.ts` (add `mailCheck`)
- Test: `backend/test/mail-routes.test.ts`, `backend/test/syscheck-mail.test.ts`, run `backend/test/syscheck.test.ts`

**Interfaces:**
- Consumes: Task 1 `probeMail`, `mailConfigured`; Task 3 `enqueueMail`, `deliverNow`, `mailStatus`; `requireAdmin` (`session.ts`), `audit`; `userLanguage`.
- Produces (routes, both `requireAdmin`, CSRF as every admin route):
  - `GET /api/admin/mail/status` → `MailStatus` (Task 3), `cache-control: no-store`.
  - `POST /api/admin/mail/test` (no body; `rateLimit` 10/min) → 200 `{ state: 'sent' }` or `{ state: 'queued' | 'failed', code, smtp? }`; 400 `{ error: 'mail_not_configured' }` or `{ error: 'no_address' }`; 429 `{ error: 'rate_limited' }`. Recipient = `users.email` of `req.user`, language = `userLanguage(ctx, req.user.id)`, kind `test`, dedupe none. Audit `mail.test` with `{ state, code? }`.
- Produces (`syscheck/checks/mail.ts`): `mailCheck: GroupCheck` with `group: 'core'`, `ids: ['core.mail']`, `timeoutMs: CHECK_TIMEOUT_MS`; it calls `runProbe(ctx, 'mail', cfg, { timeoutMs: 3_500 })` unless kv `mail:probe` holds a result younger than 600 s and `env.fresh` is false; codes as in the spec "Admin surface" (`mail_not_set` with `settingKey: 'MAIL_SMTP_HOST'`, `mail_unreachable` with `settingKey: 'MAIL_SMTP_HOST'`, `mail_tls` with `settingKey: 'MAIL_SMTP_TLS'`, `mail_auth` with `settingKey: 'MAIL_SMTP_PASSWORD'`, `mail_insecure_auth` with `settingKey: 'MAIL_SMTP_TLS'`, `mail_last_failed` with `params: { code, smtp }` and `href: '/admin/settings?tab=notifications'`, `mail_queue_stuck` with the same href, `docs: 'mail.md'` on every non-ok line).

- [ ] **Step 1: Failing tests.**
  - `mail-routes.test.ts`:
    - `non-admin gets 403` on both routes.
    - `test mail unconfigured answers mail_not_configured` and nothing is queued.
    - `test mail without address answers no_address` (admin with `email = null`).
    - `test mail is delivered and audited`: fake SMTP receives one mail to the admin's address in the admin's language (profile language `en` → English subject); answer `{ state: 'sent' }`; audit row `mail.test` whose `meta` is `{"state":"sent"}` and contains no `@`.
    - `test mail failure answers the code`: fake refuses RCPT 550 → `{ state: 'failed', code: 'recipient_refused', smtp: 550 }`.
    - `fourth test mail in 10 minutes is rate limited` → 429.
    - `status carries no address or password`: response JSON does not contain `@friend.example.com` or the password.
  - `syscheck-mail.test.ts` (`resetChecksForTests` + `registerChecks([mailCheck])`, as the other syscheck tests):
    - `not set up is neutral`: no host → `not_set_up`, cause `mail_not_set`, `settingKey: 'MAIL_SMTP_HOST'`, `settingGroup: 'mail'`.
    - `wrong password is a problem pointing at the password`: `problem`, `mail_auth`, `settingKey: 'MAIL_SMTP_PASSWORD'`.
    - `recent final failure is a warning with codes only`: a `failed` row from 2 h ago with `last_code 'recipient_refused'`, `last_smtp 550` → `warning`, `mail_last_failed`, `params: { code: 'recipient_refused', smtp: 550 }`.
    - `old queued mail is a warning`: a queued row from 2 h ago → `mail_queue_stuck`.
    - `probe result is cached`: two runs within 600 s probe once (count the fake's connections); `fresh: true` probes again.
    - `ok`: everything fine → `ok`, no cause.
- [ ] **Step 2: Run** `cd backend && npx vitest run test/mail-routes.test.ts test/syscheck-mail.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the two files plus `test/syscheck.test.ts` and the backend typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): admin test mail, mail status and the Systemcheck line`.

### Task 5: Web — the E-Mail card, *Testmail senden*, the Systemcheck line

**Files:**
- Modify: `web/src/lib/admin/settings/api.ts` (`SettingGroup` gains `'mail'`; `PROBE_GROUPS` gains `'mail'`), `web/src/lib/admin/settings/tabs.ts` (`TAB_GROUPS.notifications = ['notifications', 'push', 'mail']`), `web/src/routes/admin/settings/+page.svelte` (render `<MailStatus />` inside the `mail` group's card, below the rows and the Test result), `web/src/lib/admin/syscheck.ts` (`'core.mail'` after `'core.env'`), the 7 locales' `settings.ts` (`groups.mail`, `keys.MAIL_*`, `options.MAIL_SMTP_TLS`, `errors.invalid_email`, `probeDetail.insecure_auth`, `probeDetail.tls`, a new `mail` block) and `syscheck.ts` (`line.core_mail`, `cause.*`, `fix.*` for the seven codes), `e2e/mocks/settings.ts` (the `mail` group in the mocked view; `GET /api/admin/mail/status` and `POST /api/admin/mail/test` with per-test answers)
- Create: `web/src/lib/admin/settings/mail.ts`, `web/src/lib/admin/settings/MailStatus.svelte`
- Test: `web/src/lib/admin/settings/mail.test.ts`, `web/src/lib/admin/settings/tabs.test.ts`, `web/src/lib/admin/syscheck.test.ts` (the id list), `e2e/tests/admin-mail.spec.ts`, `e2e/tests/admin-mail.mobile.spec.ts`

**Interfaces:**
- Consumes: Task 4 routes and codes.
- Produces (`mail.ts`): `loadMailStatus(): Promise<MailStatus>`; `sendTestMail(): Promise<TestMailResult>`; `statusLine(s: MailStatus, tr: Translate, fmtDate: (iso: string) => string): string` (not configured → `settings.mail.notConfigured`; else last sent and, if any, the last failure sentence `settings.mail.code.<code>` with the SMTP status); `testResultText(r: TestMailResult | { error: string }, tr: Translate): { tone: 'ok' | 'warn' | 'err'; text: string }`.
- German texts (exact): `groups.mail: 'E-Mail'`; `MAIL_SMTP_HOST: { label: 'SMTP-Server', help: 'Hostname oder IP-Adresse des Mailservers deines Anbieters, ohne Port, z. B. mail.example.com.' }`; `MAIL_SMTP_PORT: { label: 'Port', help: 'Meist 587 mit STARTTLS oder 465 mit TLS.' }`; `MAIL_SMTP_TLS: { label: 'Verschlüsselung', help: 'Ohne Verschlüsselung nur für einen Mailserver im Heimnetz, der keine Anmeldung braucht.' }` with options `starttls: 'STARTTLS'`, `tls: 'TLS'`, `none: 'Keine'`; `MAIL_SMTP_USER: { label: 'Benutzername' }`; `MAIL_SMTP_PASSWORD: { label: 'Passwort', help: 'Bei vielen Anbietern ein eigenes App-Passwort.' }`; `MAIL_FROM: { label: 'Absenderadresse', help: 'Von dieser Adresse sendet {app}. Als Name steht der Name aus Branding davor.' }`; `errors.invalid_email: 'Keine gültige E-Mail-Adresse.'`; `probeDetail.insecure_auth: 'Ohne Verschlüsselung sendet {app} kein Passwort. Wähle STARTTLS oder TLS, oder lass Benutzername und Passwort leer.'`; `probeDetail.tls: 'Die verschlüsselte Verbindung kam nicht zustande (Zertifikat ungültig oder kein STARTTLS).'`; `mail.test: 'Testmail senden'`, `mail.testHint: 'Geht an deine eigene Adresse.'`, `mail.sent: 'Testmail gesendet. Schau in dein Postfach.'`, `mail.queued: 'Noch nicht gesendet ({code}); {app} versucht es weiter.'`, `mail.failed: 'Nicht gesendet: {reason}'`, `mail.notConfigured: 'Trag Server und Absenderadresse ein und speichere.'`, `mail.noAddress: 'Dein Konto hat keine E-Mail-Adresse.'`, `mail.lastSent: 'Zuletzt gesendet: {when}'`, `mail.lastFailure: 'Letzter Fehler: {reason} ({when})'`, `mail.queuedCount: { one: '{n} E-Mail wartet', other: '{n} E-Mails warten' }`, `mail.code.{unreachable,timeout,tls,auth,sender_refused,recipient_refused,message_refused,expired,unexpected,rate_limited}` (one short sentence each; with `smtp` → `… (SMTP {smtp})`); `syscheck.line.core_mail: 'E-Mail-Versand'`.

- [ ] **Step 1: Failing tests.**
  - `mail.test.ts`: `statusLine` for not configured, sent with no failure, a failure with SMTP 550 (contains `550`), the queued count plural; `testResultText` for `sent` (ok), `queued` (warn), `failed` (err), `{ error: 'no_address' }`, `{ error: 'rate_limited' }`.
  - `tabs.test.ts`: `mail is on the notifications tab` (`tabOfGroup('mail') === 'notifications'`).
  - `syscheck.test.ts`: the id list includes `'core.mail'` right after `'core.env'`.
  - `admin-mail.spec.ts`:
    - `mail card on the notifications tab`: the card *E-Mail* with the six rows; the password row is write-only; *Verschlüsselung* offers STARTTLS / TLS / Keine.
    - `test mail success`: *Testmail senden* → `POST /api/admin/mail/test` once; the result line "Testmail gesendet. Schau in dein Postfach." appears; the button's and the card's bounding boxes do not move between before and after (reserved space).
    - `test mail errors show a sentence`: 400 `no_address` → "Dein Konto hat keine E-Mail-Adresse."; `{ state: 'failed', code: 'auth' }` → the `mail.code.auth` sentence.
    - `status line shows the last failure with its SMTP status`.
    - `Systemcheck shows the mail line`: `/admin/status` lists *E-Mail-Versand* with *Zur Einstellung* leading to `?setting=MAIL_SMTP_PASSWORD` for `mail_auth`.
    - No mock answer contains a password or the `LEAK` canary in the DOM.
  - `admin-mail.mobile.spec.ts`: the button is ≥ 44 px high and the card has no horizontal overflow at the phone width.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/admin/settings src/lib/admin/syscheck.test.ts` and the two e2e specs. Expected: FAIL.
- [ ] **Step 3: Implement.** `MailStatus.svelte`: status line and result line each in a box with a fixed `min-height` (no jump), the button `.sec` at 44 px, a busy state via the existing busy pattern, the result fades in with opacity only; it reloads the status after a test and after the card's group save.
- [ ] **Step 4: Run** the unit tests, `npx vitest run src/lib/i18n` (key order), both e2e specs plus `e2e/tests/admin-settings.spec.ts` and `e2e/tests/admin-health.spec.ts` (Systemcheck), svelte-check and `npm run build -w web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): E-Mail card with test mail and status, and the Systemcheck line in the web`.

### Task 6: Docs, CHANGELOG, coverage

**Files:**
- Create: `docs/mail.md`
- Modify: `docs/security.md` (section "E-Mail": what is stored encrypted, what is never logged, TLS rules, re-auth, no tracking), `docs/integrations.md` (a short "E-Mail" section linking `mail.md`), `README.md` (one features line and the docs table row), `CHANGELOG.md` (`[Unreleased]` → `### Admin`, one bullet)
- Test: none new; run the web coverage once

- [ ] **Step 1: Write `docs/mail.md`:**
  - what FriendFlix sends today (the test mail; the person and admin mails come in later releases) and what stays with Authentik (password reset);
  - the six settings with their defaults, where they are (*Admin → Einstellungen → Benachrichtigungen → E-Mail*) and that `.env` values lock them;
  - TLS modes, which port goes with which, why `none` refuses a login;
  - common providers by name only, with port, TLS mode and the app-password note, every host written as `mail.example.com`: a mailbox provider with app passwords, Gmail / Google Workspace (app password, needs 2-step verification), Microsoft 365 (SMTP AUTH must be allowed for the mailbox; OAuth2-only tenants are not supported yet), a transactional relay service (user + API key as password), a relay in the home network (`none`, no login);
  - sender address and domain: SPF/DKIM/DMARC are set up at the provider; the sender must be an address the provider lets you send from;
  - the outbox: retries, 72 h expiry, rate limits, 30-day history, what *Admin* and the Systemcheck show and what each error code means;
  - privacy: no remote images, no tracking, what the outbox stores.
- [ ] **Step 2: CHANGELOG bullet** under `[Unreleased]`: "**E-Mail: SMTP settings and a branded test mail.** …" naming the card, *Testen*, *Testmail senden*, the Systemcheck line, encrypted password, retries, and `docs/mail.md`.
- [ ] **Step 3:** `cd web && npx vitest run --coverage` once; statements ≥ 94 %. If not, add unit tests for `mail.ts`.
- [ ] **Step 4: Commit** `docs(mail): SMTP setup guide, security notes and changelog`.

Stage B (the `notify()` mail channel, person mails, preferences, unsubscribe, the invitation mail) and stage C (digest, admin alerts, Authentik) each get their own plan after this stage merges.
