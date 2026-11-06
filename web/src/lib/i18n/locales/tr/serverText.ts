// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/serverText';
import type { Translation } from '../../types';

/** Texts that differ by media server (see de/serverText.ts). */
const serverText: Translation<typeof de> = {
  plex: {
    admin: { banner: { svc: { empty_media: 'Medya sunucusu boş video döndürüyor – Plex’i yeniden başlat; işe yaramazsa donanım hızlandırmayı kontrol et' } } },
    adminContent: { health: { reason: { empty_media: 'Medya sunucusu boş video döndürüyor – Plex’i yeniden başlat; işe yaramazsa donanım hızlandırmayı kontrol et' } } },
    // on Plex, engine v1 is FriendFlix's own genre + cast similarity (Jellyfin has no part in it)
    reco: { admin: { engine: { v1: 'v1 (klasik)' } } },
    settings: { options: { RECO_ENGINE: { v1: 'v1 (klasik)' } } },
  },
};

export default serverText;
