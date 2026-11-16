<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# E-Mail

FriendFlix can send e-mail through an SMTP server you choose: your mailbox provider, a relay service or a mail server of your own. It sends the admin's test mail, a welcome mail, mails about the things people care about (a wish that is available, their recordings, downloads about to expire; each one can be switched off, see [Which mails people get](#which-mails-people-get)) and invitations an admin sends from the invite dialog. A digest and alerts to admins come in later releases and use the same settings and the same outbox. Nothing here is needed to run FriendFlix; without a server FriendFlix sends no e-mail and the Systemcheck says so as a neutral line.

**What stays with Authentik.** The "Forgot your password?" mail and the confirmation mail of an e-mail change are sent by Authentik with its own mail settings, not by FriendFlix ([authentik.md](authentik.md)). Setting up FriendFlix's mail does not change them.

## Where to set it up

*Admin → Einstellungen → Benachrichtigungen → E-Mail*. A value set in `.env` or as a Docker secret wins and shows locked, like every setting ([setup.md §15](setup.md#15-advanced-configure-by-environment)).

| Setting | Key | Default | Notes |
|---|---|---|---|
| *SMTP-Server* | `MAIL_SMTP_HOST` | empty | Host name or IP address, without a port, e.g. `mail.example.com`. An IPv6 address works (`[2001:db8::1]`). |
| *Port* | `MAIL_SMTP_PORT` | `587` | 1–65535. |
| *Verschlüsselung* | `MAIL_SMTP_TLS` | `starttls` | `starttls`, `tls` or `none` (*Keine*); see [Encryption](#encryption). |
| *Benutzername* | `MAIL_SMTP_USER` | empty | Empty for a relay that needs no login. |
| *Passwort* | `MAIL_SMTP_PASSWORD` | empty | Stored encrypted, never shown again. |
| *Absenderadresse* | `MAIL_FROM` | empty | The address mails are sent from. The name in front of it is the platform name from [Branding](branding.md). |

E-mail counts as set up once the server and the sender address are filled in. *Testen* checks the connection (connect, encryption and login, no mail is sent) and *Testmail senden* sends a real one; see [Checking it](#checking-it).

**Fresh sign-in.** Saving a password needs a sign-in at most 10 minutes old, like every secret under *Admin → Einstellungen*. Changing the server, the port or the encryption needs a fresh sign-in too, saved password or not (they are where a password goes), and so does *Testen* when it would send the saved password to a changed server, port or encryption, so a stored password cannot be sent to a host you did not mean ([security.md](security.md#e-mail)).

## Encryption

| Mode | Port | What happens |
|---|---|---|
| *STARTTLS* (`starttls`) | 587 (sometimes 25) | Connects in the clear and upgrades before anything else. A server that does not offer the upgrade is refused (error "TLS"); FriendFlix never carries on without encryption. |
| *TLS* (`tls`) | 465 | Encrypted from the first byte. |
| *Keine* (`none`) | 25 | No encryption and **no login ever**: FriendFlix does not send a password in the clear, so a user name or password with *Keine* is refused (Systemcheck: *Ohne Verschlüsselung sendet … kein Passwort*). STARTTLS is not used either, even if the server offers it. Only for a relay in your own network. |

With *STARTTLS* and *TLS* the server's certificate is always verified (TLS 1.2 or newer): it must be valid, not expired, and match the host name you entered. There is no switch to skip the check.

A password without a user name is refused as well (the login would go out without the name): enter the user name or empty the password. The Systemcheck says *Ein Passwort ist eingetragen, aber kein Benutzername*.

## Providers

Use the settings of your provider; the host name is on its help page, the examples write it as `mail.example.com`.

| Provider | Port | Encryption | Login |
|---|---|---|---|
| A mailbox provider with app passwords | 587 (or 465) | *STARTTLS* (or *TLS*) | Your full address and an **app password** created in the provider's security settings, not your normal password. |
| Gmail / Google Workspace | 587 (or 465) | *STARTTLS* (or *TLS*) | Your full address and an **app password**. The Google account needs 2-step verification first, and the admin of a Workspace must allow app passwords. |
| Microsoft 365 | 587 | *STARTTLS* | Your full address and its password. *SMTP AUTH* must be allowed for that mailbox (a Microsoft 365 admin switches it on per mailbox). A tenant that allows OAuth2 sign-in only is not supported yet. |
| A transactional relay service | 587 (or 465) | *STARTTLS* (or *TLS*) | The user name the service shows, and its **API key** as the password. |
| A relay in your home network | 25 | *Keine* | No user name and no password. |

The sender address (*Absenderadresse*) must be one the provider lets you send from: your own mailbox, or an address of a domain you have verified there. Otherwise the provider refuses it ("Absenderadresse abgelehnt").

**Sender domain: SPF, DKIM and DMARC.** Whether a mail lands in the inbox or the spam folder depends on the sender domain's DNS records, which you set up at the provider (it shows the records to add). FriendFlix cannot do this for you and does not check it.

## Your own mail server

If you run your own SMTP server:

- It needs a **valid certificate that matches the host name** you enter, e.g. one from Let's Encrypt for `mail.example.com`. A self-signed certificate, an expired one, or a bare IP address that is not in the certificate fails with "TLS" (*Verschlüsselte Verbindung kam nicht zustande*); FriendFlix does not offer to trust it.
- Enter the host name, not the IP address, even if both reach the server.
- Port 587 with *STARTTLS* (submission) is the usual choice; use the user name and password of a mailbox or a submission account on that server.
- A relay inside your home network, which only accepts mail from your own machines, can be used with *Keine* and no login. That is the one case for *Keine*.
- The backend container must reach the server: the address has to work from inside Docker, not only from your PC.

## Checking it

- **Testen** (next to the settings, before you save) checks the connection with the values on the page: connect, encryption and login, without sending a mail.
- **Testmail senden** sends a branded test mail **only to the address of the admin who is signed in**, in that admin's language, and says whether it was sent. It can be used 3 times in 10 minutes per admin. A test mail that cannot be sent right away stays in the outbox and is retried like any other mail.
- **Admin → Status → Systemcheck**, the line *E-Mail-Versand*. It checks the connection (a result is kept for 10 minutes, so the page does not log in to your provider every minute; changing a setting drops it, and *Jetzt prüfen* checks again) and then the outbox. A successful check of the saved settings also clears an old connection error from the E-Mail card. Every line that is not ok links to this page.

| Systemcheck says | What to do |
|---|---|
| *Kein Mailserver eingetragen* (not set up) | Optional. Enter server and sender address. |
| *Der Mailserver ist nicht erreichbar* | Check server and port; the backend must reach it, and your firewall or the provider must allow outgoing SMTP. |
| *Die verschlüsselte Verbindung … kam nicht zustande* | Pick the encryption that fits the port (587 *STARTTLS*, 465 *TLS*); check the certificate ([your own mail server](#your-own-mail-server)). |
| *Der Mailserver hat die Anmeldung abgelehnt* | User name and password; many providers need an app password. |
| *Ohne Verschlüsselung sendet … kein Passwort* | Choose *STARTTLS* or *TLS*, or empty user name and password. |
| *Ein Passwort ist eingetragen, aber kein Benutzername* | Enter the user name or remove the password. |
| *Eine E-Mail ging in den letzten 24 Stunden nicht raus* (warning) | See the error code below; the E-Mail card shows the last error. |
| *E-Mails sind seit über 15 Minuten fällig* (warning) | Mail has been due (or its send lease ran out) for over 15 minutes and is not going out: background jobs must run (`BACKGROUND_JOBS=true`); send a test mail. Mail waiting for a retry or a rate limit does not count. |

## Which mails people get

A person gets mail only when all of this holds: e-mail is set up (server and sender address), `PUBLIC_URL` is set (every mail links to the app; without it nothing is queued), the account has a valid e-mail address (the one on the account page, which comes from Authentik), the account is not disabled and its access has not ended, and the mail's switch is on. Otherwise no mail is queued at all; the in-app notice is the same either way. A mail is written in the language of the account's main profile (else the instance default, else German), fixed when it is queued.

| Mail | When | Switch on the account page |
|---|---|---|
| Welcome | The first sign-in of a new account. Once per account, ever. | none |
| Invitation | An admin types an address in the invite dialog ([below](#invitations)). | none (there is no account yet) |
| *Verfügbare Wünsche* (`available`) | Something the person wished for is available. | *Verfügbare Wünsche* |
| *Aufnahmen* (`recording`) | A recording is finished (a series episode once it is complete, so an incomplete one mails once), failed or stayed incomplete, or is about to be deleted to make room. | *Aufnahmen* |
| *Ablaufende Downloads* (`licence`) | Downloads on the person's devices expire soon ([below](#expiring-downloads)). | *Ablaufende Downloads* |
| *Wochenrückblick* (`digest`) | Once a week ([below](#weekly-recap)). **Off until the person switches it on.** | *Wochenrückblick* |
| Admin alerts (`update`, `updatefailed`, `syscheck`, `storage`) | Admins only ([below](#mails-for-admins)). | *Für Admins* section |

The switchable mails are the e-mail form of an in-app notice, with the same text the notices show; a notice that is raised again (a retried webhook, a second run) never mails twice. Mail is per account: **kids profiles** have no switches and get no mail of their own; a licence or a wish of a kids profile is mailed to the account's address with the same text the account's notices get.

### The switches

*Konto → E-Mails* (`/me/account#mail`, owner profile only) shows the address the mails go to and one switch per type, all on by default. A switch saves at once. Without an address the card says *Keine E-Mail-Adresse hinterlegt* and links to the e-mail row under *Sicherheit*; while the server sends no mail it says *Dein Server verschickt noch keine E-Mails.* In both cases the switches cannot be changed. The switches are independent of push notifications, ntfy and the in-app weekly recap (each channel has its own switch). Admins also see a section *Für Admins* with the four admin switches ([below](#mails-for-admins)); other accounts do not see them and cannot set them. Mail has no quiet hours; only the licence run keeps to the daytime.

**Switched off means never sent.** Switching a type off (on the card or with the link in a mail) also drops that person's mails of that type that are still waiting (for a retry, the rate limit or a server outage). And the outbox checks once more right before each send and deletes a waiting person mail unsent, with one of these codes in the log (never an address):

| Code | Why the mail was dropped |
|---|---|
| `unsubscribed` | Its type was switched off after it was queued. |
| `address_changed` | The account's address changed, was removed or is no longer valid since the mail was queued, so it never goes to an old address. |
| `inactive` | The account was deleted or disabled, or its access ended. |
| `not_admin` | An admin alert whose recipient is no longer an admin (demoted after the mail was queued). |

### Unsubscribing

Every switchable mail has two ways out at the bottom, and both work without signing in:

- **The link *Diese E-Mails abbestellen*** opens `/mail/unsubscribe?t=…`, a page that names the mail type in plain words (*Keine E-Mails mehr zu ablaufenden Downloads?*) and has one button, *Abbestellen*. Nothing changes until it is pressed: a mail scanner or a link preview that opens the page switches nothing off. Afterwards *Wieder anmelden* switches the type back on, and *E-Mail-Einstellungen* leads to the account page. The page takes the token out of the address bar at once (the browser's own history list of visited pages still has the link, as it has any link you opened), sends no `Referer`, and never shows an address. A damaged or old link (see below) says *Dieser Link ist ungültig.* and nothing else.
- **One-click unsubscribe in the mail program.** The mail carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), so large mailbox providers show their own *Unsubscribe* button next to the sender. It posts to `/api/public/mail/unsubscribe?t=…` and switches the type off at once. A plain `GET` of that address (a scanner, or a mail program that opens it in a browser) changes nothing and only forwards to the page. Providers show the button only when the mail's **DKIM signature covers the `List-Unsubscribe` and `List-Unsubscribe-Post` headers**: that is a setting of your mail provider or your own server's DKIM signer (most sign these headers already). Without it, the link at the bottom still works.

The link carries a token for **one person and one mail type**: it can switch only that type for that person, on or off, and nothing else. It does not expire. Changing `APP_ENC_KEY` makes all earlier links invalid ([security.md](security.md#e-mail)). The welcome mail and invitations have no unsubscribe link (the welcome mail links to the settings instead; an invitation goes to someone without an account and says to ignore it if unexpected).

**Your reverse proxy could log the link.** A reverse proxy in front of FriendFlix (for example Nginx Proxy Manager) writes the address of every request to its own access log, `/mail/unsubscribe?t=…` with the token included, just as it logs `/invite/<token>` links. FriendFlix's own request log hides the token (`t=[redacted]`). The shipped template `deploy/npm/portal.advanced.conf` has two exact `location` blocks, `= /mail/unsubscribe` and `= /api/public/mail/unsubscribe`, with `access_log off;` and `error_log /dev/null;` (like the cast and Live TV token paths); copy them when you update your proxy's *Advanced* tab. A proxy or log pipeline of your own should leave both paths out too, or keep its logs briefly. The risk is low either way: whoever reads the proxy log could switch that one mail type of that one person on or off, nothing more.

### Welcome

The welcome mail is sent at the end of the first successful sign-in of a new account (invitation, approval or the first admin), with a link to the app and to the mail settings (no unsubscribe link: it comes once). It is **once per account, ever**: the first sign-in marks the account as welcomed (`users.welcomed_at`) also when no mail can go out (no address yet, e-mail not set up), so a mail set up later never welcomes old accounts. The update that brought these mails marked every existing account as welcomed, so updating mailed nobody.

### Weekly recap

*Wochenrückblick* is the e-mail form of the weekly recap and is **opt-in**: it is off for everyone until a person switches it on under *Konto → E-Mails*, so updating mails nobody a recap. It is independent of the in-app recap (the *Wochenrückblick* notice and the `/digest` page): either can be on without the other. The mail has the same headline and range as the notice and lists titles as plain text, with no images and no links per title:

- *Neue Filme* (up to 12 names, then "… und n weitere"),
- *Neue Folgen* (up to 20 series the person follows, "Name (n neue Folgen)"),
- *Deine Wünsche sind da* (up to 20),
- *Empfehlungen für dich* (up to 5, "Name – von Anna").

Each name is cut to 120 characters, and one button opens `/digest`, where the titles are links. It has the usual *Diese E-Mails abbestellen* link and one-click unsubscribe. An admin's *Testdigest* mails the admin too when that admin's switch is on. It goes out in the same weekly run as the in-app recap and needs background jobs (`BACKGROUND_JOBS=true`).

### Expiring downloads

Once a day, in the first background run **between 09:00 and 21:00 server time** (the backend container's time zone, `TZ`, `Europe/Vienna` in the shipped compose files), FriendFlix looks for download licences that are still active, expire within the next **48 hours** and are at least 48 hours old. Each licence is warned once, ever, and each person gets one mail for all of them (how many, and the earliest expiry), together with the in-app notice. A run that would start before 09:00 or from 21:00 on (after a restart, a deploy, or downloads switched on in the evening) waits for the next 09:00: no licence mail at night. So **a licence of 4 days or more is warned 24 to 48 hours before it expires**; a 3-day licence only within its last 24 hours (or not at all if no run falls into that day); 1- and 2-day licences never. It needs background jobs (`BACKGROUND_JOBS=true`).

### Invitations

When an admin creates an invitation (*Admin → Nutzer → Einladungen*), *E-Mail-Adresse (optional)* sends the new invitation link to that address right away; the dialog says *Einladung an a…@friend.example.com verschickt.*, that it waits in the outbox, or why it was not sent (copy the link and send it yourself then). The field can be used only while e-mail is set up (otherwise it is greyed out and says so), and only for an invitation for one person (*Nur für Einladungen für eine Person*: a link for several people cannot be mailed). The mail's language is chosen in the dialog (the instance language by default). An admin can send 20 invitation mails a day. The address is not kept with the invitation: it stays in the outbox, encrypted, until the mail is sent, and afterwards only in masked form there and in the audit log. A mail that waits in the outbox (a server outage, a rate limit) is withdrawn when the invitation is revoked, and dropped unsent once the invitation has expired or been used (code `invite_closed` in the log): it would only bring a dead link. If the mail cannot even be queued, the invitation still exists and the dialog shows its link with *nicht verschickt*; such a failed attempt, and an invitation that could not be created at all, does not count toward the 20. An invitation mail has no unsubscribe link (there is no account and no setting); it names who invited and says to ignore the mail if it was not expected.

## Mails for admins

Four mails go to **active admins that have an address**, and only to them. Each is also an in-app notice for every admin (the mail is the e-mail form of that notice, with the same text and a link into the admin area), and each has its own switch under *Konto → E-Mails → Für Admins*, **on by default**. They are not a "once forever": the notice's own key decides when a repeat is possible.

| Switch (type) | When | Once per |
|---|---|---|
| *Neue Versionen* (`update`) | A newer version is available on the channel that is selected. Checked every hour, but the update check itself runs at most every 6 hours. Link: *Admin → Update*. | Stable: each release. Pinned version: each pinned target. Nightly: at most one per calendar week (a nightly build appears almost daily). |
| *Fehlgeschlagene Updates* (`updatefailed`) | An update, a self-update or a rollback through the updater failed, or the new version did not come up and was rolled back; also the automatic redeploy through Portainer failing. Livetv jobs never mail, and a manual Portainer redeploy shows its error on the screen instead. Link: *Admin → Update*. | Each updater job (once, however often the page is opened); the Portainer redeploy once per target and day. |
| *Probleme im Systemcheck* (`syscheck`) | A server-side line of the Systemcheck turns into a **problem**. Checked every 15 minutes. All lines that turn in one run make **one** mail naming their groups (a database or Authentik outage flips several at once). A problem that stays does not repeat, and a line that flaps alerts at most once a day. After an update, lines that are already in problem at the first run alert once. Link: *Admin → Status*. | One mail per run; each line at most once per day. |
| *Speicherplatz* (`storage`) | The downloads or previews disk is almost full or short of free space (not the download size cap), checked after every health check; and the two Live TV recordings storage notices (full, or recordings deleted to make room). Links: *Admin → Status* and *Admin → Live-TV*. | Each disk, level (*fast voll*, *voll*) and day, so a disk that stays full mails daily, and *voll* after *fast voll* on the same day mails again. The recordings notices are once a day. |

Known limits:

- **While automatic updates in the nightly window are on** (`AUTO_UPDATE` set to the nightly window with an updater configured), **no "new version" mail is sent**: the update installs itself overnight. **If that window cannot install** (for example the updater is unreachable), admins get **no update mail either**, because nothing started that could fail. *Admin → Update* and the Systemcheck still show it.
- Nothing is mailed while mail is not set up; the in-app notices are the same either way.
- A demoted admin gets no further admin mail: a queued one is dropped unsent (`not_admin`).

## Authentik's own mails

Password reset and the confirmation of a new address in the enrollment flow are sent by Authentik, not by FriendFlix, so they do not go through this outbox. The templates that give them the FriendFlix look, and the action that copies your name, logo and sender into Authentik, are in [authentik.md §10b](authentik.md#10b-e-mails-in-the-friendflix-look). Because Authentik's sender field takes a bare address, those mails show no display name.

## The outbox

A mail is not sent from the request that asks for it: it is written to a queue in the database and a background job sends it, so a slow or broken server never holds up a page and a mail is not lost when the backend restarts. The job runs every 30 seconds and only where `BACKGROUND_JOBS=true`.

- **Retries.** A mail that fails for a reason that may pass (a busy server, a temporary refusal) is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours; the 6th failed attempt is final. A permanent refusal (an SMTP 5xx answer) is final at once.
- **A broken connection is not the mail's fault.** If the server cannot be reached, the TLS handshake fails or the login is refused, the mails do not use up an attempt: they wait, and the job tries again after a growing pause (1 minute up to 6 hours).
- **Expiry.** A mail that is still queued after **72 hours** fails with `expired`.
- **Limits.** Per recipient 10 mails an hour and 50 a day, and 200 an hour for the whole installation. A mail over a limit waits until it fits; this is not an error and uses no attempt.
- **Timeouts.** Connecting 10 s, the server's greeting 10 s, and 30 s without traffic; *Testen* checks the connection within 5 s, the Systemcheck within 3.5 s.
- **Several instances.** A mail is claimed with a 2-minute lease, and a batch stops starting new sends when less than 45 seconds of the lease are left (the rest goes back to the queue), so a second backend normally has no reason to pick up a mail that is still being sent. Rarely a mail can go out twice: if the backend stops between sending and noting it as sent, or if one single send takes longer than the lease, the mail is sent again once.
- **History.** Final rows (sent or failed) are deleted 30 days after they ended.

### Error codes

*Admin → Einstellungen → E-Mail* and the Systemcheck show a code, never the server's own text (which could quote an address). With a refusal the 3-digit SMTP status is added ("SMTP 550").

| Code | Shown as | Meaning |
|---|---|---|
| `unreachable` | *Mailserver nicht erreichbar* | No connection (wrong host or port, firewall, DNS). |
| `timeout` | *Mailserver antwortet nicht* | The server did not answer in time. |
| `tls` | *Verschlüsselte Verbindung kam nicht zustande* | Wrong mode for the port, no STARTTLS offered, or a certificate that is untrusted, expired or for another name. |
| `auth` | *Benutzername oder Passwort abgelehnt* | Wrong login; an app password may be needed. |
| `sender_refused` | *Absenderadresse abgelehnt* | The provider does not allow this sender address. Final. |
| `recipient_refused` | *Empfängeradresse abgelehnt* | The recipient's address was refused. A 5xx is final, a 4xx is retried. |
| `message_refused` | *Nachricht abgelehnt* | The server refused the message itself (also a spam filter). |
| `expired` | *Nach 72 Stunden aufgegeben* | The mail waited 72 hours without being sent. Final. |
| `rate_limited` | *Versandgrenze erreicht* | Over a limit; goes on later. |
| `unreadable` | *Gespeicherte Empfängeradresse nicht lesbar* | The queued mail was stored with another encryption key (`APP_ENC_KEY` changed) or is damaged. Final. |
| `not_configured` | *Server oder Absenderadresse fehlt* | Nothing to send with: the server or the sender address is empty. |
| `no_user` | *Passwort ohne Benutzername* | A password is set but no user name; it is not sent without one. Enter the user name or delete the password (only reachable through `.env`, the settings page refuses to save it). |
| `insecure_auth` | *Ohne Verschlüsselung wird kein Passwort gesendet* | *Keine* with a login. |
| `unexpected` | *Unerwarteter Fehler* | Anything else, e.g. a mail that was claimed again and again without finishing. Retried, but final after the 6th attempt. |

## Privacy

- **No tracking.** No tracking pixels, no link redirects, no remote images: a mail loads nothing when it is opened. The brand symbol, if it is a PNG of at most 200 KB, is sent inside the mail (at 48 × 48); otherwise the mail shows the first letter of the platform name on the accent colour.
- **The outbox stores little.** While a mail waits, its address and content are stored encrypted (`APP_ENC_KEY`), so a queued invitation link is no readable copy. When the mail is sent or has failed for good, address and content are wiped; only the kind of mail, the address in masked form (`a…@friend.example.com`), the state, the error code and the times stay, for 30 days.
- **Logs and the audit log carry codes only**: never the password, an address, a mail's text or the server's reply. The SMTP password is stored encrypted and is never sent to the browser ([security.md](security.md#e-mail)).
- **The test mail goes only to the signed-in admin's own address**, so the button cannot be used to mail anyone else.
- **Person mails go only to the account's own address**, and only while the account may get them; an unsubscribe link changes one switch of one person and shows no address. The unsubscribe token can end up in a reverse proxy's access log unless the proxy leaves those paths out, as the shipped template does ([Unsubscribing](#unsubscribing)).
