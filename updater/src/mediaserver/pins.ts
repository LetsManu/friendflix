// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Engine } from './engine.js';
import { KINDS, type Kind } from './types.js';

/**
 * The only place that knows where the media server pins come from: the label on the running backend image, read only after that
 * image passed cosign. (A later project moves the pins; nothing else may read them.)
 */
export const PIN_LABEL = 'io.github.letsmanu.friendflix.mediaserver.pins';
export interface Pin { kind: Kind; image: string; digest: string; upstream: string | null }

const HEX = '[0-9a-f]{64}';
const FERROFIN_TAIL_RE = new RegExp(`^@(sha256:${HEX})$`);
const JELLYFIN_RE = new RegExp(`^docker\\.io/jellyfin/jellyfin:([0-9]+\\.[0-9]+\\.[0-9]+)@(sha256:${HEX})$`);

/** `kind=ref` entries separated by whitespace; an invalid or duplicated entry disables only its kind */
export function parsePinLabel(value: string | undefined, repo: string): { pins: Partial<Record<Kind, Pin>>; invalid: Kind[] } {
  const pins: Partial<Record<Kind, Pin>> = {};
  const invalid = new Set<Kind>();
  const seen = new Set<string>();
  const ferrofinImage = `ghcr.io/${repo.toLowerCase()}-mediaserver`;
  for (const entry of (value ?? '').split(/\s+/).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const kind = entry.slice(0, eq);
    if (eq < 0 || !(KINDS as readonly string[]).includes(kind)) continue; // unknown kind: nothing to disable
    const k = kind as Kind;
    const ref = entry.slice(eq + 1);
    if (seen.has(k)) { invalid.add(k); delete pins[k]; continue; }
    seen.add(k);
    if (k === 'jellyfin') {
      const m = JELLYFIN_RE.exec(ref);
      if (m) pins.jellyfin = { kind: k, image: `docker.io/jellyfin/jellyfin@${m[2]}`, digest: m[2]!, upstream: m[1]! }; else invalid.add(k);
    } else {
      const m = FERROFIN_TAIL_RE.exec(ref.slice(ferrofinImage.length));
      if (ref.startsWith(ferrofinImage) && m) pins.ferrofin = { kind: k, image: ref, digest: m[1]!, upstream: null }; else invalid.add(k);
    }
  }
  return { pins, invalid: [...invalid] };
}

export interface PinDeps { engine: Engine; project: string; verify(imageRef: string): Promise<boolean>; repo: string }
export type PinRead = { source: string; pins: Partial<Record<Kind, Pin>>; invalid: Kind[] } | { error: 'no_backend' | 'verify_failed' };

const cache = new WeakMap<Engine, { id: string; read: PinRead }>();

export async function readPins(d: PinDeps): Promise<PinRead> {
  const found = await d.engine.listContainers({ 'com.docker.compose.project': d.project, 'com.docker.compose.service': 'backend' }, true);
  const backend = found[0] ? await d.engine.inspectContainer(found[0].id) : null;
  const id = typeof backend?.Image === 'string' ? backend.Image : '';
  const cfg = backend?.Config as { Image?: unknown; Labels?: unknown } | undefined;
  if (!id || typeof cfg?.Image !== 'string') return { error: 'no_backend' };
  const hit = cache.get(d.engine);
  if (hit?.id === id) return hit.read;
  if (!(await d.verify(cfg.Image))) return { error: 'verify_failed' };
  // the tag that was verified must still be the running image, or the label would come from an unverified image
  if ((await d.engine.inspectImage(cfg.Image))?.id !== id) return { error: 'verify_failed' };
  const img = await d.engine.inspectImage(id);
  if (!img) return { error: 'no_backend' };
  const read: PinRead = { source: id, ...parsePinLabel(img.labels[PIN_LABEL], d.repo) };
  cache.set(d.engine, { id, read });
  return read;
}
