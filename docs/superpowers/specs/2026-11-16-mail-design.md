# E-mail sent by FriendFlix

Status: requested by the owner on 2026-11-15 (LetsManu/friendflix#321), "start with mail"; the owner opted out of further
questions. Everything the owner did not decide is marked **Controller's call** with its reason.

## Why

FriendFlix itself sends no e-mail today:

- Authentik sends the password-reset mail (`authentik.ts` `akSendRecovery`: `POST /core/users/<pk>/recovery_email/` through the first
  e-mail stage of `AUTHENTIK_RECOVERY_FLOW`) and, where an enrollment flow has an e-mail stage, the address confirmation. Both use
  Authentik's own templates and SMTP settings.
- Invitations are links the admin copies (`invites.ts` `createInvite` → `/invite/<token>`, which leads into the Authentik enrollment
  flow). Nobody gets an invitation by mail.
- Notifications go out as the in-app inbox, Web Push, the global ntfy topic / Discord and the personal ntfy topic (`notify.ts`).
- The weekly digest (`digest.ts`) is an in-app notice plus the personal ntfy topic.

People who do not keep the app open, have no ntfy and have not allowed push hear nothing: not that their wish arrived, not that a
recording failed, not that a download is about to expire. Admins hear about a failed update or a full disk only when they look.
The owner's long-term direction is a FriendFlix that runs on its own and can change everything itself; only the request service
stays a separate product. Mail goes out through the owner's SMTP provider: FriendFlix is an SMTP client, never a mail server.

## Goals

1. **Transport.** Admin → Einstellungen gets an *E-Mail* card: SMTP host, port, TLS mode, user, password (encrypted at rest like
   every other secret, write-only, never logged) and the sender address. The sender's display name comes from Branding. A *Testen*
   button checks connect + TLS + login without sending; *Testmail senden* sends a real mail to the admin's own address.
2. **Systemcheck.** One line *E-Mail-Versand*: not set up / reachable / TLS ok / login ok, and the last delivery failure. Codes only.
3. **Queue.** Every mail goes through a durable outbox in Postgres with retries and backoff; a restart loses nothing.
4. **Look.** One branded HTML layout plus a plain-text alternative: the app symbol (inline) or the letter tile, the accent with the
   contrast-adjusted fill, name and byline, and a footer with the website and (once Branding stage B ships them) Impressum,
   Datenschutz and Hilfe. All 7 languages, in the recipient's language. No remote images.
5. **Which mails** (stages B and C): an invitation sent by FriendFlix; welcome after the first sign-in; "a wish you asked for is
   available"; a recording finished or failed; a download licence expiring; the weekly digest (opt-in); to admins: update available,
   update failed, Systemcheck problem, disk or recordings storage almost full.
6. **Per-person preferences** (stage B): each mail type on or off on the account page; a one-click unsubscribe link in every
   mail (a signed token, no sign-in), with `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
7. **Authentik's own mails** (stage C): documented branding of Authentik's reset and confirmation mails, plus syncing the brand
   into Authentik where its API allows it.
8. **Safety:** rate limits per recipient; no secret, token or full address in any log; a failure is visible in Admin (last error code).
9. **Docs:** `docs/mail.md` (SMTP setup with common providers), security notes, CHANGELOG.

## Non-goals

- Running a mail server, receiving mail, or reading bounce mail. FriendFlix has no inbox: a bounce that arrives later as a message
  (an asynchronous DSN) lands in the sender mailbox of the admin's provider. FriendFlix sees what the SMTP server says during the
  conversation (a refused recipient is a 5xx at `RCPT TO`), and that is what Admin shows.
- OAuth2 SMTP login (XOAUTH2). Stage A logs in with user and password (an app password where the provider requires one). See the
  owner question below.
- DKIM signing, SPF or DMARC setup: the provider signs; `docs/mail.md` says what to check there.
- Marketing mail, newsletters, mail to people without an account (except an invitation an admin sends on purpose).
- Replacing Authentik's password-reset mail. The reset belongs to the credential owner (Authentik).
- An HTML editor for templates. Texts are the built-in catalogue in 7 languages.

## Anti-goals

- **Tracking.** No remote image, no per-recipient URL that reveals an open, no click redirect. Links go straight to the page.
- **A credential in a log or a response.** The SMTP password, the transport's debug output (which carries the `AUTH` exchange),
  unsubscribe tokens and invite tokens never reach a log, an audit row, an error text or the API.
- **A mail the person cannot stop.** Every non-essential mail has a working one-click unsubscribe.
- **A queue that loses or doubles mail.** A crash between "sent" and "marked sent" may resend one mail at most once; a restart never
  drops a queued one.
- **An open relay.** No route sends to an address a client chooses, except the admin's own invitation flow (stage B), which is
  rate-limited and audited.

## Constraints

- Settings live in the settings registry (`settings/registry.ts`, values from `config.ts`), are stored by `settings/repo.ts` (secrets
  AES-256-GCM with `APP_ENC_KEY`, `crypto.encrypt`), apply live, and are locked when set in the environment. Saving a secret or a
  destination a saved secret goes to needs a sign-in at most 10 minutes old (`routes/adminSettings.ts` `needsReauth`,
  `CREDENTIAL_DESTINATIONS`).
- Probes and Systemcheck lines carry codes only (`settings/probeKit.ts`, `syscheck/line.ts` `safeParams`).
- Backend texts live in `backend/src/messages.ts` (German source, every language every key, `backend/test/i18n-messages.test.ts`);
  the recipient's language comes from `userLanguage` (owner profile → instance default → German).
- Brand: `brand/repo.ts` `readBrand` (name, byline, website, accent, symbol hash), `brand/colors.ts` `deriveTokens`
  (`accFill` is white-text-safe ≥ 4.5:1), `brand/repo.ts` `readImage` (PNG or WebP bytes). Branding stage B (sender name,
  Impressum, Datenschutz, Hilfe, the "Teilen & E-Mails" tab) is **not shipped yet**; mail must work without it and pick it up later.
- Background jobs run where `BACKGROUND_JOBS=true` and `isOperational`; several backend instances may run, so any claim must be
  safe across processes. Postgres is the durable store; Redis (kv) is persistent since 3.5.0 but stays the place for counters and
  caches only.
- CI runs `npm ci`: a new dependency means `backend/package.json` plus the root `package-lock.json`, both committed.
- Repo rules (see the plan's Global Constraints): 7 locales with identical key order, fictional names and placeholder hosts only,
  no "Netflix"/"Seerr" in text, web coverage ≥ 94 %, glass and motion rules for the UI.

## Approaches considered

### SMTP client

- **A. nodemailer (chosen).** The standard Node SMTP client for over a decade, MIT-0, **zero runtime dependencies**, ships its own
  TypeScript types and an ESM build (10.x), handles STARTTLS/implicit TLS, `AUTH PLAIN/LOGIN`, pooling, MIME multipart with inline
  CID attachments, RFC 2047 header encoding, `verify()` (connect + TLS + login without sending) and later OAuth2 and DKIM if ever
  wanted. Actively maintained (several releases a month in 2026).
- B. Own client on `node:tls`/`node:net`. Small for the happy path, but MIME, encoded-word headers, dot-stuffing, STARTTLS upgrade,
  multi-line replies, pipelining quirks and the long tail of provider behaviour are exactly what a mature library has already met.
  The owner values changeability of the product, not avoiding libraries; an own client would be more code to change, not less.
- C. A provider HTTP API (one vendor's REST API). Ties FriendFlix to a vendor; the owner asked for "the owner's SMTP provider".

**Version (Controller's call):** `nodemailer@10.3.1` (released 2026-10-29) as a dependency of `backend`, and `smtp-server@3.21.3`
(2026-10-29, same author, depends on exactly `nodemailer 10.3.1`, so the lockfile holds one copy) as a dev dependency for tests.
Reason: both are past the repo's 7-day Dependabot cooldown and pair cleanly; Dependabot moves them later.

### Send queue

- **A. A Postgres table `mail_outbox` (chosen).** Transactional with the event that causes the mail, survives restarts and Redis
  loss, claim with `for update skip locked` plus a lease (as the recordings tick does), inspectable for the Admin status, counts for
  rate limits come from the same rows.
- B. kv (Redis lists). Persistent now, but a lost volume or a `FLUSHALL` loses mail; no transaction with the event; counting and
  status need extra structures.
- C. Send inline from the event, no queue. A slow or down SMTP server would stall the caller (a webhook, a tick); no retries.

### Templates

- **A. Plain TypeScript functions (chosen).** `layout(input) → { html, text }` and one function per mail type; every interpolated
  value goes through `esc()`; links are built from `PUBLIC_URL` and checked to be http(s). No dependency, type-checked, testable as
  strings. Table-based HTML with inline styles (what mail clients render).
- B. A template engine (Handlebars, MJML). MJML is a heavy dependency with its own toolchain; Handlebars adds a language for little.

### Logo

- **A. Inline CID attachment of the brand symbol (chosen, Controller's call).** The symbol is a 512 × 512 image the browser encoded
  as PNG when it was uploaded; it is attached with `Content-ID: <brand-symbol>` and shown at 48 × 48 CSS pixels. Used only when the
  stored symbol is `image/png` and at most 200 KB; otherwise (no symbol, a WebP, too large) the layout draws the brand's own fallback:
  the name's first letter on `accFill` as an HTML cell, no image at all. Reason: nothing is fetched when the mail is opened, so
  nothing can reveal an open, and most clients show it without "load images"; WebP is not shown by several desktop clients and the
  server has no image library to convert it.
- B. Hosted URL (`/api/public/brand/img/<hash>.png`). Not per-recipient, but every open still fetches from the owner's server
  (an IP and a time per open); blocked by default in many clients.

### Invitation path (stage B)

- **A. FriendFlix's own invitation mail carrying the portal invite link `/invite/<token>` (chosen, Controller's call).** The admin
  types an address in the invite dialog; the mail links to the existing invite page, which already picks the language, shows the
  role and starts the Authentik enrollment (or "Anmelden & freischalten" for an existing account). Authentik's enrollment flow and
  its own e-mail confirmation stage stay as they are. Reason: one entry point that also works without Authentik invitations, and
  copying the link keeps working ("in addition to", not "instead of").
- B. Mail the raw Authentik enrollment URL (`enrollFlowUrl`). Skips the portal page, so no language choice, no role display and no
  path for people who already have an account.
- C. Ask Authentik to send it. Authentik has no "send invitation" endpoint; it would need an e-mail stage in front of enrollment
  and Authentik's look.

## Decisions

### Settings (stage A)

New registry group `mail` (shown on the *Benachrichtigungen* tab after `notifications` and `push`), probe `mail`, all `apply: 'live'`:

| Key | Kind | Default | Rule |
|---|---|---|---|
| `MAIL_SMTP_HOST` | string (host) | unset | `config.ts` `hostSchema` (host name or IP, no scheme, no port) |
| `MAIL_SMTP_PORT` | int | `587` | 1–65535 |
| `MAIL_SMTP_TLS` | enum | `starttls` | `starttls` \| `tls` \| `none` |
| `MAIL_SMTP_USER` | string | unset | |
| `MAIL_SMTP_PASSWORD` | secret | unset | encrypted at rest, write-only, no `last4` hint |
| `MAIL_FROM` | string (address) | unset | an e-mail address (zod `z.email()`), error code `invalid_email` |

- **Configured** means host and sender are set (Controller's call: a relay may need no login).
- **TLS** (Controller's call, reason: never send a password in clear, never silently downgrade): `starttls` sets `requireTLS`
  (a server without STARTTLS fails with `tls` instead of continuing in clear); `tls` is implicit TLS (`secure: true`, port 465);
  `none` is for a relay inside the home network and **refuses user/password** (probe `invalid`/`insecure_auth`, transport refuses
  to log in). Certificates are always verified, TLS ≥ 1.2.
- **Re-authentication:** `MAIL_SMTP_PASSWORD` is a secret (already needs re-auth); `CREDENTIAL_DESTINATIONS` gains
  `MAIL_SMTP_PASSWORD: ['MAIL_SMTP_HOST', 'MAIL_SMTP_PORT', 'MAIL_SMTP_TLS']`, so pointing the saved password at another host,
  port or TLS mode needs a fresh sign-in too.
- **Sender display name:** Branding's sender name once stage B of Branding adds it; until then the brand `name` (Controller's call:
  the owner said "taken from Branding"; the byline goes into the footer, not the `From` header, which clients truncate).
- **EHLO name:** the host of `PUBLIC_URL` (Controller's call: the container's host name is a random id that some servers refuse).
- **Recipient address:** `users.email` from the sign-in (Controller's call: it is the address the person confirmed in Authentik, and
  changing it already goes through the account page's e-mail change flow; no second address to verify).

### Transport (stage A)

- One module builds nodemailer options from the config; `logger: false` and `debug: false` always (nodemailer's debug output
  contains the base64 `AUTH` exchange). Timeouts: connect 10 s, greeting 10 s, socket 30 s (probe: 5 s each, inside the probe
  runner's deadline).
- One pooled connection per worker tick (`maxConnections: 1`, `maxMessages: 50`), closed when the tick ends; no idle connection is
  kept (Controller's call: providers dislike idle sessions, ticks are minutes apart).
- **Error classes** (codes only, the SMTP reply text is never stored): `unreachable`, `timeout`, `tls`, `auth` (transport class:
  nothing is wrong with the message) and `sender_refused`, `recipient_refused`, `message_refused` (message class), plus the
  3-digit SMTP status when there is one. A 5xx in the message class is permanent; a 4xx is retried.
- Headers on every mail: `From` (display name + `MAIL_FROM`), `To`, `Subject`, `Date`, `Message-ID` (nodemailer, sender domain),
  `Auto-Submitted: auto-generated` (RFC 3834; Controller's call: stops vacation replies), `Content-Language`. Stage B adds
  `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).

