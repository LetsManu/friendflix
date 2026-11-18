// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The MediaBrowser authorization header Jellyfin and Ferrofin read, e.g.
 * MediaBrowser Client="FriendFlix", Device="Portal", DeviceId="abc", Version="0.1.0", Token="..."
 * Values are stripped of quotes/newlines so they can never break out of the header. Shared by the Jellyfin adapter and the managed
 * media server's first run (which may not import an adapter folder).
 */
export function mediaBrowserHeader(opts: { deviceId: string; token?: string; version?: string; device?: string }): string {
  const esc = (v: string) => v.replace(/["\\\r\n]/g, '');
  const parts: Array<[string, string]> = [
    ['Client', 'FriendFlix'],
    ['Device', opts.device ?? 'Portal'],
    ['DeviceId', opts.deviceId],
    ['Version', opts.version ?? '0.1.0'],
  ];
  if (opts.token) parts.push(['Token', opts.token]);
  return 'MediaBrowser ' + parts.map(([k, v]) => `${k}="${esc(v)}"`).join(', ');
}
