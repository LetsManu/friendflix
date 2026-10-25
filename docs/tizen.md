# FriendFlix for Samsung TVs

**English** · [Deutsch](de/tizen.md)

The Samsung TV app is FriendFlix as an app on a Samsung smart TV (Tizen 6.5 or newer, that is 2022 models and later): a thin shell that asks for your server's address once and then opens the [TV mode](tv-mode.md) of your server, full screen. Everything you see is the web UI, so it always matches your server's version.

**Where this version stands.** This first release is the **probe build** plus the app shell. The probe is a small test app that finds out whether the TV's own video player (AVPlay) can play FriendFlix streams. The player itself, with the remote's keys and the capability list for AVPlay, comes in a following release, after the probe result is in. Until then the probe is what you can try. The Samsung app store is out of scope: the app is installed from your PC onto TVs you name.

**How it works, in short.** Samsung only lets a TV run apps that are signed with a certificate listing that TV's ID (its DUID). So the owner makes a Samsung certificate once, puts it into four GitHub secrets, and every release gets signed `.wgt` files. Then someone runs the install script on a PC in the same network as the TV. The app does **not** update itself: after a new release, run the install script again.

**Requirements:** a Samsung TV of the 2022 model year or newer (Tizen 6.5+; 2021 models run Tizen 6.0 and are not supported); a Windows, macOS or Linux PC in the same network as the TV; a FriendFlix server reachable over HTTPS with a certificate from a public CA, on the release that ships the Samsung TV app (see the [changelog](../CHANGELOG.md)) or newer; the TV paired for TV mode ([tv-mode.md](tv-mode.md)).

## Contents

