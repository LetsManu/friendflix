# FriendFlix for LG TVs: store submission checklist

**Later phase.** The LG app is installed today through Developer Mode ([webos.md](webos.md)). This page is the list for submitting it to the LG Content Store later; nothing here is needed for the Developer Mode install.

## What LG asks for

- **An LG Seller Lounge account.** Register as a developer or company; apps are submitted and tracked there.
- **The `.ipk` package.** The release package `FriendFlix-<version>.ipk`. Developer-mode packages are unsigned; LG signs store apps itself.
- **Store images.** App icon and screenshots in the sizes the Seller Lounge asks for at submission time.
- **A UX scenario document.** A short document that walks through the app's screens and how the remote is used.
- **LG's self-checklist.** The submission checklist, filled in by us.
- **An age rating** for the app.
- **A test server and test account for LG QA.** LG's testers must be able to start the app, enter a server address and watch something without any personal data. See the demo server below.

## What is already store-ready

- **Back exits the app.** Back on the TV-mode home screen leaves the app (LG requires this on the first screen).
- **No test code in the release package.** `FriendFlix-<version>.ipk` contains no probe or test code; the probe is a separate package.
- **Own artwork.** Only FriendFlix's own artwork is used; no third-party logos or look-alikes.
- **Icon and splash in the right sizes.** Icon 80x80, large icon 130x130, a 400x400 icon, and a splash of 1920x1080; the build checks the exact pixel sizes.
- **Back arrives as a key,** not a history step (`disableBackHistoryAPI`), so the app decides what Back does.

Still open for the store: the store images, the UX scenario document, the age rating, and checking the self-checklist against a real TV.

## The planned demo server

LG QA needs a server with something to watch. The plan: a small FriendFlix demo server on the owner's VPS, filled only with freely licensed films, namely the Blender open movies (Creative Commons licensed). It gets a ready test account for LG QA, a library that cannot lead anywhere else, and no personal data. The server is not set up yet.
