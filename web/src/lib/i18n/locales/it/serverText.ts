// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/serverText';
import type { Translation } from '../../types';

/** Texts that differ by media server (see de/serverText.ts). */
const serverText: Translation<typeof de> = {
  plex: {
    admin: { banner: { svc: { empty_media: 'Il media server restituisce video vuoti – riavvia Plex; se non basta, controlla l’accelerazione hardware' } } },
    adminContent: { health: { reason: { empty_media: 'Il media server restituisce video vuoti – riavvia Plex; se non basta, controlla l’accelerazione hardware' } } },
    // on Plex, engine v1 is FriendFlix's own genre + cast similarity (Jellyfin has no part in it)
    reco: { admin: { engine: { v1: 'v1 (classico)' } } },
    settings: { options: { RECO_ENGINE: { v1: 'v1 (classico)' } } },
  },
};

export default serverText;