- [Overview of the steps](#overview-of-the-steps)
- [TV: developer mode](#tv-developer-mode)
- [PC: Tizen Studio and the Samsung certificate](#pc-tizen-studio-and-the-samsung-certificate)
- [Owner steps: the four GitHub secrets](#owner-steps-the-four-github-secrets)
- [Friends' TVs](#friends-tvs)
- [Install on the TV](#install-on-the-tv)
- [First start: the server address](#first-start-the-server-address)
- [The probe and how to read its line](#the-probe-and-how-to-read-its-line)
- [Updates](#updates)
- [Troubleshooting](#troubleshooting)

## Overview of the steps

1. **Owner, once:** install Tizen Studio with the Samsung Certificate Extension, create the Samsung author and distributor certificates with the TV's DUID, export both as base64 and add the four GitHub secrets.
2. **Owner, per release:** the release workflow signs `FriendFlix-<version>.wgt` and `FriendFlix-probe-<version>.wgt` and attaches them with `SHA256SUMS-tizen.txt` to the GitHub Release. Without the secrets it leaves only a notice and attaches nothing.
3. **Per TV:** developer mode on, then run the install script from a PC.
4. **Probe first:** install the probe, read its line, send it to the owner of this project (see [the probe](#the-probe-and-how-to-read-its-line)).

## TV: developer mode

A Samsung TV installs your own apps only in developer mode.

1. Press **Home** on the remote and open **Apps**.
2. With the remote's number pad (or the on-screen number pad) enter **1 2 3 4 5**. The *Developer mode* dialog opens.
3. Set **Developer mode** to **On**.
4. In **Host PC IP** enter the IP address of the PC you will install from (Windows: `ipconfig`; macOS and Linux: `ip addr` or *Network* settings), for example `192.0.2.20`.
5. Press OK, then **restart the TV** (hold the power key until it restarts, or unplug it briefly). Developer mode applies only after the restart.

Note the TV's own IP address too (*Settings → General → Network → Network status → IP settings*), for example `192.0.2.50`. You give it to the install script.

Some models turn developer mode off after a reboot. If the install says it cannot connect, repeat steps 2 to 5.

## PC: Tizen Studio and the Samsung certificate

Only the PC that creates the certificate needs the full Tizen Studio; the PC that only installs needs just the command-line tools `sdb` and `tizen`.

1. Install **Tizen Studio** from [developer.tizen.org](https://developer.tizen.org/development/tizen-studio/download) (the installer with the IDE, or the CLI-only installer). **Create the certificates with Tizen Studio 6.1**: that is the version of the command-line tool the release job uses, and a p12 file created by a newer Tizen Studio (with a newer Java, which writes AES-encrypted p12 files) may fail to sign. The install script looks for `sdb` and `tizen` on the `PATH`, in `$TIZEN_STUDIO` and in `~/tizen-studio` (on Windows also `C:\tizen-studio`).
2. Open Tizen Studio's **Package Manager** and, under *Extension SDK*, install **Samsung Certificate Extension**. Restart Tizen Studio.
3. Sign in with a **Samsung account** when the certificate dialog asks for it.

### Read the TV's DUID

The DUID identifies the TV. Two ways:

- **Device Manager** (Tizen Studio: *Tools → Device Manager*): connect the TV (right-click, *Connect*; it needs developer mode and the Host PC IP from above). The TV's *DUID* shows in the device's properties.
- **Command line:** `sdb connect 192.0.2.50:26101`, then `sdb shell 0 getduid`.

### Create the certificates

In Tizen Studio open **Tools → Certificate Manager** and create a certificate profile:

1. **+** → *Samsung* certificate, device type *TV*.
2. Create a new **author certificate** (name, password, your details). Sign in with your Samsung account when asked.
3. For the **distributor certificate** choose *Public* privilege level, and add the **DUID** of every TV that should run the app (the DUID from above; more can follow, see [Friends' TVs](#friends-tvs)).
4. Finish. Tizen Studio writes the two files `author.p12` and `distributor.p12` into its data folder (typically `~/SamsungCertificate/<profile name>/` or `C:\Users\<you>\SamsungCertificate\<profile name>\`).

**Password limits.** The release signs through the Tizen command-line tool, which cannot take every character. Each of the two certificate passwords must be printable ASCII (letters, digits and the usual symbols), **without** `'` (single quote), `*`, `?`, `[`, and without a leading, trailing or double space. The release job stops with a clear message when a password does not fit. Create the certificates with a fitting password from the start: a long random one with letters and digits. Certificate Manager may not let you change the password of an existing p12, in which case you create the certificate again.

**OpenSSL 3.** If you re-export or convert a p12 file yourself with OpenSSL 3, add `-legacy` (`openssl pkcs12 -legacy ...`); otherwise the Tizen tool (which uses an older Java) cannot read the file.

## Owner steps: the four GitHub secrets

Add these four secrets to the repository (*Settings → Secrets and variables → Actions → New repository secret*, or with `gh`):

| Secret | Content |
|---|---|
| `TIZEN_AUTHOR_P12` | `author.p12`, base64 |
| `TIZEN_AUTHOR_PASSWORD` | its password |
| `TIZEN_DISTRIBUTOR_P12` | `distributor.p12` (lists the TVs' DUIDs), base64 |
| `TIZEN_DISTRIBUTOR_PASSWORD` | its password |

Encode the files as base64 without line breaks.

**Linux or macOS (bash):**

```sh
base64 < author.p12 | tr -d '\n' | gh secret set TIZEN_AUTHOR_P12
base64 < distributor.p12 | tr -d '\n' | gh secret set TIZEN_DISTRIBUTOR_P12
gh secret set TIZEN_AUTHOR_PASSWORD
gh secret set TIZEN_DISTRIBUTOR_PASSWORD
```

**Windows (PowerShell):**

```powershell
gh secret set TIZEN_AUTHOR_P12 --body ([Convert]::ToBase64String([IO.File]::ReadAllBytes('author.p12')))
gh secret set TIZEN_DISTRIBUTOR_P12 --body ([Convert]::ToBase64String([IO.File]::ReadAllBytes('distributor.p12')))
gh secret set TIZEN_AUTHOR_PASSWORD
gh secret set TIZEN_DISTRIBUTOR_PASSWORD
```

`gh secret set NAME` without input asks for the value. `gh` needs `gh auth login` once and must run inside your clone of the repository (or add `--repo LetsManu/friendflix`). Without `gh` copy the base64 text into the web form.

**Keep the p12 files and passwords** in your password manager as well, and never commit them. Never paste a p12 file or a password into a chat, an issue or a file in the repository. Whoever holds both can sign apps for the TVs listed in the distributor certificate.

**All four are needed.** The release workflow `tizen-release` runs on every `vX.Y.Z` tag; when one of the four secrets is missing it only writes a notice (*Samsung TV app release skipped*) and attaches nothing, and the rest of the release is not affected. To sign a release that already exists (for example after adding the secrets), run the workflow *Samsung TV app release* by hand (*Actions → Run workflow*) and choose the tag.

The files on the release are `FriendFlix-<version>.wgt`, `FriendFlix-probe-<version>.wgt` and `SHA256SUMS-tizen.txt`. The signing tool is a pinned version of the Tizen command-line tools (`tizen/tizen-cli.lock`, archive checked by its SHA-256 before it is used).

## Friends' TVs

A TV runs the app only if its DUID is in the distributor certificate that signed the `.wgt`. To add a friend's TV:

1. Install needs a PC on the friend's network: the TV's developer mode points to that PC's IP. Put the TV in developer mode with that PC's IP as Host PC IP, and read its DUID (see above); or ask the friend to read it with the Device Manager.
2. In Tizen Studio's **Certificate Manager** open your certificate profile, add the DUID to the distributor certificate and finish (it creates a new `distributor.p12`).
3. Update the GitHub secrets `TIZEN_DISTRIBUTOR_P12` (and the password, if you changed it).
4. Cut the next release, or re-run *Samsung TV app release* on the latest tag. Then install from that release.

TVs already installed keep working with the old file; only a TV that is not in the certificate yet needs the new one.

## Install on the TV

The scripts download the `.wgt` and `SHA256SUMS-tizen.txt` from the GitHub Release (the latest one by default), check the SHA-256 and refuse to install on a mismatch, then run `sdb connect <ip>:26101` and `tizen install` for that TV.

**Linux or macOS:**

```sh
./tizen/install.sh 192.0.2.50 --probe          # the probe first
./tizen/install.sh 192.0.2.50                  # FriendFlix
./tizen/install.sh 192.0.2.50 --version v2.4.0 # a specific release
```

**Windows (PowerShell):** run it from a clone of the repository (the scripts are in its `tizen` folder).

```powershell
powershell -ExecutionPolicy Bypass -File .\tizen\install.ps1 192.0.2.50 -Probe
powershell -ExecutionPolicy Bypass -File .\tizen\install.ps1 192.0.2.50
powershell -ExecutionPolicy Bypass -File .\tizen\install.ps1 192.0.2.50 -Version v2.4.0
```

`-ExecutionPolicy Bypass` only applies to this one call; without it Windows may refuse to run the script.

| Argument | Meaning |
|---|---|
| `<tv-ip>` | The TV's IPv4 address. Required. |
| `--probe` / `-Probe` | Install **FriendFlix Probe** (the test app) instead of FriendFlix. |
| `--version vX.Y.Z` / `-Version vX.Y.Z` | A specific release. Without it, the latest. |

Exit codes: `0` installed; `1` it failed (no connection, no download, hash mismatch, install failed; the script prints hints); `2` the arguments are wrong (usage is shown). The two apps are different apps and can stay installed side by side. Afterwards open the app from the TV's **Apps**.

If the install fails, the script prints a reminder to check developer mode and the Host PC IP, the same network and port 26101, and the DUID in the certificate; see [Troubleshooting](#troubleshooting).

## First start: the server address

On the first start the app asks for your server's address, for example `friend.example.com`.

- Enter it with the TV's keyboard: press OK on the field to open it, **Return** closes the keyboard, the arrow keys move between the field and **Connect**.
- Only `https://` works; `https://` is added for you. A plain `http://` address is refused (the TV carries a sign-in cookie).
- The app checks that the address answers like a FriendFlix server (`GET /api/version`, which the server answers for everyone, with CORS `*`, because it only holds public information). If not, it says why.
- The address is remembered. At the next start the app shows *Opening <address>* for a moment and opens your server's TV mode. If the TV is not paired yet, it shows the pairing code as usual: pair it as described in [tv-mode.md](tv-mode.md).
- **To change the address:** hold the **red key** for one second while the app shows *Opening <address>* (it stays for 3 seconds before it opens your server). It forgets the stored server and shows the form again.
- **Return** on the remote leaves the app (with the keyboard open it closes the keyboard first).

## The probe and how to read its line

The probe decides how the player is built, so please run it on the TV you want to use.

1. [Install the probe](#install-on-the-tv) (`--probe` / `-Probe`) and open **FriendFlix Probe** from the TV's Apps. The first start shows the same server-address form: enter your server's address ([First start](#first-start-the-server-address)).
2. **Pair the TV for TV mode first**, if it is not yet (the probe starts the pairing page; [tv-mode.md](tv-mode.md)). The play check needs a paired TV, because it plays a title from your library with the TV's own session. On the pairing page the probe shows as a small strip at the bottom; after pairing it starts again full screen.
3. The screen says **Testing playback...** (the TV tries to play the first *Continue watching* title, else your newest film or episode, for up to 15 seconds), then **Press ⏯ now**. Press the play/pause key on the remote within 20 seconds.
4. The screen shows **one line**. **Send the whole line to the project owner** (read it out or take a photo of the screen). **Back** closes the screen.

The line looks like this:

```
FFPROBE v1 avplay=ok play=ok:2310ms keys=ok app=ok tizen=6.5 model=QE55Q80B
```

| Field | Values | Meaning |
|---|---|---|
| `avplay` | `ok`, `missing` | `ok`: the TV's AVPlay player exists on the server page. `missing`: it does not, and the play check is skipped. |
| `play` | `ok:<ms>ms` | AVPlay started a FriendFlix stream and reached *playing* after that many milliseconds. |
| | `error:unpaired` | The TV is not paired for TV mode, so there was nothing to play. Pair it and run again. |
| | `error:profile` | No profile is chosen on the TV (or it was switched elsewhere). Pick the profile on the TV, then reopen the probe app. |
| | `error:info` | The stream lookup failed (no title, server answered with an error, offline). |
| | `error:open` | AVPlay refused the stream address (an exception without an error name). |
| | `error:play` | AVPlay was prepared, but starting playback raised an exception without a name. |
| | `error:prepare` | Preparing the stream failed without an error name. |
| | `error:timeout` | No playback within 15 seconds. |
| | `error:<code>` | AVPlay's own error name (for example `PLAYER_ERROR_INVALID_OPERATION`); `unknown` when none came. |
| | `skipped` | Not tried, because `avplay=missing`. |
| `keys` | `ok`, `error`, `timeout`, `skipped` | `skipped`: not tried, because the server page did not run inside the app (see `tizen=missing`). `ok`: the ⏯ key was registered and a press arrived. `error`: the key could not be registered. `timeout`: no press within 20 seconds (try again and press sooner). |
| `app` | `ok`, `missing` | Whether the Tizen application API is available. |
| `tizen` | version, `?` or `missing` | The platform version of the TV, for example `6.5`. `?`: the version could not be read. `missing`: the server page did not get the TV's `tizen` object, so it does not run inside the app (the line is then `play=skipped keys=skipped app=missing`). Send the line anyway. |
| `model` | name or `?` | The TV's model, for example `QE55Q80B`. |

**No probe screen at all** (the server page shows, but never a *Testing playback...* screen or a line): report `no-probe-screen`.

The result that matters most is `avplay=ok play=ok:...`. Whatever the line says, send it complete: other values still tell which parts need another approach.

The probe stays a diagnostic tool in the repository and on each release.

## Updates

The app does not update itself (a developer-mode app cannot). After a new release, run the install script again; it installs the new version over the old one. The version shown on the release is the server's version. The Samsung app store is out of scope.

## Troubleshooting

- **`sdb connect` fails or the TV is not listed:** developer mode must be on with the Host PC IP set to the PC you install from, and the TV restarted afterwards. The TV and the PC must be in the same network, and nothing may block TCP port `26101` (a firewall, a guest network or VLAN). Some TVs switch developer mode off after a reboot: turn it on again.
- **"install failed ... author certificate" or "Check certificate error":** the TV's DUID is not in the distributor certificate. Add the DUID and re-sign ([Friends' TVs](#friends-tvs)), then install the new release.
- **The release has no `.wgt` files:** the four secrets were not all set when the tag was built (*Actions → Samsung TV app release* shows the notice). Add them and run the workflow on the tag by hand. If the job fails with "password has characters the Tizen CLI cannot take", see the [password limits](#pc-tizen-studio-and-the-samsung-certificate).
- **The job cannot read the p12:** if you converted the file with OpenSSL 3, export it again with `-legacy`.
- **"SHA-256 mismatch":** the download is damaged or was replaced; the script installs nothing. Try again; if it persists, look at the release's files.
- **Wrong script on Windows:** run `install.ps1` in PowerShell from a clone of the repository. If scripts are blocked: `powershell -ExecutionPolicy Bypass -File .\tizen\install.ps1 192.0.2.50`.
- **"not an IPv4 address":** use the TV's address from its network settings, not a name.
- **"Cannot reach that server" on the TV:** the address, the TV's network, and that the server runs. "That address answered, but it is not a FriendFlix server" means another service answers there (a router page, a proxy login).
- **"Plain http:// addresses are not allowed":** put the server behind HTTPS (see [setup.md](setup.md)).
- **The probe shows `error:profile`:** pick the profile on the TV, then reopen the probe app.
- **The probe shows `tizen=missing`:** the server page ran outside the app's Tizen environment. Send the line to the project owner.
- **The probe shows `error:unpaired`:** pair the TV ([tv-mode.md](tv-mode.md)) and run the probe again.
- **Wrong server address stored:** hold the red key while the app starts.
