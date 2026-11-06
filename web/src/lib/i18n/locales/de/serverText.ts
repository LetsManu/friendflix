// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Texts that differ by media server: serverText.<kind>.<key> wins over <key> while the instance runs that kind
 * (i18n translate, kind from /api/me server.kind). Jellyfin uses the plain keys; only keys that name the server belong here.
 */
const serverText = {
  plex: {
    admin: { banner: { svc: { empty_media: 'Medienserver liefert leere Videostücke – Plex neu starten; hilft das nicht, Hardware-Beschleunigung prüfen' } } },
    adminContent: { health: { reason: { empty_media: 'Medienserver liefert leere Videostücke – Plex neu starten; hilft das nicht, Hardware-Beschleunigung prüfen' } } },
    // on Plex, engine v1 is FriendFlix's own genre + cast similarity (Jellyfin has no part in it)
    reco: { admin: { engine: { v1: 'v1 (klassisch)' } } },
    settings: { options: { RECO_ENGINE: { v1: 'v1 (klassisch)' } } },
  },
} as const;

export default serverText;
