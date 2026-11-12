# Privacy policy: FriendFlix Android app

*Deutsch: [de/privacy.md](de/privacy.md)*

Effective: 9 November 2026. App: FriendFlix (`com.friendflix`), published by Manuel Weißböck.

## In short

FriendFlix connects only to a FriendFlix server that **you** enter at the first start, usually run by you, your household or a friend. The publisher of the app runs no server for the app and receives no data from it. The app contains no analytics and no advertising.

## What the app sends, and to whom

- **To your FriendFlix server:** everything you do in the app: signing in, browsing, playing, downloading, watch progress, requests, and the background check for new notifications (about every 10 to 20 minutes while you are signed in). The person who runs that server is responsible for that data. Their privacy terms apply, not this policy.
  - When a title plays in the app's web player, this includes one anonymous playback measurement per viewing (how long the start took, stalls, how the stream was delivered and whether the picture was copied or converted, the sound mode, dropped video frames and the number of seeks, track or quality switches and reconnects). The server stores it without your account, profile, title, IP address or device name and deletes it after 14 days.
  - So that another device can offer to continue what you were watching, the server keeps for each profile and device the last title that device played: the title and episode, where you stopped, the time, and whether it was an AirPlay or Chromecast cast. It keeps it at most 24 hours (the card only offers it for 6), and deletes it with the device, the profile or the account. It also stores the kind of app a device is (for example "LG TV" or "Windows app") and a name you may give the device under *Devices*. The name is deleted with the device and appears in your data download.
- **To the sign-in page your server names** (its identity provider), when you sign in.
- **To Google, only for Chromecast:** the app uses Google's Cast SDK. When you open the player, it looks for Cast devices on your Wi-Fi and Google receives its usual Cast usage data, as in every app with a Cast button. On a phone without Google Play services, no Cast data is sent.
- **Google Play** installs and updates the app under Google's own privacy policy.

The publisher receives none of this data.

## What stays on the phone

- The server address, the session cookie, app settings and which notifications you have seen.
- Downloaded movies and episodes, stored encrypted with keys kept in the Android Keystore.
- Watch progress made offline, until it is sent to your server.

None of this is included in Android cloud backups or device-to-device transfers.

## Permissions

| Permission | Why |
|---|---|
| Internet, network state | to reach your server and to notice when the network is back |
| Notifications | notifications about new episodes, requests and your account (you can turn them off) |
| Foreground service (media playback, data sync) | background audio and downloads with the screen off |

## Deleting your data

- **Settings → Sign out of this device** deletes every download, its keys, cookies and stored web data on the phone.
- Uninstalling the app deletes everything the app stored on the phone.
- Your account on the server and the data stored there: delete it yourself under **My space → Account → Delete account** or ask the server's operator. Steps and what is kept: [account-deletion.md](account-deletion.md).

## Live TV

This section applies when the server you connect to has Live TV turned on ([livetv.md](livetv.md)). Live TV adds the following to what your FriendFlix server stores about you. The person who runs the server is responsible for it; the publisher of the app receives none of it.

- **Zuletzt gesehen (recently watched):** per profile, the last 10 channels you opened and the time each was last opened. Nothing else: no durations, no programmes, no viewing history. Each time you open a channel, channels beyond the newest 10 are deleted.
- **Favourites and last channel:** the channels you starred, in your order, and the channel you watched last, per profile. A channel you can no longer see is hidden from them, not deleted.
- **While you watch:** a live view appears in the administrator's list of running streams (Admin → *Betrieb* → *Wiedergabe-Check*) like a film, with the channel name, your account name, your profile name and your device, until you stop. The Live-TV status page of the administrator only counts viewers per channel; it does not list names. It is not kept afterwards. Live views also count against your account's number of simultaneous streams.
- **Playback measurement:** the anonymous measurement of a live view contains only how long the first picture took and the kind of device, without channel, account, profile or device name.
- **Deleting:** favourites, *Zuletzt gesehen* and the last channel go with the profile or the account ([account-deletion.md](account-deletion.md)).
- **Not stored:** provider addresses and passwords never reach your device or the app; the stream you watch is addressed by a temporary token that is not logged.

## Children

The app has no account of its own and collects nothing for its publisher. Kids profiles are set up by the server's operator.

## Changes and contact

Changes to this policy are published at this address, and the history of this file shows every change. Questions: open an issue at <https://github.com/LetsManu/friendflix/issues>.
