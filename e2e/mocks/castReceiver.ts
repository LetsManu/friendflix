// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';

/**
 * A fake of Google's Cast Application Framework (CAF v3) receiver script, served for gstatic's URL so /cast-receiver/ runs in CI
 * without a Chromecast. `window.__caf`: `message(data)` = a sender message on the custom channel, `media(castId, dur)` = a
 * token became the current media, `time(pos, playing)` = the player reports its position, `play()` = a PLAY from the remote,
 * `calls` = what the receiver asked the framework to do (pause, play, seek:<s>, jump, sent:<json>, style:<json>), `connect()` = a sender
 * connected (SENDER_CONNECTED). `canDisplay` (fakeCaf option): the codecs the TV confirms through canDisplayType (`hvc1.1`, `hvc1.2`, `ec-3`, `ac-3`
 * prefixes of the codec string; `null` = a framework without canDisplayType); every question is in `calls` as `can:<mime>|<codecs>|<w>x<h>`.
 * The real framework's behaviour (queue jump, text track styles, key events) can only be checked on a TV.
 */
function cafScript(opts: { canDisplay?: string[] | null } = {}) {
  type Fn = (e?: unknown) => void;
  const calls: string[] = [];
  const listeners = new Map<string, Fn[]>();
  let custom: Fn = () => undefined;
  let playInterceptor: ((r: unknown) => unknown) | null = null;
  const st = { pos: 0, dur: 0, state: 'IDLE', media: null as unknown };
  const fire = (t: string) => (listeners.get(t) ?? []).forEach((fn) => fn({}));
  const pm = {
    setMediaElement() { /* own <video> */ },
    addEventListener(t: string | string[], fn: Fn) { for (const x of Array.isArray(t) ? t : [t]) listeners.set(x, [...(listeners.get(x) ?? []), fn]); },
    getPlayerState: () => st.state,
    getCurrentTimeSec: () => st.pos,
    getDurationSec: () => st.dur,
    getMediaInformation: () => st.media,
    setMessageInterceptor(t: string, fn: (r: unknown) => unknown) { if (t === 'PLAY') playInterceptor = fn; },
    pause() { calls.push('pause'); st.state = 'PAUSED'; },
    play() { calls.push('play'); st.state = 'PLAYING'; },
    seek(s: number) { calls.push(`seek:${s}`); st.pos = s; },
    sendLocalMediaRequest(r: { jump?: number }) { calls.push(`jump:${r.jump}`); },
    getTextTracksManager: () => ({ setTextTrackStyle(s: unknown) { calls.push(`style:${JSON.stringify(s)}`); } }),
  };
  const system: Fn[] = [];
  const context = {
    getPlayerManager: () => pm,
    addCustomMessageListener(_ns: string, fn: Fn) { custom = fn; },
    sendCustomMessage(_ns: string, to: unknown, m: unknown) { calls.push(`sent:${JSON.stringify(m)}`); if (to !== undefined) calls.push(`to:${String(to)}`); },
    addEventListener(t: string, fn: Fn) { if (t === 'sender-connected') system.push(fn); },
    start() { calls.push('start'); },
    ...(opts.canDisplay === null ? {} : {
      canDisplayType(mime: string, codecs?: string, w?: number, h?: number) {
        calls.push(`can:${mime}|${codecs}|${w ?? ''}x${h ?? ''}`);
        return (opts.canDisplay ?? []).some((c) => String(codecs).startsWith(c));
      },
    }),
  };
  class Plain {}
  (window as unknown as Record<string, unknown>).cast = { framework: {
    CastReceiverContext: { getInstance: () => context },
    CastReceiverOptions: class extends Plain {},
    system: { MessageType: { JSON: 'JSON' }, EventType: { SENDER_CONNECTED: 'sender-connected' } },
    messages: { PlayerState: { PLAYING: 'PLAYING' }, MessageType: { PLAY: 'PLAY', QUEUE_UPDATE: 'QUEUE_UPDATE' }, TextTrackStyle: class extends Plain {}, QueueUpdateRequestData: class extends Plain {} },
    events: { EventType: { PLAYER_LOAD_COMPLETE: 'PLAYER_LOAD_COMPLETE', MEDIA_STATUS: 'MEDIA_STATUS', TIME_UPDATE: 'TIME_UPDATE', PLAYING: 'PLAYING', PAUSE: 'PAUSE', MEDIA_FINISHED: 'MEDIA_FINISHED' } },
  } };
  (window as unknown as Record<string, unknown>).__caf = {
    calls,
    message: (data: unknown) => custom({ data, senderId: 's1' }),
    media(castId: string, dur: number) { st.media = { customData: { ff: { castId } } }; st.dur = dur; st.pos = 0; st.state = 'PLAYING'; fire('PLAYER_LOAD_COMPLETE'); },
    time(pos: number, playing = true) { st.pos = pos; st.state = playing ? 'PLAYING' : 'PAUSED'; fire('TIME_UPDATE'); },
    play() { playInterceptor?.({}); st.state = 'PLAYING'; fire('PLAYING'); },
    connect(senderId: string) { system.forEach((fn) => fn({ senderId })); },
  };
}

/** serves the fake framework for the receiver page's CAF script tag */
export async function fakeCaf(page: Page, o: { canDisplay?: string[] | null } = {}) {
  await page.route('https://www.gstatic.com/cast/sdk/libs/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `(${cafScript.toString()})(${JSON.stringify(o)});` }));
  const caf = <T>(fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => {
    const c = (window as unknown as { __caf: Record<string, (...x: unknown[]) => unknown> }).__caf;
    return c[f as string]!(...(a as unknown[])) as T;
  }, [fn, args] as const);
  return {
    message: (data: unknown) => caf('message', data),
    media: (castId: string, dur: number) => caf('media', castId, dur),
    time: (pos: number, playing = true) => caf('time', pos, playing),
    play: () => caf('play'),
    connect: (senderId: string) => caf('connect', senderId),
    calls: () => page.evaluate(() => (window as unknown as { __caf: { calls: string[] } }).__caf.calls.slice()),
  };
}
