// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the TV app probes (Samsung lib/tizen/probe.ts, LG lib/webos/probe.ts) play: the first Continue watching item, else the
 * newest film or episode, looked up with the page's own session. Rejects with `code: 'unpaired'` (the TV has no session) or
 * `code: 'profile'` (no profile chosen on the TV, or switched elsewhere); any other failure has no code.
 */
import { getActiveProfile, getCsrf, setCsrf } from '#lib/api';

/** the stream URLs (`url` falls back to the converted stream; `direct` says whether it is the original file) and the function that tells the server the play session ended */
export interface ProbeTarget { url: string; hlsUrl: string; direct: boolean; report: () => Promise<unknown> }

interface ItemRef { id: string }
interface InfoAnswer { playSessionId: string; mediaSourceId: string; directUrl?: string; hlsUrl: string; resumeTicks?: number }

const coded = (code: string) => Object.assign(new Error(code), { code });

export async function fetchProbeTarget(win: { location: { origin: string } }, fetchImpl: typeof fetch, opts: { caps?: unknown } = {}): Promise<ProbeTarget> {
  /** own fetch instead of api(): a 409 profile error must come back as an answer here, not reload the page to /profiles */
  const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const profile = getActiveProfile();
    const res = await fetchImpl(path, {
      method, credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-csrf-token': getCsrf(), ...(profile ? { 'x-ff-profile': profile } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: { error?: string } | null = null;
    try { json = await res.json(); } catch { /* empty or not JSON */ }
    if (res.status === 409 && (json?.error === 'profile_required' || json?.error === 'profile_changed')) throw coded('profile');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json as T;
  };
  let paired = false;
  try {
    const me = await fetchImpl('/api/me', { credentials: 'same-origin' });
    if (me.ok) {
      const m = (await me.json()) as { tv?: boolean; csrfToken?: string };
      paired = Boolean(m.tv);
      if (typeof m.csrfToken === 'string') setCsrf(m.csrfToken); // the layout's own boot may not have finished: the POSTs below need the token
    }
  } catch { /* offline */ }
  if (!paired) throw coded('unpaired');
  let items = (await call<{ items: ItemRef[] }>('/api/library/resume')).items;
  if (!items?.length) items = (await call<{ items: ItemRef[] }>('/api/library/items?types=Movie,Episode&sort=DateCreated&desc=true&limit=1')).items;
  if (!items?.length) throw new Error('empty library');
  const itemId = items[0]!.id;
  const info = await call<InfoAnswer>('/api/playback/info', 'POST', { itemId, reasonHint: 'network', ...(opts.caps ? { caps: opts.caps } : {}) });
  const abs = (u: string) => new URL(u, win.location.origin).href;
  const playMethod = info.directUrl ? 'DirectPlay' : 'Transcode';
  return {
    url: abs(info.directUrl ?? info.hlsUrl),
    hlsUrl: abs(info.hlsUrl),
    direct: Boolean(info.directUrl),
    // the stop report stores a position for the owner's title: send the resume point back, never a made-up 0 (that would reset it)
    // (`probe`: a test play, the server keeps it out of the device hand-off)
    report: () => call('/api/playback/stop', 'POST', { itemId, playSessionId: info.playSessionId, mediaSourceId: info.mediaSourceId, positionTicks: info.resumeTicks ?? 0, isPaused: false, playMethod, probe: true }),
  };
}