### Outbox (stage A)

Migration 57 (the next free number when the builder starts; Branding stage B may take 57 first, then use 58):

```sql
create table if not exists mail_outbox (
  id uuid primary key,
  kind text not null check (kind ~ '^[a-z][a-z_]{0,39}$'),
  user_id uuid references users(id) on delete cascade,
  rcpt_enc text,              -- crypto.encrypt(APP_ENC_KEY, address); null once final
  rcpt_mask text not null,    -- 'a…@friend.example.com'
  rcpt_key text not null,     -- HMAC-SHA256(mail subkey, lower(address)), hex: rate limits, later the suppression list
  params_enc text,            -- crypto.encrypt of the JSON params; null once final
  lang text not null check (lang in ('de','en','fr','es','it','tr','pl')),
  state text not null default 'queued' check (state in ('queued','sending','sent','failed')),
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  lease_until timestamptz,
  last_code text check (last_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  last_smtp int check (last_smtp between 200 and 599),
  dedupe text unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  finished_at timestamptz
);
create index if not exists mail_outbox_due on mail_outbox(next_at) where state in ('queued','sending');
create index if not exists mail_outbox_rcpt on mail_outbox(rcpt_key, sent_at) where state = 'sent';
```

- **Data in the row** (Controller's call, reason: an invite or unsubscribe link carries a token, and a queued mail must not be a
  readable copy of it): the address and the template params are encrypted while queued and set to null when the row is final; what
  stays is kind, masked address, state, codes and times. Rendering happens at send time from kind + params + the brand as it is then.
