// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/serverText';
import type { Translation } from '../../types';

/** Texts that differ by media server (see de/serverText.ts). */
const serverText: Translation<typeof de> = {
  plex: {
    admin: { banner: { svc: { empty_media: 'Le serveur multimédia renvoie une vidéo vide – redémarrez Plex ; si cela ne suffit pas, vérifiez l’accélération matérielle' } } },
    adminContent: { health: { reason: { empty_media: 'Le serveur multimédia renvoie une vidéo vide – redémarrez Plex ; si cela ne suffit pas, vérifiez l’accélération matérielle' } } },
    // on Plex, engine v1 is FriendFlix's own genre + cast similarity (Jellyfin has no part in it)
    reco: { admin: { engine: { v1: 'v1 (classique)' } } },
    settings: { options: { RECO_ENGINE: { v1: 'v1 (classique)' } } },
  },
};

export default serverText;
