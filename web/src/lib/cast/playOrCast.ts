// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Click handler for play links: while a cast session runs, a plain tap on Play sends the title to the TV and keeps the
 * user on the page. Without a session, with a modifier key / non-primary button, or when the click was already handled,
 * it does nothing and the link navigates to /watch/… as usual. Only call it for links that play a Movie / Episode.
 *
 * In the Android app (native.available) a plain tap hands the title to the native player instead. The link is held back while the app
 * answers; if it declines (or does not answer within the bridge timeout) the page navigates to the link's own href, so the web player
 * is always the fallback.
 */
import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import { native } from '#lib/native/bridge';
import { tryNativePlay } from '#lib/native/play';
import { tr } from '#lib/i18n';
import { noteInteraction } from '#lib/stillwatching';
import { toast } from '#lib/ui/toast';
import { castEngine, castSession } from './engine';

export function playOrCast(e: MouseEvent, item: { id: string; positionTicks?: number }, opts?: { audio?: string; subtitle?: string }): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const s = get(castSession);
  if (!s) return playNatively(e, item, opts);
  e.preventDefault();
  noteInteraction(); // a tap: the viewer is there ("still watching?")
  void castEngine.playOnTv(item.id, item.positionTicks ? item.positionTicks / 10_000_000 : undefined);
  toast.info(tr('player.castBar.playingOn', { device: s.device }));
  return true;
}

/** a native play request waits for the app's answer; further taps meanwhile are swallowed (no double start) */
let pendingPlay = false;

function playNatively(e: MouseEvent, item: { id: string; positionTicks?: number }, opts?: { audio?: string; subtitle?: string }): boolean {
  if (!native.available) return false;
  const a = (e.currentTarget as Element | null)?.closest?.('a');
  const href = a?.getAttribute('href') || `/watch/${item.id}`;
  e.preventDefault();
  if (pendingPlay) return true;
  noteInteraction();
  pendingPlay = true;
  const where = location.href;
  void tryNativePlay(item, opts)
    .then((ok) => {
      // the viewer went elsewhere while the app was thinking: do not drag them to the player now
      if (!ok && location.href === where) void goto(href);
    })
    .finally(() => { pendingPlay = false; });
  return true;
}
