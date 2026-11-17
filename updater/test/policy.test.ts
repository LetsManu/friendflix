// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FF_SERVICES, HEALTH_SERVICES, channelTag, cosignIdentity, digestRef, expectedImage, isDigest, isOwnDigestRef, isRepo, isTag, parseChannelBody, pinnedRef, shaTag } from '../src/policy.js';

describe('updater policy', () => {
  it('the service whitelist is FriendFlix only', () => {
    expect([...FF_SERVICES]).toEqual(['bootstrap', 'backend', 'gateway', 'web']);
    expect([...HEALTH_SERVICES]).toEqual(['backend', 'gateway', 'web']);
    for (const never of ['postgres', 'redis', 'jellyfin', 'plex', 'requests', 'authentik', 'server', 'docker-proxy']) expect(FF_SERVICES as readonly string[]).not.toContain(never);
  });

  it('tags: only latest, nightly, X.Y.Z and sha-<7 hex>', () => {
    for (const ok of ['latest', 'nightly', '1.2.3', '0.0.0', '10.20.30', 'sha-abc1234']) expect(isTag(ok), ok).toBe(true);
    for (const bad of ['', 'Latest', 'v1.2.3', '1.2', '1.2.3-rc.1', '01.2.3', 'sha-abc123', 'sha-ABC1234', 'sha-abc12345', 'latest;rm -rf /',
      '1.2.3\n', '../x', 'nightly ', '$(id)', 'edge', 123, null]) expect(isTag(bad), String(bad)).toBe(false);
  });

  it('channel -> tag', () => {
    expect(channelTag('stable')).toBe('latest');
    expect(channelTag('nightly')).toBe('nightly');
    expect(channelTag('pinned', '1.4.2')).toBe('1.4.2');
    expect(channelTag('pinned', 'latest')).toBeNull();
    expect(channelTag('pinned', null)).toBeNull();
    expect(shaTag('a'.repeat(40))).toBe('sha-aaaaaaa');
    expect(shaTag('dev')).toBeNull();
    expect(shaTag(undefined)).toBeNull();
  });

  it('channel body: exactly the known shapes, never a free-form tag', () => {
    expect(parseChannelBody({ channel: 'stable' })).toEqual({ channel: 'stable', version: null });
    expect(parseChannelBody({ channel: 'nightly' })).toEqual({ channel: 'nightly', version: null });
    expect(parseChannelBody({ channel: 'pinned', version: '1.2.3' })).toEqual({ channel: 'pinned', version: '1.2.3' });
    for (const bad of [null, [], 'stable', {}, { channel: 'edge' }, { channel: 'stable', version: '1.2.3' }, { channel: 'pinned' },
      { channel: 'pinned', version: 'sha-abc1234' }, { channel: 'pinned', version: 'latest' }, { channel: 'stable', tag: 'evil' },
      { channel: 'stable', service: 'postgres' }, { channel: 'pinned', version: '1.2.3', image: 'evil/x' }]) expect(parseChannelBody(bad), JSON.stringify(bad)).toBeNull();
  });

  it('expected image names follow the repository (lowercase, like publish.yml); bootstrap runs the backend image', () => {
    expect(expectedImage('LetsManu/friendflix', 'backend', 'latest')).toBe('ghcr.io/letsmanu/friendflix-backend:latest');
    expect(expectedImage('LetsManu/friendflix', 'bootstrap', '1.2.3')).toBe('ghcr.io/letsmanu/friendflix-backend:1.2.3');
    expect(expectedImage('Bob/FriendFlix-Plex', 'web', 'nightly')).toBe('ghcr.io/bob/friendflix-plex-web:nightly');
    expect(isRepo('LetsManu/friendflix')).toBe(true);
    for (const bad of ['', 'a', 'a/b/c', '../x', 'a/..', 'a b/c', 'a/b;c']) expect(isRepo(bad), bad).toBe(false);
  });

  it('cosign identity: publish.yml of this repo on main or a release tag only', () => {
    const { identityRegexp, issuer } = cosignIdentity('LetsManu/friendflix');
    expect(issuer).toBe('https://token.actions.githubusercontent.com');
    const re = new RegExp(identityRegexp);
    expect(re.test('https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/heads/main')).toBe(true);
    expect(re.test('https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/tags/v1.2.3')).toBe(true);
    for (const bad of [
      'https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/heads/feature',
      'https://github.com/LetsManu/friendflix/.github/workflows/ci.yml@refs/heads/main',
      'https://github.com/evil/friendflix/.github/workflows/publish.yml@refs/heads/main',
      'https://github.com/LetsManuXfriendflix/.github/workflows/publish.yml@refs/heads/main',
      'https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/tags/v1.2.3-evil',
      'https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/pull/1/merge',
    ]) expect(re.test(bad), bad).toBe(false);
  });

  it('pinned ref: only the expected repository with a sha256 digest', () => {
    const img = 'ghcr.io/letsmanu/friendflix-backend:latest';
    const d = 'sha256:' + 'b'.repeat(64);
    expect(pinnedRef(img, [`ghcr.io/evil/friendflix-backend@${d}`, `ghcr.io/letsmanu/friendflix-backend@${d}`])).toBe(`ghcr.io/letsmanu/friendflix-backend@${d}`);
    expect(pinnedRef(img, [`ghcr.io/evil/friendflix-backend@${d}`])).toBeNull();
    expect(pinnedRef(img, ['ghcr.io/letsmanu/friendflix-backend@sha256:short'])).toBeNull();
    expect(pinnedRef(img, [])).toBeNull();
  });

  it('digests: sha256 with 64 lowercase hex only', () => {
    expect(isDigest('sha256:' + 'a'.repeat(64))).toBe(true);
    for (const bad of ['', 'sha256:' + 'a'.repeat(63), 'sha256:' + 'A'.repeat(64), 'sha512:' + 'a'.repeat(64), 'sha256:' + 'a'.repeat(64) + '\n', ` sha256:${'a'.repeat(64)}`, null, 1])
      expect(isDigest(bad), String(bad)).toBe(false);
  });

  it('digest refs: this repository\'s image of the service, lowercase, with a valid digest only', () => {
    const d = 'sha256:' + 'b'.repeat(64);
    expect(digestRef('Example/FriendFlix', 'web', d)).toBe(`ghcr.io/example/friendflix-web@${d}`);
    expect(digestRef('example/friendflix', 'bootstrap', d)).toBe(`ghcr.io/example/friendflix-backend@${d}`);
    expect(digestRef('example/friendflix', 'livetv', d)).toBe(`ghcr.io/example/friendflix-livetv@${d}`);
    expect(() => digestRef('example/friendflix', 'web', 'sha256:short')).toThrow();
    expect(() => digestRef('example/friendflix', 'web', `${d}:latest`)).toThrow();
    for (const svc of ['postgres', 'mediaserver', 'constructor', '__proto__', 'toString']) expect(() => digestRef('example/friendflix', svc, d), svc).toThrow();
    expect(isOwnDigestRef('example/friendflix', 'web', `ghcr.io/example/friendflix-web@${d}`)).toBe(true);
    expect(isOwnDigestRef('Example/FriendFlix', 'backend', `ghcr.io/example/friendflix-backend@${d}`)).toBe(true);
    expect(isOwnDigestRef('example/friendflix', 'bootstrap', `ghcr.io/example/friendflix-backend@${d}`)).toBe(true);
    for (const [svc, ref] of [
      ['web', `ghcr.io/evil/friendflix-web@${d}`], ['web', 'ghcr.io/example/friendflix-web:latest'], ['web', `ghcr.io/example/friendflix-backend@${d}`],
      ['web', `ghcr.io/example/friendflix-web@sha256:${'B'.repeat(64)}`], ['web', `ghcr.io/example/friendflix-web:latest@${d}`], ['web', `docker.io/example/friendflix-web@${d}`],
      ['postgres', `ghcr.io/example/friendflix-postgres@${d}`], ['constructor', `ghcr.io/example/friendflix-web@${d}`], ['web', ''], ['web', null],
    ] as const) expect(isOwnDigestRef('example/friendflix', svc, ref as string), `${svc} ${ref}`).toBe(false);
  });
});
