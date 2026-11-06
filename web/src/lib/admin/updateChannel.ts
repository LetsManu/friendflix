// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Update, channel part (backend/src/channel.ts): which channel the install runs, the selected one (setting
 * UPDATE_CHANNEL: stable, nightly or a fixed version), and when to show the `.env` line plus the pull command. Without the
 * updater (compose.no-updater.yaml) switching means: change FF_TAG in the stack's .env, then pull and restart; with it (the default
 * since 2.0) the updater installs the selected channel (lib/admin/updater.ts).
 */
import type { BuildKind, Channel } from '#lib/version/build';

/** what can be selected: the two running channels plus a fixed version (UPDATE_VERSION) */
export type SelectedChannel = Channel | 'pinned';
export const CHANNELS: readonly SelectedChannel[] = ['stable', 'nightly', 'pinned'];
/** X.Y.Z, the same rule as the backend (config.ts UPDATE_VERSION) */
export const VERSION_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
/**
 * The production stack (compose.prod.yaml; FF_TAG only exists there) as it runs without the updater: the snippet only shows when no
 * updater answers, and since 2.0 compose.prod.yaml starts the updater unless compose.no-updater.yaml is named, so the command keeps it off.
 */
const files = (kind: string) => `-f compose.prod.yaml${kind === 'plex' ? ' -f compose.plex.yaml' : ''} -f compose.no-updater.yaml`;
/** the pull command of this instance: a Plex stack also names its override (compose.plex.yaml sets MEDIA_SERVER=plex) */
export const pullCommand = (kind: string = 'jellyfin'): string => `docker compose ${files(kind)} pull && docker compose ${files(kind)} up -d`;
export const PULL_COMMAND = pullCommand('jellyfin');

export interface ChannelInfo { selected: SelectedChannel; version?: string | null; running: Channel | null; build: BuildKind | null; label: string; locked: boolean; envLine: string }
export interface ChannelState { updateAvailable?: boolean | null; behind?: number | null; channel?: ChannelInfo | null }

/** the `.env` line for a channel (compose.prod.yaml: image tag ${FF_TAG:-latest}); pinned without a version: the stable line */
export const envLineFor = (c: SelectedChannel, version?: string | null): string =>
  `FF_TAG=${c === 'nightly' ? 'nightly' : c === 'pinned' && version ? version : 'latest'}`;

/** the selection differs from what runs: another running channel, or a fixed version other than the installed one */
function switching(s: ChannelState): boolean {
  const ch = s.channel;
  if (!ch) return false;
  if (ch.selected === 'pinned') return s.updateAvailable === true;
  return ch.running !== null && ch.running !== ch.selected;
}

/** the snippet shows when the selection differs from what runs (a known channel), or when there is an update on the selection */
export function showSnippet(s: ChannelState): boolean {
  if (!s.channel) return false;
  return switching(s) || s.updateAvailable === true;
}

/** "switch" when the selection differs from what runs, else "update" */
export const snippetReason = (s: ChannelState): 'switch' | 'update' => (switching(s) ? 'switch' : 'update');

/** nothing newer on the selected channel (older backends without channel: the commit comparison) */
export function isUpToDate(s: ChannelState): boolean {
  if (s.updateAvailable === false) return true;
  return s.updateAvailable == null && s.behind === 0;
}

/** arrow-key target in the segmented switch (wraps) */
export function stepChannel(cur: SelectedChannel, key: string): SelectedChannel | null {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return null;
  const i = CHANNELS.indexOf(cur), d = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  return CHANNELS[(i + d + CHANNELS.length) % CHANNELS.length]!;
}
