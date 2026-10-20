# Privacy policy: FriendFlix Android app

*Deutsch: [de/privacy.md](de/privacy.md)*

Effective: 20 October 2026. App: FriendFlix (`com.friendflix`), published by Manuel Weißböck.

## In short

FriendFlix connects only to a FriendFlix server that **you** enter at the first start, usually run by you, your household or a friend. The publisher of the app runs no server for the app and receives no data from it. The app contains no analytics and no advertising.

## What the app sends, and to whom

- **To your FriendFlix server:** everything you do in the app: signing in, browsing, playing, downloading, watch progress, requests, and the background check for new notifications (about every 10 to 20 minutes while you are signed in). The person who runs that server is responsible for that data. Their privacy terms apply, not this policy.
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

## Children

The app has no account of its own and collects nothing for its publisher. Kids profiles are set up by the server's operator.

## Changes and contact

Changes to this policy are published at this address, and the history of this file shows every change. Questions: open an issue at <https://github.com/LetsManu/friendflix/issues>.
