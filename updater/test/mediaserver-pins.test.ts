// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Engine } from '../src/mediaserver/engine.js';
import { PIN_LABEL, parsePinLabel, readPins } from '../src/mediaserver/pins.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const J = `jellyfin=docker.io/jellyfin/jellyfin:10.11.3@sha256:${B}`;
const F = `ferrofin=ghcr.io/letsmanu/friendflix-mediaserver@sha256:${A}`;
const REPO = 'LetsManu/friendflix';

describe('parsePinLabel', () => {
  it('parses both entries', () => {
    const r = parsePinLabel(`${J} ${F}`, REPO);
    expect(r.invalid).toEqual([]);
    expect(r.pins.jellyfin).toEqual({ kind: 'jellyfin', image: `docker.io/jellyfin/jellyfin@sha256:${B}`, digest: `sha256:${B}`, upstream: '10.11.3' });
    expect(r.pins.ferrofin).toEqual({ kind: 'ferrofin', image: `ghcr.io/letsmanu/friendflix-mediaserver@sha256:${A}`, digest: `sha256:${A}`, upstream: null });
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
      inspectImage: async (ref: string) => (ref === image ? { id: image, labels: { [PIN_LABEL]: `${J} ${F}` } } : null),
    } as unknown as Engine;
    const asked: string[] = [];
    let verdict = false;
    const d = { engine, project: 'friendflix', repo: REPO, verify: async (ref: string) => { asked.push(ref); return verdict; } };
    expect(await readPins(d)).toEqual({ error: 'verify_failed' });
    verdict = true;
    const r = await readPins(d);
    expect(r).toMatchObject({ source: image, invalid: [] });
    expect('pins' in r && r.pins.jellyfin?.upstream).toBe('10.11.3');
    await readPins(d);
    expect(asked).toEqual(Array(2).fill('ghcr.io/letsmanu/friendflix-backend:latest'));
    image = 'sha256:' + '2'.repeat(64);
    expect(await readPins(d)).toMatchObject({ source: image });
    expect(asked).toHaveLength(3);
    expect(await readPins({ ...d, project: 'other' })).toEqual({ error: 'no_backend' });
  });
});
