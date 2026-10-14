# Block 23 Phase 3 – In-App Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People sign in, recover their password, enrol from an invite and manage their own 2FA in FriendFlix screens, over a cover-wall background. Authentik stays the account store, and its flow executor runs invisibly behind the backend.

**Architecture:**
- The backend acts as the browser towards Authentik's flow executor (`/api/v3/flows/executor/<slug>/`). It keeps a per-attempt cookie jar, encrypted in Redis, and turns every challenge into a small, sanitised FriendFlix step DTO.
- At the end of a login flow it runs a silent OIDC authorize (`prompt=none`) with the jar and reuses the existing callback logic, now extracted into `finishLogin`.
- The web side gets `/login` and `/reset` pages with one Svelte component per step, plus a public, cached cover-wall endpoint fed through the media seam.

**Tech Stack:** Fastify + zod + Redis (kv) + Postgres (backend), openid-client (existing), SvelteKit (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-block23-user-management-design.md`. This plan covers:
- Part C, including the owner decision under "Screens" (cover wall and copy)
- the A5 approval queue, invites and lock/expiry as they apply at login
- the Part B "Security" bullet (per the controller's scope ruling)

Phase 2 items (data export, deletion grace, the account page itself) are out of scope.

**Split (proposed):** 12 tasks. Execute as two PRs:
- **3a (Tasks 1–9):** in-app login, recovery, enrolment, cover wall, status checks, docs.
- **3b (Tasks 10–12):** in-app re-authentication and account security.

3b depends on 3a and on phase 2's `requireRecentAuth` (see Task 10).

## Global Constraints

- Passwords, codes and tokens are never logged or stored. `/auth/flow/*` request bodies are excluded from error logs.
- Authentik URLs and tokens are never sent to the client.
- `LOGIN_UI=app|authentik`. The fallback `/auth/login?classic=1` is always reachable.
- Unknown stage → "Continue on the sign-in page".
- Rate limits per IP and per username. `X-Forwarded-For` forwarding is documented.
- CSRF uses double-submit, and flow step ids are single-use.
- 7 locales.
- The word "Seerr" never appears in user-facing text.
- No trademark look-alikes.
- README screenshots use fictional titles and generated art only.
- The media server is reached only through the seam (`ctx.jf`). The Plex fork must keep compiling, so the seam methods are optional.

Carried over from phase 1:
- Migrations are appended to `MIGRATIONS` in `backend/src/db.ts` only. This phase needs none: settings live in `app_settings`, flow state in kv.
- Authentik calls go only through `backend/src/authentik.ts` (admin API) and the new `backend/src/akflow.ts` (flow executor).
- No new dependencies. QR codes use `web/src/lib/qr.ts`.
- Backend tests live in `backend/test/*.test.ts` with `makeEnv`/`resetDb`. e2e tests live in `e2e/tests/login*.spec.ts` (+ `.mobile.spec.ts`), with mocks in `e2e/mocks/login.ts`.
- Coverage thresholds hold. Lint, typecheck and `spdx:check` are clean.
- New web strings go in a new area `login` (`web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/login.ts`, registered in each `index.ts`). German is the source, with the copy from the spec's owner decision. New backend strings (status checks) go in the backend i18n for all 7 languages.

## Authentik Findings (researched 2026-10-14 against `goauthentik/authentik@main`)

**Executor**
- Source: [flows/views/executor.py](https://github.com/goauthentik/authentik/blob/main/authentik/flows/views/executor.py).
- `GET /api/v3/flows/executor/<slug>/?query=<urlencoded querystring>` returns the current challenge. `POST` to the same URL with a JSON body answers it. The view is `AllowAny`.
- The plan lives in the Django session, under the cookie `authentik_session` (`root/settings.py`).
- After a valid answer, `stage_ok` redirects to the executor URL itself. `to_stage_response` returns that as a real **302 to the same path**, not as a challenge. The client must follow it with a `GET` that carries the jar (`redirect: 'manual'`).
- Other redirects become `{component: 'xak-flow-redirect', to, final_redirect}`. `final_redirect: true` marks the end of the flow.

**Challenge shapes** ([flows/challenge.py](https://github.com/goauthentik/authentik/blob/main/authentik/flows/challenge.py))
- Every challenge has `component`, an optional `flow_info {title, background, cancel_url, layout, messages}` and an optional `response_errors {field: [{string, code}]}`.
- `WithUserInfoChallenge` adds `pending_user` and `pending_user_avatar` (a URL, which is dropped).
- Other components: `ak-stage-access-denied {error_message}`, `xak-flow-shell {body}` (HTML) and `ak-stage-flow-error`.

**Stage by stage**

| Component | Challenge fields | Answer | Source |
|---|---|---|---|
| `ak-stage-identification` | `user_fields`, `password_fields` (password inline), `enroll_url?`, `recovery_url?`, `passwordless_url?`, `captcha_stage?`, `passkey_challenge?`, `primary_action`, `allow_show_password` | `{uid_field, password?, captcha_token?, passkey?}` | [identification/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/identification/stage.py) |
| `ak-stage-password` | `recovery_url?`, `allow_show_password` | `{password}` | [password/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/password/stage.py) |
| `ak-stage-authenticator-validate` | `device_challenges[{device_class: totp\|static\|webauthn\|duo\|sms\|email, device_uid, challenge, last_used}]`, `configuration_stages[{pk, name, verbose_name, meta_model_name}]` | `{code?, webauthn?, selected_challenge?, selected_stage?}` | [validate/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_validate/stage.py), [challenge.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_validate/challenge.py) |
| `ak-stage-authenticator-totp` | `config_url` (an `otpauth://` URI) | `{code}` | [totp/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_totp/stage.py) |
| `ak-stage-authenticator-static` | `codes[]` | `{}` (confirms) | [static/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_static/stage.py) |
| `ak-stage-email` | no fields (`title` "Email sent.") | Any POST is "invalid" by design and **re-sends** the mail. Rate limited per address (`recovery_max_attempts`). | [email/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/email/stage.py) |
| `ak-stage-prompt` | `fields[{field_key, label, type, required, placeholder, initial_value, order, sub_text, choices}]` | `{<field_key>: value}` | [prompt/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/prompt/stage.py) |

Notes on the table:
- **Identification:** for an unknown user (when "pretend" is off), validation fails with "Failed to authenticate.".
- **Codes:** a TOTP code and a recovery (static) code are both checked from the same `code` field (`validate_challenge_code` tries every TOTP and static device).
- **Recovery link:** the e-mail's template context is `url`, `user`, `expires` and **`token`** (the FlowToken key). A link that returns to the flow is `GET /api/v3/flows/executor/<recovery-slug>/?query=flow_token%3D<token>`, which restores the pickled plan (`QS_KEY_TOKEN = "flow_token"`).
- **Custom templates** live in the `custom-templates` directory, mounted at `/templates` ([email stage docs](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/email/)). The default recovery blueprint binds identification (10), e-mail (20), the password prompt (30), user write (40) and user login (100) ([flows-recovery-email-verification.yaml](https://github.com/goauthentik/authentik/blob/main/blueprints/example/flows-recovery-email-verification.yaml)).
- **Invitation token:** it travels as `itoken` in `query` ([invitation/stage.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/invitation/stage.py)).

**Silent OIDC authorize** ([providers/oauth2/views/authorize.py](https://github.com/goauthentik/authentik/blob/main/authentik/providers/oauth2/views/authorize.py), [flows/planner.py](https://github.com/goauthentik/authentik/blob/main/authentik/flows/planner.py) `to_redirect`)
- With a logged-in session, the authorize endpoint plans the provider's authorization flow and appends `OAuthFulfillmentStage`.
- If no other stage is left (implicit consent), it answers **302 directly to `redirect_uri?code=…&state=…`**.
- Otherwise it redirects to `/if/flow/<authorization-flow>/`.
- `prompt=none` without a session gives `login_required`. `prompt=none` with a consent stage gives `consent_required`.

**WebAuthn** ([authenticator_webauthn/utils.py](https://github.com/goauthentik/authentik/blob/main/authentik/stages/authenticator_webauthn/utils.py))
- `get_rp_id(request)` is Authentik's own request host, and the expected origin is Authentik's own origin. The RP ID is **not configurable** on the stage.
- So a WebAuthn ceremony run in the FriendFlix origin fails Authentik's origin check whatever the RP ID is (see Rulings).

**CSRF**
- Settings: cookie `authentik_csrf`, header `X-authentik-CSRF`. The DRF authentication classes are `TokenAuthentication` and `SessionAuthentication`.
- DRF enforces CSRF only for session-authenticated users. So anonymous login, recovery and enrolment need no CSRF.
- Flows run as a logged-in user (setup flows, Task 10) must send `X-authentik-CSRF` equal to the jar's `authentik_csrf` cookie. Because Django checks the Referer for HTTPS requests that have no Origin header, they must also send `Origin: <Authentik origin>` and `Referer: <executor URL>`.

**Client IP:** Authentik trusts `X-Forwarded-For` only from `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS`. The docs describe adding the FriendFlix backend there.

**Admin device API** (used for "remove"): `authenticators/admin/{totp,static,webauthn}/` exist (from the `urls.py` of each stage). `providers/oauth2/` filters by `client_id`.

**Unverified** (check on a real Authentik before relying on them; the tests use recorded fixtures):
- U1: the CSRF header, Origin and Referer requirement for session-authenticated executor POSTs.
- U2: `DELETE` on the `authenticators/admin/<type>/<pk>/` viewsets with the API token.
- U3: ending the jar's Authentik session with `GET /api/v3/flows/executor/<invalidation-slug>/` (`default-invalidation-flow`, whose user-logout stage runs on GET).
- U4: whether running `default-authenticator-static-setup` again adds a second static device (Task 10 deletes the old one first).
- U5: the Jellyfin `OfficialRatings=` (pipe-delimited) filter on `/Items` for the cover wall.
- U6: that `xak-flow-redirect` with `final_redirect: true` arrives on 2026.8.x. The field is new on main. Older releases end with a plain `xak-flow-redirect` to `/`, so the client also treats a redirect to `/` or `/if/user/` as the end.

## Rulings Against the Spec

1. **Passkeys in-app are not built.** Authentik verifies a WebAuthn assertion against its own origin (see Findings), so the spec's "RP ID is a parent domain" condition is not enough. Instead:
   - "Mit Passkey anmelden", "Passkey verwenden" and "Add a passkey" go to the classic sign-in page (`/auth/login?classic=1`, or for setup `/auth/flow/classic/webauthn-setup`, which 302s to Authentik).
   - Removing a passkey stays in-app, through the admin device API.
   - Re-authentication with a passkey uses phase 2's OIDC redirect (`prompt=login`).
   - The status check reports `passkeys: 'sign-in page'` and docs/authentik.md explains why.
2. **`ak-stage-authenticator-totp` passes the `otpauth://` URI to the client.** It is the user's own new secret, not an Authentik URL or API token, and the QR code is drawn from it. It is never logged, and it is dropped from kv once the step completes. The recovery codes from `ak-stage-authenticator-static` are shown once on the same terms.
3. **Recovery does not sign in.** The default recovery flow ends in `user_login` without MFA. FriendFlix ends the jar's Authentik session, deletes the jar and shows "Password changed – sign in". Otherwise a mail account alone would bypass 2FA.
4. **`?resetPin=1` stays on the classic redirect.** It needs IdP `auth_time` (`max_age=0`), which the flow does not give. `/auth/login?invite=` and `/auth/enroll` lead to `/login?invite=` in app mode.
5. **E-mail-sent screen:** the mockup's "E-Mail-App öffnen" button is dropped, because there is no reliable cross-platform target. The address is the identifier the person typed, masked (`a•••@example.com`), and is omitted when it was a username. The link lifetime is not shown, because Authentik does not report it.
6. **Cover-wall safe set:**
   - Libraries: the `guest` role template's `libraries` (`effectiveRole(ctx,'guest')`).
   - Ratings: `OfficialRating ∈ LOGIN_ART_RATINGS = ['G','PG','TV-Y','TV-Y7','TV-G','TV-PG','U','FSK-0','FSK-6','FSK-12','DE-0','DE-6','DE-12','0','6','12']`. Unrated items are excluded.
   - Types: Movie and Series only, with a primary image.
   - This is documented in docs/security.md.
7. **Access-until reached but not yet locked by the tick:** `finishLogin` locks it right away (`lockUser(...,'expired')`) and refuses the login. This applies to both login paths.
8. **Re-auth stamp** (controller ruling): the session field is `reauthAt` (epoch ms; phase 2 calls it `reauth_at`, and the merge must use one name). The guard is `requireRecentAuth(ctx, 10 * 60_000)`.
9. **Brute force:** one per-username limit for every flow kind, counted on failed answers only.

## Review Focus

1. A person whose `access_until` passed minutes ago (the tick has not run yet) signs in in-app: refused as locked, the account is now locked, and there is no session. (Test in Task 4.)
2. The same flow step is submitted twice (double click, or a replay of a captured request): the second gets `409 step_used`, and Authentik sees exactly one POST. (Test in Task 3.)
3. A custom Authentik flow with a captcha or an SMS/Duo stage: the screen says "Continue on the sign-in page", and the link works without losing the invite. (Test in Task 2, and e2e in Task 7.)
4. The flow sits idle for more than 10 minutes and is then answered: "Session expired, start again". No Authentik call is made with a stale jar. (Test in Task 3.)
5. Authentik is down while the login page loads: the cover wall still renders, and the card shows "Sign-in service unavailable" with retry and the classic link. (Test in Task 3, and e2e in Task 7.)

---

## Part 3a – In-app login (PR 1)

### Task 1: Config and flow executor client

**Files:**
- Modify: `backend/src/config.ts`
- Create: `backend/src/akflow.ts`
- Test: `backend/test/akflow.test.ts`
- Create: `backend/test/fixtures/akflow/*.json` (recorded challenge shapes per the Findings table)
- Create: `backend/test/akflow-fake.ts` (a fake Authentik: `Response`s with `set-cookie`, 302 to self, a stateful stage list)

**Interfaces (produces):**
- Config, all `opt`:
  - `LOGIN_UI` (`z.enum(['app','authentik']).optional()`)
  - `AUTHENTIK_LOGIN_FLOW` (default `default-authentication-flow`)
  - `AUTHENTIK_TOTP_SETUP_FLOW` (exists; default `default-authenticator-totp-setup`)
  - `AUTHENTIK_STATIC_SETUP_FLOW` (default `default-authenticator-static-setup`)
  - `AUTHENTIK_WEBAUTHN_SETUP_FLOW` (default `default-authenticator-webauthn-setup`)
  - `AUTHENTIK_PASSWORD_CHANGE_FLOW` (default `default-password-change`)
  - `AUTHENTIK_INVALIDATION_FLOW` (default `default-invalidation-flow`)
  - `AUTHENTIK_RECOVERY_FLOW` and `AUTHENTIK_ENROLL_FLOW` already exist
  - `loginUi(cfg): 'app' | 'authentik'`: `cfg.LOGIN_UI ?? (AUTHENTIK_URL && AUTHENTIK_API_TOKEN ? 'app' : 'authentik')`
  - `flowSlug(cfg, kind: FlowKind): string | undefined`
- `type FlowKind = 'login' | 'recovery' | 'enroll' | 'reauth' | 'setup-totp' | 'setup-static' | 'change-password'`
- `interface Jar { cookies: Record<string, string>; slug: string; query: string; kind: FlowKind; createdAt: number; step: string; identifier?: string; invite?: string; userId?: string; then?: FlowKind }`
- `saveJar(ctx, flowId, jar): Promise<void>`: `encrypt(ctx.encKey, JSON)` under kv `akflow:<sha256(flowId)>`, TTL 600. The TTL is **not** extended (a 10-minute absolute limit from `createdAt`).
- `loadJar(ctx, flowId): Promise<Jar | null>` and `dropJar(ctx, flowId)`.
- `akExec(ctx, jar, method: 'GET' | 'POST', body?: object, clientIp?: string): Promise<{ challenge: RawChallenge; jar: Jar }>`:
  - URL: `<AUTHENTIK_URL>/api/v3/flows/executor/<slug>/?query=<encodeURIComponent(jar.query)>`.
  - Headers: `accept: application/json`, `x-forwarded-for: clientIp`, and `cookie` from the jar. Add `x-authentik-csrf`, `origin` and `referer` when the jar has `authentik_csrf` (U1).
  - `redirect: 'manual'`, with a 302 to the same path followed by a GET (at most 5 hops). `getSetCookie()` merges into the jar; `Max-Age=0` or an expired `Expires` deletes the cookie.
  - Timeout 8 s. A network error gives `HttpError(503,'authentik_unavailable')`. A non-JSON or 5xx answer gives `HttpError(502,'authentik_error')`. No response body or URL is ever put into an error.
- `akGet(ctx, jar, absoluteOrRelativeUrl): Promise<Response>`: one jar-carrying GET with `redirect: 'manual'`, used for authorize and invalidation.

- [ ] **Step 1: Write the failing tests** (`akflow.test.ts`):
  - `exec GET sends the query double-encoded and stores set-cookie in the jar`: `calls[0].search === '?query=next%3D%252F'` for `jar.query='next=%2F'`, and `jar.cookies.authentik_session === 's1'`.
  - `POST follows the 302 to self with a GET carrying the new cookie`: two calls, `POST` then `GET`, and the returned `challenge.component === 'ak-stage-password'`.
  - `jar round-trips encrypted and the kv value contains no cookie value`: `!(await kv.get(key)).includes('s1')`.
  - `jar older than 600 s is null` (fake clock via `createdAt`).
  - `network error -> 503 authentik_unavailable, message has no URL`.
  - `x-forwarded-for carries the client ip`.
  - `csrf header is sent only when the jar has authentik_csrf`.
- [ ] **Step 2: Run `npm test -w backend -- akflow` and confirm it fails.**
- [ ] **Step 3: Implement the config keys and `akflow.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm run typecheck -w backend`.
- [ ] **Step 5: Commit** `feat(auth): Authentik flow executor client with encrypted cookie jar`.

### Task 2: Challenge sanitiser (step DTOs)

**Files:**
- Create: `backend/src/flowSteps.ts`
- Test: `backend/test/flow-steps.test.ts`

**Interfaces (produces):**
```ts
type FlowError = 'invalid' | 'code_invalid' | 'password_mismatch' | 'required' | 'rate_limited';
type FlowStep =
  | { stage: 'identify'; step: string; passwordInline: boolean; canRecover: boolean; canEnroll: boolean }
  | { stage: 'password'; step: string; identity: string; canRecover: boolean }
  | { stage: 'mfa'; step: string; totp: boolean; recovery: boolean; passkeyClassic: boolean }
  | { stage: 'email-sent'; step: string; to: string | null }
  | { stage: 'prompt'; step: string; fields: Array<{ key: string; type: 'text' | 'username' | 'email' | 'password'; label: string; required: boolean }> }
  | { stage: 'totp-setup'; step: string; otpauth: string }
  | { stage: 'recovery-codes'; step: string; codes: string[] }
  | { stage: 'denied' }
  | { stage: 'classic'; reason: 'unsupported_stage' | 'external_redirect' | 'consent' }
  | { stage: 'expired' } | { stage: 'unavailable' }
  | { stage: 'locked' }
  | { stage: 'done'; next: string };
toStep(raw: RawChallenge, jar: Jar, step: string): FlowStep | { internal: 'end' } | { internal: 'select-stage'; pk: string }
toAnswer(step: FlowStep['stage'], body: unknown, raw: RawChallenge): object   // zod-validated per stage; throws HttpError(400,'bad_request')
stepErrors(raw: RawChallenge): FlowError[]   // from response_errors codes; unknown → 'invalid'
maskEmail(identifier: string): string | null  // 'anna@example.com' → 'a•••@example.com'; no '@' → null
```

Mapping rules:
- **Identification:** `captcha_stage` set → `classic/unsupported_stage`.
- **Authenticator validate:**
  - `totp` = a device class `totp` is present; `recovery` = `static` is present; `passkeyClassic` = `webauthn` is present.
  - Only `webauthn`, `sms`, `duo` or `email` → classic.
  - Empty `device_challenges` with a TOTP entry in `configuration_stages` (`meta_model_name === 'authentik_stages_authenticator_totp.authenticatortotpstage'`) → `{internal:'select-stage', pk}`. Otherwise classic.
- **Prompt:** only the field types `text`, `username`, `email`, `password` and the hidden types `static`/`separator` (both skipped) are shown; any other type → classic. Labels come through as Authentik text. `password`/`password_repeat` fields get FriendFlix labels by `field_key`.
- **`xak-flow-redirect`:** `final_redirect === true`, or `to` equal to `/`, `/if/user/` or a path starting with `/application/o/authorize` → `{internal:'end'}`. Any other external `to` → `classic/external_redirect`.
- **Other components:**
  - `ak-stage-access-denied` → `denied`
  - `ak-stage-consent` → `classic/consent`
  - `ak-stage-email` → `email-sent` (`to` = `maskEmail(jar.identifier)`)
  - anything else → `classic/unsupported_stage`
- **Answers:**
  - `mfa`: `{ code: /^\d{6}$/ | /^[A-Za-z0-9]{8,32}$/ }` → `{ code }`
  - `identify`: `{ identifier: 1..254, password?: 1..1024 }` → `{ uid_field, password? }`
  - `recovery-codes` and `email-sent` (resend) → `{}`

- [ ] **Step 1: Write the failing tests**, one per fixture:
  - `identification maps without urls`
  - `password keeps the typed identifier as identity, not pending_user_avatar`
  - `validate with totp+static+webauthn → mfa {totp, recovery, passkeyClassic}`
  - `validate with only sms → classic`
  - `captcha → classic`
  - `unknown component → classic unsupported_stage`
  - `final redirect → end`
  - `prompt with a date field → classic`
  - `totp setup passes only otpauth`
  - `response_errors map to codes`
  - `no-leak`: for every fixture, `JSON.stringify(toStep(...))` matches none of `/https?:\/\//`, `authentik`, `flow_token`, `cancel_url`, `avatar` (the `totp-setup` `otpauth://` URI is allowed per Ruling 2)
  - `toAnswer rejects extra keys and over-long values`
- [ ] **Step 2: Run `npm test -w backend -- flow-steps` and confirm it fails.**
- [ ] **Step 3: Implement `flowSteps.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `feat(auth): sanitised flow steps for Authentik challenges`.

### Task 3: Flow routes, CSRF, single-use steps, rate limits, LOGIN_UI switch

**Files:**
- Create: `backend/src/routes/authFlow.ts` (register it in `app.ts` after `authRoutes`)
- Modify: `backend/src/routes/auth.ts` (`GET /auth/login`)
- Test: `backend/test/auth-flow.test.ts`

**Interfaces (produces):**
- **Cookies:**
  - `ff_flow`: httpOnly, `sameSite: 'strict'`, `path: '/auth/flow'`, 600 s, value `randomToken()`.
  - `ff_flow_csrf`: readable (not httpOnly), `sameSite: 'strict'`, `path: '/'`, 600 s.
- **CSRF:** every POST under `/auth/flow/` must send the header `x-ff-flow-csrf` equal to the `ff_flow_csrf` cookie (timing-safe), or it gets `403 csrf`. When the jar has `userId`, the session `x-csrf-token` is checked too.
- **`GET /auth/flow/config`** (no auth) → `{ mode: 'app'|'authentik', recovery: boolean, enroll: boolean }`. `recovery` is true when the recovery slug resolves (cached 10 min). It also sets a fresh `ff_flow_csrf`.
- **`POST /auth/flow/start`** with `{ kind: 'login'|'recovery'|'enroll', invite?: string ≤ 128 }`:
  - Mode `authentik` → `409 classic`.
  - `enroll` needs a valid invite with `authentik_invite` (`410 invite_invalid`) and sets `jar.query = 'itoken=<akInvite>'`. `login` with an invite keeps it in `jar.invite`.
  - The answer is the first `FlowStep`, with a new `step` id (`randomToken(16)`).
- **`POST /auth/flow/answer`** with `{ step: string, stage: FlowStep['stage'], ...answer }`:
  - No jar → `{stage:'expired'}`.
  - `step !== jar.step` → `409 step_used`. The jar's `step` is rotated **before** Authentik is called.
  - `{internal:'select-stage'}` is answered automatically: `{selected_stage: pk}`, then the next challenge.
  - `{internal:'end'}` → Task 4's `completeFlow`.
- **`POST /auth/flow/cancel`**: ends the session and deletes the jar (Task 4's `endAkSession`), and clears the cookies.
- **Rate limits:**
  - per IP: `start` 20/min, `answer` 30/min, `config` 60/min (route `config.rateLimit`)
  - per username: kv `flowfail:<sha256(lower(identifier))>`, incremented when an answer comes back with `response_errors`. At ≥ 10 within 900 s the next answer is refused with `{ errors: ['rate_limited'] }`, without calling Authentik.
- **Body hygiene:**
  - All handlers catch and map errors to codes: `HttpError` → `{error: code}`; anything else → `500 {error:'internal'}`.
  - Errors are logged as `req.log.warn({ route, code })` only. Never `err`, never `req.body`.
  - The `onResponse` error log keys stay route patterns (existing).
- **Authentik errors:** 503 or 502 from `akExec` → `{ stage: 'unavailable' }` with HTTP 200, so the card can show retry plus classic.
- **`GET /auth/login`:** when `loginUi(cfg) === 'app'` and there is no `classic=1` and no `resetPin=1`, redirect to `/login`, plus `?invite=` when one was given. `/auth/enroll?invite=` also goes to `/login?invite=…&enroll=1` in app mode.

- [ ] **Step 1: Write the failing tests** (`auth-flow.test.ts`, using `akflow-fake.ts` with identification → password → end):
  - `config reports app mode when the API is configured, authentik otherwise`
  - `start without csrf header → 403`
  - `start returns identify with a step id and sets ff_flow`
  - `replaying a step id → 409 step_used and Authentik saw one POST` (Review Focus 2)
  - `answer after 601 s → expired, no Authentik call` (Review Focus 4)
  - `ten failed passwords for one identifier → rate_limited without calling Authentik; another identifier still works`
  - `Authentik unreachable → stage unavailable` (Review Focus 5)
  - `a password in the body never appears in captured log lines`: build the app with a pino stream into an array, make the fake throw, and check that no line contains the password
  - `/auth/login redirects to /login in app mode, stays on the IdP with classic=1 and with resetPin=1`
  - `LOGIN_UI=authentik: start → 409 classic`
- [ ] **Step 2: Run `npm test -w backend -- auth-flow` and confirm it fails.**
- [ ] **Step 3: Implement `authFlow.ts` and the `/auth/login` change.**
- [ ] **Step 4: Run the tests and confirm they pass**, along with `fixes-auth.test.ts` and `approval.test.ts`.
- [ ] **Step 5: Commit** `feat(auth): /auth/flow routes with single-use steps, csrf and rate limits`.

### Task 4: Finishing a login – silent authorize, shared finishLogin, ending the Authentik session

**Files:**
- Modify: `backend/src/oidc.ts`
- Create: `backend/src/loginFinish.ts` (moves the post-claims logic out of `/auth/callback`)
- Modify: `backend/src/routes/auth.ts` (the callback uses it) and `backend/src/routes/authFlow.ts`
- Test: `backend/test/login-finish.test.ts`

**Interfaces:**
- `OidcProvider.start(opts?: { forceLogin?: boolean; silent?: boolean })`: `silent` adds `prompt=none`. The `finish(...)` signature is unchanged. Update the test fake in `helpers.ts`.
- `finishLogin(ctx, req, reply, claims: OidcClaims, opts: { invite?: string; resetPin?: boolean }): Promise<LoginOutcome>`, where `type LoginOutcome = { kind: 'session' } | { kind: 'pending' } | { kind: 'locked' } | { kind: 'invite_invalid' }`. It does exactly today's callback work:
  - provisioning, invite claim/release, approval request plus the `ff_pending` cookie, the admin-group promotion, the resetPin part
  - session, device, audit `login` with `{ ip, ui: 'app' | 'classic' }`
  - **plus Ruling 7:** `access_until <= now()` and not disabled → `lockUser(ctx, null, id, 'expired')`, audit `user.expired`, and return `locked`
  - The callback maps the outcome to its current redirects or 403. The flow route maps it to `{stage:'done', next: '/' | '/pending'}` or `{stage:'locked'}`.
- `completeFlow(ctx, req, reply, flowId, jar): Promise<FlowStep>`:
  - For `login` and `enroll`: `ctx.oidc.start({ silent: true })`, then `akGet(authorizeUrl)` with the jar. The 302 `Location` must start with `PUBLIC_URL/auth/callback`, then `ctx.oidc.finish(new URL(location), saved)`, then `finishLogin(..., { invite: jar.invite })`.
  - A `Location` to `/if/flow/…` → `classic/consent`. An `error=` parameter in `Location` → `classic/consent` for `consent_required`, `unavailable` for anything else.
  - For `recovery` (Ruling 3): `{ stage: 'done', next: '/login?reset=1' }`.
  - Always `endAkSession(ctx, jar)` and `dropJar` afterwards, in a `finally`.
- `endAkSession(ctx, jar): Promise<void>`: a best-effort `akGet` of the invalidation flow's executor URL (U3). It never throws.

- [ ] **Step 1: Write the failing tests:**
  - `silent authorize carries the jar cookie and yields a session` (the fake Authentik answers authorize with a 302 to `PUBLIC_URL/auth/callback?code=c&state=<state>`; the fake OIDC returns claims for a known user)
  - `unknown user without invite → pending, ff_pending cookie set, one approval request` (reuses A5)
  - `with invite → account provisioned and the invite use recorded`
  - `disabled user → locked`
  - `access_until in the past → locked, users.disabled=true, locked_reason='expired', audit user.expired, no ff_sid` (Review Focus 1)
  - `authorize redirects to an authorization flow → classic consent`
  - `the invalidation flow is called and the jar is gone after done`
  - `classic /auth/callback still behaves as before` (existing `fixes-auth` and `approval` suites green)
- [ ] **Step 2: Run `npm test -w backend -- login-finish approval fixes-auth` and confirm it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole backend suite and confirm it passes.**
- [ ] **Step 5: Commit** `feat(auth): finish in-app logins with a silent authorize and shared finishLogin`.

### Task 5: Recovery – e-mail link into the app

**Files:**
- Modify: `backend/src/routes/authFlow.ts`
- Create: `deploy/authentik/templates/friendflix-recovery.html` (Django template)
- Test: extend `backend/test/auth-flow.test.ts`

**Interfaces:**
- `POST /auth/flow/start { kind: 'recovery', identifier?: string }`: when `identifier` is given (from the password screen's "Passwort vergessen?"), the backend answers the recovery flow's identification itself and returns the next step, normally `email-sent`.
- A resend is an `answer` with `stage: 'email-sent'`. It POSTs `{}` (Authentik re-sends and applies its own rate limit). FriendFlix also allows one resend per 60 s per jar, or `{errors:['rate_limited']}`.
- `POST /auth/flow/resume { token: string 16..256 }` (from `/reset?token=`): a new jar with `kind: 'recovery'` and `query = 'flow_token=<token>'`. It returns the next step (`prompt` with password ×2). An invalid token, or Authentik answering identification again, → `{stage:'expired'}`. The token is never logged; the route has a rate limit of 10/min/IP.
- Template file: it extends `email/base.html`, links `{{ friendflix_url }}`, and states as its first line the one value the owner replaces: `https://friendflix.example.com/reset?token={{ token }}`. The copy is short, in English, with a `{% trans %}` wrapper.

- [ ] **Step 1: Write the failing tests:**
  - `forgot password with identifier → email-sent with masked address`
  - `resend within 60 s → rate_limited, no Authentik call`
  - `resume with token restores the plan (fake checks query=flow_token%3D…) and returns prompt with two password fields`
  - `password mismatch → errors password_mismatch`
  - `recovery end → done next=/login?reset=1, no session cookie, invalidation called`
  - `bad token → expired`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement the routes and the template.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `feat(auth): in-app password recovery with the e-mail link back into FriendFlix`.

### Task 6: Cover wall backend

**Files:**
- Modify: `backend/src/media/types.ts` (optional `MediaAdmin` methods) and `backend/src/jellyfin/service.ts` or `client.ts` (the Jellyfin implementation)
- Create: `backend/src/loginArt.ts` and `backend/src/routes/publicArt.ts` (registered in `app.ts`)
- Test: `backend/test/login-art.test.ts`

**Interfaces (produces):**
- `MediaAdmin.loginArtIds?(q: { libraries: 'all' | string[]; ratings: readonly string[]; limit: number }): Promise<string[]>`. Jellyfin: `/Items?Recursive=true&IncludeItemTypes=Movie,Series&ImageTypes=Primary&SortBy=Random&OfficialRatings=<a|b>&Limit=<n>` (U5), with `ParentId` per library when the list is not `all` (resolved through `admin.libraries()`). Admin key.
- `MediaAdmin.posterThumb?(id: string, maxWidth: number): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/webp' } | null>`. Jellyfin: `/Items/<id>/Images/Primary?maxWidth=<w>&quality=70&format=Jpg`.
- `LOGIN_ART_RATINGS` (Ruling 6), `LOGIN_ART_COUNT = 36`, `LOGIN_ART_WIDTH = 200`, `LOGIN_ART_TTL = 3600`.
- `getLoginArtSettings(ctx): Promise<{ coverWall: boolean }>` and `setLoginArtSettings(ctx, s)`, stored in `app_settings` key `login_art` (default `{ coverWall: true }`).
- `currentArtSet(ctx): Promise<{ set: string; count: number } | null>`:
  - Returns null when off, when the seam methods are absent or when there are no ids.
  - Building is guarded by `kv.setnx('loginart:building', 1, 60)`.
  - It stores kv `loginart:current` = `{set, count}` and `loginart:<set>:<i>` = base64 bytes plus the type, all with TTL 3600. `set = randomToken(9)`.
  - Failures of single images are skipped.
- **Routes** (no auth, no CSRF, `Cross-Origin-Resource-Policy: same-origin` as today):
  - `GET /api/public/login-art` → `{ images: string[] }`, as `/api/public/login-art/<set>/<i>` paths, with `cache-control: public, max-age=3600`. Rate limit 30/min/IP.
  - `GET /api/public/login-art/:set/:i` → the image bytes, with `cache-control: public, max-age=3600, immutable`; unknown → 404. Rate limit 300/min/IP. `set` matches `^[A-Za-z0-9_-]{12}$` and `i` matches `^\d{1,2}$`.
- `GET|PUT /api/admin/login-settings` with `{ coverWall: boolean }` (admin, audited `settings.login_art`).

- [ ] **Step 1: Write the failing tests:**
  - `login-art lists paths only: no item ids, no media-server host, no tags`: assert the JSON does not contain the fake Jellyfin host or any fake item id
  - `second call within the hour reuses the set (one Jellyfin listing call)`
  - `query carries the guest libraries and the rating allow-list`
  - `coverWall off → images []`
  - `media server without loginArtIds → images []` (seam optional)
  - `image route serves bytes with immutable cache; bad set → 404`
  - `admin toggle is audited`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and `npm run typecheck -w backend` and confirm they pass.**
- [ ] **Step 5: Commit** `feat(login): public cover-wall images from the library through the media seam`.

### Task 7: Web – login page, cover wall, sign-in screens

**Files:**
- Create:
  - `web/src/routes/login/+page.svelte`
  - `web/src/lib/auth/AuthShell.svelte` (logo, wall and card)
  - `web/src/lib/auth/CoverWall.svelte`
  - `web/src/lib/auth/flow.ts` (client and state machine)
  - `web/src/lib/auth/flow.test.ts`
  - `web/src/lib/auth/Identify.svelte`, `Password.svelte`, `Mfa.svelte` (6 boxes plus the recovery-code toggle), `Notice.svelte` (denied / locked / expired / unavailable / classic)
- Modify: `web/src/routes/pending/+page.svelte` (uses `AuthShell`, copy screen 5)
- Locales: `login.ts` × 7 and the `index.ts` registrations
- e2e: `e2e/mocks/login.ts`, `e2e/tests/login.spec.ts`, `e2e/tests/login.mobile.spec.ts`

**Interfaces (produces), in `flow.ts`:**
- `flowConfig(): Promise<{ mode; recovery; enroll }>`
- `startFlow(kind, extra?)`, `answer(step: FlowStep, body)`, `cancelFlow()`: these send `x-ff-flow-csrf` from `document.cookie`.
- The `FlowStep` type mirrors Task 2 (copied, not imported).
- `codeFromBoxes(digits: string[]): string`
- `pasteCode(text: string): string[]`, which keeps only digits, max 6
- `wallColumns(images: string[], cols = 5): string[][]`, which round-robins and repeats each column twice for a seamless loop
- `fallbackArt(seed: number, n: number): Array<{ from: string; to: string; angle: number }>`, built from the app's palette tokens, with no text

**Behaviour:**
- **Mode:** with `mode === 'authentik'`, `/login` sets `location.href = '/auth/login?classic=1'`.
- **Identification:** "Mit Passkey anmelden" → classic. "Noch kein Konto? Einladung einlösen" opens an inline field for the invite link or token and goes to `/invite/<token>` (the existing page).
- **Password:** the identity pill shows the identifier, and "ändern" restarts the flow. Show-password toggle. "Passwort vergessen?" appears only when `recovery`.
- **TOTP:** auto-submit on the 6th digit, and paste fills all boxes. "Stattdessen Wiederherstellungscode nutzen" swaps in one text field. "Passkey verwenden" (only when `passkeyClassic`) → classic.
- **Notices:**
  - Classic: "Auf der Anmeldeseite fortfahren" → `/auth/login?classic=1`, plus `&invite=` when present.
  - Unavailable: retry plus a classic link.
  - Expired: "Sitzung abgelaufen, bitte neu starten".
  - `done` → `location.href = next`.
- **Cover wall:**
  - 5 columns rotated −10°, alternating `up` and `down` keyframes at 44–59 s, with a dimming gradient toward the card (values from the mockup CSS).
  - `@media (prefers-reduced-motion: reduce)` stops the animation.
  - Images use `loading="lazy" decoding="async" alt="" aria-hidden="true"`. The wall is `aria-hidden` and not focusable.
  - No images → `fallbackArt` tiles.
  - Desktop: the card is centred, `max-width: 420px`. Phone: the card is pinned to the bottom with a 16px gutter.
- **Accessibility:**
  - Every input has a `<label>`. Errors go to `aria-live="polite"`, and focus moves to the first field on each step.
  - The 6 boxes are one group with `aria-label` "Bestätigungscode", and each box has `inputmode="numeric" autocomplete="one-time-code"` (the first box) or `off`.
  - `autocomplete` is `username` / `current-password` / `new-password` as appropriate.

- [ ] **Step 1: Write the failing tests.**
  - Unit (`flow.test.ts`):
    - `pasteCode('12 34-56x') → ['1','2','3','4','5','6']`
    - `wallColumns(36 images) gives 5 columns, each doubled`
    - `fallbackArt is deterministic for a seed`
    - `answer sends x-ff-flow-csrf from the cookie`
  - e2e (desktop + mobile, mocks in `login.ts` with a scripted step sequence):
    - `password + TOTP login reaches home`
    - `wrong password shows the error and keeps the identity pill`
    - `paste fills six boxes and submits`
    - `recovery-code toggle`
    - `unknown stage shows "Auf der Anmeldeseite fortfahren" linking /auth/login?classic=1&invite=…` (Review Focus 3)
    - `service unavailable keeps the wall and offers retry` (Review Focus 5)
    - `reduced motion: wall columns have no animation` (`page.emulateMedia({ reducedMotion: 'reduce' })`, computed `animation-name === 'none'`)
    - `wall images are same-origin /api/public paths`
    - a11y: `each step has labelled inputs and a heading`
    - `pending page uses the shell`
- [ ] **Step 2: Run `npm test -w web -- auth` and `npx playwright test login` and confirm they fail.**
- [ ] **Step 3: Implement the components, the page and the 7 locale files.**
- [ ] **Step 4: Run the unit tests, the e2e tests (desktop + mobile) and `npm run typecheck -w web`, and confirm they pass.**
- [ ] **Step 5: Commit** `feat(web): in-app sign-in screens over a cover wall`.

### Task 8: Web – recovery, reset link and enrolment screens

**Files:**
- Create:
  - `web/src/routes/reset/+page.svelte`
  - `web/src/lib/auth/EmailSent.svelte`
  - `web/src/lib/auth/PromptFields.svelte`
  - `web/src/lib/auth/TotpSetup.svelte` (QR from `qrPath(otpauth)`, the secret shown in groups of 4, a 6-box confirmation)
  - `web/src/lib/auth/RecoveryCodes.svelte` (list, copy and download as `.txt`, a "Gespeichert" confirmation)
- Modify: `web/src/routes/login/+page.svelte` (the `?invite=&enroll=1` start, and the `?reset=1` banner) and `web/src/routes/invite/[token]/+page.svelte` (in app mode, "Konto anlegen" → `/login?invite=…&enroll=1`)
- Locales: `login.ts` × 7
- e2e: `e2e/tests/login-recovery.spec.ts` and `login-enroll.spec.ts` (+ mobile)

**Behaviour:**
- **E-mail sent:** "Erneut senden (m:ss)" counts down from 60 s and then enables. "Zurück zur Anmeldung" cancels.
- **`/reset?token=`:**
  - Calls `resume` and then `history.replaceState` to drop the token from the URL.
  - Shows the prompt (two password fields, with a strength hint only from Authentik's errors).
  - Ends on "Passwort geändert" with a button to `/login`.
- **Enrolment:** prompt fields, then `totp-setup` and `recovery-codes` when the flow has them, then `done` → `/` (or `/pending`).
- **Secrets on screen:** `otpauth` and the recovery codes stay in component state only. They are not stored, and they are cleared on destroy.

- [ ] **Step 1: Write the failing tests** (e2e):
  - `forgot password → inbox screen with masked address and countdown`
  - `reset link drops the token from the URL and sets a new password`
  - `mismatched passwords show the error`
  - `invite enrol: prompt → TOTP setup (QR rendered, 6 boxes) → recovery codes → home`
  - mobile: `QR fits and codes wrap`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run e2e (desktop + mobile) and svelte-check, and confirm they pass.**
- [ ] **Step 5: Commit** `feat(web): in-app recovery, reset link and invite enrolment`.

### Task 9: Status checks, admin toggle, docs (3a)

**Files:**
- Create: `backend/src/flowCheck.ts`
- Modify: `backend/src/routes/admin.ts` (`/api/admin/status` gains `login`) and `web/src/routes/admin/status/+page.svelte` (a "Sign-in" card with the checks and the cover toggle)
- Test: `backend/test/flow-check.test.ts`
- Docs:
  - `docs/authentik.md` + `docs/de/authentik.md`: a new section "In-app sign-in", covering the flows and slugs, implicit consent, `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` with the backend's address, the e-mail template mount and its one edited line, the passkey limitation (Ruling 1), `LOGIN_UI` and `?classic=1`
  - `docs/security.md`: flow jar encryption and TTL, the rate limits, the public cover endpoint and its safe set
  - `docs/setup.md`: the new env keys
  - `.env.example`
  - README feature line (EN/DE), with screenshots using generated art only
  - CHANGELOG under Unreleased → Login

**Interfaces:**
- `checkLoginFlows(ctx): Promise<LoginCheck>`, cached 10 min in kv `flowcheck`:
  ```ts
  { mode: 'app' | 'authentik';
    flows: Array<{ kind: FlowKind; slug: string; state: 'ok' | 'missing' | 'unsupported'; stages: string[] }>;
    implicitConsent: boolean | null;
    issuerMatches: boolean;
    passkeys: 'sign-in page' }
  ```
  - Stages come from `GET flows/instances/<slug>/` and `flows/bindings/?target=<pk>` (`stage_obj.component`). Supported components: identification, password, authenticator-validate, authenticator-totp, authenticator-static, email, prompt, user-login, user-write, invitation, deny, and the user-logout stage.
  - `implicitConsent`: `providers/oauth2/?client_id=<OIDC_CLIENT_ID>` → the `authorization_flow` bindings contain no `ak-stage-consent`.
  - `issuerMatches`: the OIDC_ISSUER origin equals the AUTHENTIK_URL origin (the jar's cookies must apply to authorize).
- Status texts in backend i18n, 7 languages. A failing check never changes `mode`; it shows a warning.

- [ ] **Step 1: Write the failing tests:**
  - `missing flow → missing`
  - `flow with a captcha stage → unsupported with stages listed`
  - `explicit-consent authorization flow → implicitConsent false`
  - `issuer on another host → issuerMatches false`
  - `no API → mode authentik and flows []`
  - e2e `admin status shows sign-in card and toggles covers` (extend `admin-health.spec.ts` mocks)
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement the check, the card and the docs.**
- [ ] **Step 4: Run the full checks and confirm they pass:**
  - `npm run lint`
  - `npm run typecheck -w web`
  - `npm run spdx:check`
  - `npm run coverage -w backend`
  - `npm run coverage -w web`
  - `npm run build -w web`
  - the e2e login* and admin-health specs (desktop + mobile)
  - `grep -ri seerr web/src/lib/i18n/locales/*/login.ts` is empty
- [ ] **Step 5: Commit** `docs: Block 23 phase 3a in-app login`.

---

## Part 3b – Account security (PR 2)

### Task 10: In-app re-authentication and security actions (backend)

**Files:**
- Modify: `backend/src/session.ts` (only if phase 2 has not landed: `reauthAt?: number` on `Session`, and `requireRecentAuth(ctx, maxAgeMs)`, which answers `403 reauth_required`), `backend/src/routes/authFlow.ts` and `backend/src/authentik.ts`
- Test: `backend/test/account-security.test.ts`

**Interfaces:**
- **`POST /auth/flow/start { kind: 'reauth', then?: 'setup-totp' | 'setup-static' | 'change-password' }`:**
  - Needs a session (`requireUser`, owner profile).
  - `jar.userId` = the session user. The backend answers identification itself with `akUserBySub(...).username`, so the first step shown is `password`.
  - At the end: a silent authorize, then `finish`. `claims.sub` must equal the session user's `authentik_sub`, or the answer is `{stage:'denied'}` with audit `account.reauth_mismatch`. If it matches, the session gets `reauthAt = Date.now()`.
  - With `then`: the same jar (now logged in to Authentik) starts the setup flow (`flowSlug(cfg, then)`) and returns its first step. Otherwise → `{stage:'done', next:'/me?tab=account&section=security'}`.
  - Authentik's session is ended after the last flow (`endAkSession`).
- **Setup kinds** are only reachable through `reauth → then`; starting them directly → 400. CSRF is double-submit plus the session `x-csrf-token`.
  - `setup-static`: delete the existing static devices first (U4).
  - The `prompt` step of `change-password` maps `password`/`password_repeat`.
- **Account routes** (`requireOwner` + `requireRecentAuth(ctx, 600_000)`):
  - `GET /api/me/security` → `{ mfa: MfaState | null; devices: Array<{ id: string; type: 'totp' | 'static' | 'webauthn'; name: string; lastUsed: string | null }>; passkeySetup: 'sign-in page' }`, via `authenticators/admin/all/?user=<pk>`. Only the GET skips `requireRecentAuth`.
  - `DELETE /api/me/security/devices/:type/:id` → `akDeleteDevice(ctx, sub, type, id)`. It refuses removing the last second factor when the login flow's validate stage makes MFA mandatory (`409 last_factor`). Audited `account.mfa_removed`, and the `akmfa:` cache is dropped.
- `GET /auth/flow/classic/webauthn-setup` (session): 302 to `<AUTHENTIK_URL>/if/flow/<AUTHENTIK_WEBAUTHN_SETUP_FLOW>/`. This is a redirect, not JSON (Ruling 1).
- `akDeleteDevice(ctx, sub, type: 'totp' | 'static' | 'webauthn', id: number): Promise<void>`: checks that the device belongs to the user's pk (from `admin/all`), then `DELETE api/v3/authenticators/admin/<type>/<id>/` (U2). An unknown device → 404 `device_not_found`.
- The phase 2 "manage on the sign-in page" link is replaced by these routes (web, Task 11).

- [ ] **Step 1: Write the failing tests:**
  - `reauth skips identification and asks for the password`
  - `reauth of another Authentik user → denied and audited`
  - `reauth sets reauthAt; DELETE device works within 10 min, 403 reauth_required after 11 min`
  - `reauth then setup-totp returns totp-setup and finishing ends the Authentik session`
  - `setup-static deletes the old static device first`
  - `delete a device of another user → 404`
  - `removing the last factor under mandatory MFA → 409 last_factor`
  - `setup kinds cannot be started directly`
  - `csrf: session token required`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole backend suite and confirm it passes.**
- [ ] **Step 5: Commit** `feat(account): in-app re-authentication and 2FA management through Authentik flows`.

### Task 11: Web – Security section under /me → Account

**Files:**
- Create: `web/src/lib/account/SecurityPanel.svelte` and `web/src/lib/auth/ReauthDialog.svelte` (it reuses `Password.svelte`, `Mfa.svelte`, `TotpSetup.svelte`, `RecoveryCodes.svelte` and `PromptFields.svelte`)
- Modify: `web/src/routes/me/+page.svelte`, mounting it where phase 2 put the Security block (or as a "Sicherheit" section when phase 2 has not landed)
- Locales: `login.ts` × 7
- e2e: `e2e/tests/account-security.spec.ts` (+ mobile)

**Behaviour:**
- **Rows:**
  - Passwort ändern
  - Authenticator-App (add / remove)
  - Passkeys (list and remove in-app; "Auf der Anmeldeseite hinzufügen" → `/auth/flow/classic/webauthn-setup`, in the same tab)
  - Wiederherstellungscodes (regenerate)
- **Re-auth:** any action first calls the API. On `403 reauth_required` it opens `ReauthDialog` (a modal with the flow steps) and then retries once. For setup actions the dialog starts `reauth` with `then` and shows the setup steps inline. "Passkey verwenden" in the dialog → phase 2's redirect re-auth.
- **Removals** use `confirm` and show the device name.

- [ ] **Step 1: Write the failing tests** (e2e):
  - `add authenticator: password → QR → code → listed`
  - `remove asks for re-auth when stale, then removes`
  - `regenerate recovery codes shows new codes once`
  - `change password with mismatch error then success`
  - `passkey add links to the sign-in page`
  - a11y: `dialog has a name and traps focus`
  - mobile: `panel rows stack`
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run e2e (desktop + mobile) and svelte-check, and confirm they pass.**
- [ ] **Step 5: Commit** `feat(web): account security with in-app re-authentication`.

### Task 12: Docs and full checks (3b)

**Files:**
- `docs/authentik.md` + DE: the setup flows (slugs, stage bindings, MFA-mandatory note), the API token permissions for the admin device viewsets (view and delete TOTP, static and WebAuthn devices)
- `docs/security.md`: the 10-minute re-auth window and what it guards
- CHANGELOG (Unreleased → Account)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full check list from Task 9, Step 4, plus the `account-security` e2e.**
- [ ] **Step 3: Commit** `docs: Block 23 phase 3b account security`.