- **Language** is fixed at enqueue time (like `notify()` renders at creation).
- **Claim:** `update … set state='sending', lease_until=now()+2 min, attempts=attempts+1 where id in (select … where (state='queued'
  and next_at<=now()) or (state='sending' and lease_until<now()) order by next_at limit 20 for update skip locked) returning *`.
- **Backoff** after a message-class 4xx or an unknown error: 1 min, 5 min, 30 min, 2 h, 6 h; the 6th failed attempt is final
  (Controller's call: about 9 hours of trying covers a provider outage overnight without mailing about yesterday days later).
- **Transport-class errors** do not use up the messages' attempts: the tick gives its claimed rows back (attempts − 1, state
  `queued`, `next_at` = now + the same backoff by consecutive transport failures, counted in kv `mail:transport:fails`, TTL 1 day)
  and stops (Controller's call: a wrong password must not burn every mail's retries).
- **Expiry:** a mail still queued 72 h after it was created fails with `expired` (Controller's call: a digest or a "recording failed"
  is worthless days later).
- **Retention:** final rows are deleted 30 days after `finished_at` (Controller's call: long enough for "what happened last week").
- **Dedupe:** an optional unique key, like `notifications.dedupe`, so a retried event never queues a mail twice.
- **Worker:** `mailTick` every 30 s where `BACKGROUND_JOBS=true` and `isOperational` (server.ts pattern with a busy flag), plus
  `deliverNow(id)` that runs the same claim/send path for one row (used by the test mail so the admin gets an answer).

### Rate limits (stage A; Controller's call)

Counted from the outbox's `sent` rows (durable, shared by all instances, no extra store):

- per recipient (`rcpt_key`): 10 per hour and 50 per day;
- whole instance: 200 per hour (below the common free-tier provider limits).

A mail over a limit is not dropped: its `next_at` moves to when the window frees up, without an attempt counted. *Testmail senden*:
3 per 10 minutes per admin (kv `mail:test:<userId>`) → 429 `rate_limited`, plus the route's own `rateLimit` of 10 per minute.

### Templates and layout (stage A)

- `layout()` takes the brand (name, byline, website, `accFill`, symbol or letter), the heading, paragraphs, an optional button
  (label + URL), an optional reason line ("Du bekommst diese E-Mail, weil …") and footer links; returns HTML and text.
- Light layout (Controller's call, reason: most clients render mail on white and invert dark designs unpredictably): page
  `#f4f4f6`, card `#ffffff`, text `#1a1d21` (≥ 15:1), muted `#5b6370` (≥ 5.9:1 on white), a 4 px accent bar and the button in
  `accFill` with white text (≥ 4.5:1 by construction, `brand/colors.ts`). Width 600 px, single column, system font stack.
- The plain text is written by the same function (not stripped from HTML): heading, paragraphs, `Label: URL`, footer.
- HTML under 100 KB (Gmail clips at 102 KB); asserted in tests.
- Footer: brand name and byline, the website link if set, Impressum / Datenschutz / Hilfe when Branding stage B provides them
  (the layout takes them as optional links; until then they are absent), the reason line, and in stage B the unsubscribe link.
- Texts in `messages.ts` under `mail.*`, 7 languages; subject and body rendered with `msg()` in the stored language.
- Stage A ships exactly one mail type: `test` ("Testmail von {app}"), to the admin's own address.

### Admin surface (stage A)

- `GET /api/admin/mail/status` → `{ configured, queued, failed24h, lastSentAt, lastFailure: { kind, code, smtp, at } | null,
  transport: { code, at } | null }`. No address, no text.
- `POST /api/admin/mail/test` → enqueues `test` to the admin's own address and delivers it at once; answers `{ state: 'sent' }`
  or `{ state: 'queued' | 'failed', code, smtp? }`; 400 `mail_not_configured` / `no_address`, 429 `rate_limited`. Audit
  `mail.test` with `{ state, code }` only. The test goes **only** to the signed-in admin's own address (Controller's call: the
  button can never mail a third party).
- The *E-Mail* card shows a status line under the fields (last sent, the last failure as a sentence for its code, queued count)
  and the *Testmail senden* button with its result.
- **Systemcheck** line `core.mail` (*E-Mail-Versand*, after `core.env`, Controller's call: mail is basic infrastructure and the group
  order is fixed): not set up → `not_set_up`/`mail_not_set`; probe `unreachable`/`timeout` → `problem`/`mail_unreachable`; `tls` →
  `problem`/`mail_tls`; `unauthorized` → `problem`/`mail_auth`; `invalid`/`insecure_auth` → `problem`/`mail_insecure_auth`; probe ok
  but a final failure in the last 24 h → `warning`/`mail_last_failed` (params `code`, `smtp`); a row overdue for more than
  15 min (queued with `next_at` passed, or sending with its lease run out; stage B, Controller's call 13) →
  `warning`/`mail_queue_stuck`; else ok. The probe result is cached in kv for 10 minutes (`mail:probe`), *Jetzt prüfen* probes
  again (Controller's call: a Systemcheck view must not log in to the provider every minute).

### Unsubscribe (stage B)

- **Token** = base64url(`v1.<userId>.<type>.<HMAC-SHA256(k_unsub, "v1|userId|type")>`), with
  `k_unsub = HKDF-SHA256(APP_ENC_KEY, salt "friendflix-mail", info "unsubscribe v1", 32 bytes)` (Controller's call: `APP_ENC_KEY`
  is the only server-only secret; `INTERNAL_SECRET` is shared with the gateway and `WEBHOOK_SECRET` with the media server and the
  request service; HKDF keeps the encryption key and the MAC key apart). Scoped per person and type, no expiry (a link in an old
  mail must still work), compared in constant time. Rotating `APP_ENC_KEY` invalidates old links, which is acceptable.
- `GET /mail/unsubscribe?t=…` (public, no sign-in) shows a confirm page with one button; `POST /api/public/mail/unsubscribe`
  (form or RFC 8058 one-click body `List-Unsubscribe=One-Click`) switches that type off and answers 200. No CSRF token on the POST
  (RFC 8058 requires a plain POST; the token is the authorization), rate-limited per IP. The page never shows the address.
- `List-Unsubscribe: <https://friend.example.com/api/public/mail/unsubscribe?t=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on every mail that has a preference.

### Preferences (stage B)

- Stored in `user_prefs.data.mail` as `{ [type]: boolean }` (account-level like `weeklyDigest`; Controller's call: mail goes to the
  account's address, not per profile).
- Defaults (Controller's call): `available`, `recording`, `licence` on; `digest` **off** (the issue says opt-in); `welcome` and
  `invite` are one-off and have no switch; admin alerts on for admins.
- Account page: a card *E-Mails* with one switch per type and the address the mails go to (from the sign-in, with the existing
  "change e-mail" action).

### Mail as a channel of notify() (stage B)

`Notice` gains `mail?: MailType`; `notify()` enqueues a mail when the recipient has an address, the type is on, and mail is
configured, with the notice's dedupe key. Every event that already calls `notify()` (wish available `routes/seerr.ts`, recording
failed `livetv/recsched.ts`, finished series episode, storage warnings) needs one field, not a second event system. New sources:
welcome (first account creation in `loginFinish.ts`), licence expiring (a daily check of `downloads.expires_at` within 48 h; no
in-app notice exists today), invitation (invite dialog).

### Authentik (stage C)

What Authentik's API allows (to verify on the installed version, the setup targets 2026.8):

- An e-mail stage (`/api/v3/stages/email/`) has `subject`, `template` (a file name; `GET /api/v3/stages/email/templates/` lists the
  built-in ones and the files mounted at `/templates`), `from_address`, and its own SMTP settings when `use_global_settings` is false
  (`host`, `port`, `username`, `password`, `use_tls`, `use_ssl`, `timeout`).
- A template's **content** cannot be uploaded through the API; custom templates are files in the Authentik container.
- A brand (`/api/v3/core/brands/`) has `branding_title`, `branding_logo` and `branding_favicon` (paths or URLs).

Stage C: `docs/authentik.md` gets a section with a FriendFlix-styled template file for the recovery and confirmation mails to mount
into `/templates`, and Admin gets an optional *Branding an Authentik übertragen* action (title and logo URL into the brand; sender
address and, if the admin agrees, the SMTP settings into the recovery flow's e-mail stage), behind the token's change permissions.

### Admin alerts and digest (stage C)

- Update available (`updates.ts` `updateAvailable` turning true, once per version), update failed (`updater.ts` job result
  `failed`), Systemcheck problem (a line turning `problem`, once per line per day), disk or recordings storage almost full (the
  existing `livetv.rec.storage` notices and the health snapshot's disk levels). Each admin can switch each off.
- The weekly digest as mail: its own template with titles and posters as text (no images; the personal channel may name titles,
  like the personal ntfy topic), sent from `sendDigest` when the person opted in.

## Stages (one PR each)

- **A — transport and the first mail.** Settings, transport, probe, outbox + worker, rate limits, layout, the `test` mail, Admin
  status + *Testmail senden*, Systemcheck line, `docs/mail.md`, CHANGELOG. Shippable alone: an admin can set up and prove mail.
  Reason for this cut: everything later only adds a template and a trigger; the risky parts (credentials, TLS, queue semantics,
  escaping) are reviewed once, with nothing person-facing depending on them yet.
- **B — mails for people.** The `notify()` mail channel, welcome, wish available, recording finished/failed, licence expiring, the
  invitation mail, preferences on the account page, unsubscribe token and headers, the public unsubscribe page. Needs A.
- **C — digest, admin alerts, Authentik.** The digest mail, the four admin alerts, the Authentik doc and sync action. Needs B's
  preferences and unsubscribe.

Branding stage B (sender name, legal links) can land before or after any of these; the layout reads them when present.

## Left to the builder

- File split inside `backend/src/mail/` beyond the interfaces the plan names; the exact HTML table markup and spacing.
- The wording of the 7 languages' texts (German first, the plan gives the German strings for stage A).
- Which free port the fake SMTP server binds in tests, and the self-signed test certificate's exact subject.

## Questions only the owner can answer

1. Which SMTP provider will you use, and does it allow a user + password (app password) login? Stage A supports password login
   only; Microsoft 365 is retiring basic SMTP AUTH and some Google Workspace setups disallow app passwords, which would need OAuth2.
2. May `docs/mail.md` name the real SMTP host names of common providers? The repo rule says placeholder hosts only, so the draft
   names providers and their port/TLS settings but writes every host as `mail.example.com`.
