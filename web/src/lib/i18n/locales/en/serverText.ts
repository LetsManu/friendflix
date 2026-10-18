// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/serverText';
import type { Translation } from '../../types';

/** Texts that differ by media server (see de/serverText.ts). */
const serverText: Translation<typeof de> = {
  plex: {
    admin: { banner: { svc: { empty_media: 'Media server returns empty video – restart Plex; if that doesn’t help, check hardware acceleration' } } },
    adminContent: { health: { reason: { empty_media: 'Media server returns empty video – restart Plex; if that doesn’t help, check hardware acceleration' } } },
    // on Plex, engine v1 is FriendFlix's own genre + cast similarity (Jellyfin has no part in it)
    reco: { admin: { engine: { v1: 'v1 (classic)' } } },
    settings: { options: { RECO_ENGINE: { v1: 'v1 (classic)' } } },
  },
};

export default serverText;
