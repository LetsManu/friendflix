// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Engine } from '../src/mediaserver/engine.js';
import { PIN_LABEL, parsePinLabel, readPins } from '../src/mediaserver/pins.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const J = `jellyfin=docker.io/jellyfin/jellyfin:10.11.3@sha256:${B}`;
const F = `ferrofin=ghcr.io/letsmanu/friendflix-mediaserver@sha256:${A}`;
const TAG = 'ghcr.io/letsmanu/friendflix-backend:latest';
const REPO = 'LetsManu/friendflix';

describe('parsePinLabel', () => {
  it('parses both entries', () => {
    const r = parsePinLabel(`${J} ${F}`, REPO);
    expect(r.invalid).toEqual([]);
    expect(r.pins.jellyfin).toEqual({ kind: 'jellyfin', image: `docker.io/jellyfin/jellyfin@sha256:${B}`, digest: `sha256:${B}`, upstream: '10.11.3' });
    expect(r.pins.ferrofin).toEqual({ kind: 'ferrofin', image: `ghcr.io/letsmanu/friendflix-mediaserver@sha256:${A}`, digest: `sha256:${A}`, upstream: null });
  });

  it('accepts the build-stamp tags of Jellyfin 12.x and keeps the full tag as upstream', () => {
    const r = parsePinLabel(`jellyfin=docker.io/jellyfin/jellyfin:12.4.20261026-211555@sha256:${B}`, REPO);
    expect(r.invalid).toEqual([]);
    expect(r.pins.jellyfin).toMatchObject({ digest: `sha256:${B}`, upstream: '12.4.20261026-211555' });
    for (const t of ['12.4', '12.4.20261026-2115', '12.4.2026102-211555', '12.4.20261026-211555-x', '12.4.20261026_211555']) {
      expect(parsePinLabel(`jellyfin=docker.io/jellyfin/jellyfin:${t}@sha256:${B}`, REPO).invalid, t).toEqual(['jellyfin']);
    }
  });

  it('an invalid entry disables only its kind', () => {
    const bad = [
      `ferrofin=ghcr.io/someone/friendflix-mediaserver@sha256:${A}`,
      'ferrofin=ghcr.io/letsmanu/friendflix-mediaserver:latest',
      `ferrofin=ghcr.io/letsmanu/friendflix-mediaserver@sha256:${'A'.repeat(64)}`,
    ];
    for (const b of bad) {
      const r = parsePinLabel(`${J} ${b}`, REPO);
      expect(r.invalid, b).toEqual(['ferrofin']);
      expect(r.pins.jellyfin?.upstream).toBe('10.11.3');
      expect(r.pins.ferrofin).toBeUndefined();
    }
    const dup = parsePinLabel(`${J} ${F} ${F}`, REPO);
    expect(dup.invalid).toEqual(['ferrofin']);
    expect(dup.pins.ferrofin).toBeUndefined();
    expect(dup.pins.jellyfin).toBeDefined();
    expect(parsePinLabel(`${J} plex=x@sha256:${A}`, REPO)).toMatchObject({ invalid: [], pins: { jellyfin: { kind: 'jellyfin' } } });
    expect(parsePinLabel(`jellyfin=docker.io/jellyfin/jellyfin@sha256:${B}`, REPO).invalid).toEqual(['jellyfin']);
    expect(parsePinLabel(undefined, REPO)).toEqual({ pins: {}, invalid: [] });
  });
});

describe('readPins', () => {
  it('reads pins only from a verified backend image, once per image id', async () => {
    let image = 'sha256:' + '1'.repeat(64);
    const engine = {
      listContainers: async (labels: Record<string, string>) => (labels['com.docker.compose.service'] === 'backend' && labels['com.docker.compose.project'] === 'friendflix' ? [{ id: 'b1', names: [], state: 'running', labels: {} }] : []),
      inspectContainer: async () => ({ Image: image, Config: { Image: 'ghcr.io/letsmanu/friendflix-backend:latest' } }),
      inspectImage: async (ref: string) => (ref === image || ref === TAG ? { id: ref === TAG ? tagId : image, labels: { [PIN_LABEL]: `${J} ${F}` } } : null),
    } as unknown as Engine;
    const asked: string[] = [];
    let tagId = image;
    let verdict = false;
    let t = 0;
    const d = { engine, project: 'friendflix', repo: REPO, verify: async (ref: string) => { asked.push(ref); return verdict; }, now: () => t };
    expect(await readPins(d)).toEqual({ error: 'verify_failed' });
    verdict = true;
    t = 10 * 60_000; // a failed verify of this image is kept 10 min
    const r = await readPins(d);
    expect(r).toMatchObject({ source: image, invalid: [] });
    expect('pins' in r && r.pins.jellyfin?.upstream).toBe('10.11.3');
    await readPins(d);
    expect(asked).toEqual(Array(2).fill('ghcr.io/letsmanu/friendflix-backend:latest'));
    image = 'sha256:' + '2'.repeat(64);
    tagId = image;
    expect(await readPins(d)).toMatchObject({ source: image });
    expect(asked).toHaveLength(3);
    // the tag moved on: the verified image is not the running one, nothing is trusted or cached
    image = 'sha256:' + '3'.repeat(64);
    tagId = 'sha256:' + '4'.repeat(64);
    expect(await readPins(d)).toEqual({ error: 'verify_failed' });
    tagId = image;
    expect(await readPins(d)).toMatchObject({ source: image });
    expect(await readPins({ ...d, project: 'other' })).toEqual({ error: 'no_backend' });
  });

  it('a failed verify of the same backend image is not run again within 10 min (cosign is slow)', async () => {
    let image = 'sha256:' + '5'.repeat(64);
    const engine = {
      listContainers: async () => [{ id: 'b1', names: [], state: 'running', labels: {} }],
      inspectContainer: async () => ({ Image: image, Config: { Image: 'ghcr.io/letsmanu/friendflix-backend:latest' } }),
      inspectImage: async () => ({ id: image, labels: { [PIN_LABEL]: `${J} ${F}` } }),
    } as unknown as Engine;
    let verifies = 0;
    let t = 0;
    const d = { engine, project: 'friendflix', repo: REPO, verify: async () => { verifies++; return false; }, now: () => t };
    expect(await readPins(d)).toEqual({ error: 'verify_failed' });
    t = 10 * 60_000 - 1;
    expect(await readPins(d)).toEqual({ error: 'verify_failed' });
    expect(verifies).toBe(1);
    t = 10 * 60_000;
    expect(await readPins(d)).toEqual({ error: 'verify_failed' });
    expect(verifies).toBe(2);
    // another backend image is verified at once
    image = 'sha256:' + '6'.repeat(64);
    expect(await readPins(d)).toEqual({ error: 'verify_failed' });
    expect(verifies).toBe(3);
  });
});
