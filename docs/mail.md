<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# E-Mail

FriendFlix can send e-mail through an SMTP server you choose: your mailbox provider, a relay service or a mail server of your own. This is the first stage; today the only mail is the test mail. Mails to people (invitations, notices, a digest) and alerts to admins come in later releases and use the same settings and the same outbox. Nothing here is needed to run FriendFlix; without a server FriendFlix sends no e-mail and the Systemcheck says so as a neutral line.

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
