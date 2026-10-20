// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseClientCaps } from '../src/media/clientCaps.js';
import { MIN_ANDROID, parseSemver } from '../src/version.js';
import { authOrigin } from '../src/oidc.js';
import { makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
const caps = (over: Record<string, unknown> = {}) => ({
  client: 'android', appVersion: '2.0.0', containers: ['mp4', 'mkv'], video: [{ codec: 'h264' }, { codec: 'hevc', maxHeight: 2160, profiles: ['main', 'main 10'] }],
  audio: ['aac', 'eac3'], subtitles: ['srt', 'ass'], ...over,
});

describe('parseClientCaps', () => {
  it('accepts a valid android block', () => {
    expect(parseClientCaps(caps())).toEqual({
      client: 'android', appVersion: '2.0.0', containers: ['mp4', 'mkv'],
      video: [{ codec: 'h264' }, { codec: 'hevc', maxHeight: 2160, profiles: ['main', 'main 10'] }], audio: ['aac', 'eac3'], subtitles: ['srt', 'ass'],
    });
  });
  it('ignores any other client, malformed shapes and non-strict versions', () => {
    for (const bad of [undefined, null, 'x', 5, [], caps({ client: 'ios' }), caps({ client: undefined }), caps({ appVersion: 'v2.0.0' }), caps({ appVersion: '2.0' }), caps({ appVersion: '2.0.0-beta' }),
      caps({ appVersion: 2 }), caps({ appVersion: `1.${'0'.repeat(40)}.0` }), caps({ containers: 'mp4' }), caps({ video: {} }), caps({ audio: undefined }), caps({ subtitles: null })]) expect(parseClientCaps(bad)).toBeNull();
  });
  it('oversized lists make the whole block invalid', () => {
    const many = Array.from({ length: 17 }, () => 'aac');
    for (const k of ['containers', 'audio', 'subtitles']) expect(parseClientCaps(caps({ [k]: many }))).toBeNull();
    expect(parseClientCaps(caps({ video: Array.from({ length: 17 }, () => ({ codec: 'h264' })) }))).toBeNull();
    expect(parseClientCaps(caps({ audio: many.slice(0, 16) }))).not.toBeNull();
  });
  it('drops unknown or hostile values, normalizes case and removes duplicates', () => {
    const c = parseClientCaps(caps({
      containers: ['MP4', 'mp4', '<script>', 7, 'avi'], audio: ['AAC', '"; drop', null], subtitles: ['SRT', 'x'],
      video: [{ codec: '<script>' }, { codec: 'HEVC', maxHeight: 0, profiles: ['Main 10', '<b>', 5, 'x'.repeat(40)] }, { codec: 'hevc' }, 'h264', null, { codec: 'av1', maxHeight: 1.5 }],
    }))!;
    expect(c.containers).toEqual(['mp4']);
    expect(c.audio).toEqual(['aac']);
    expect(c.subtitles).toEqual(['srt']);
    expect(c.video).toEqual([{ codec: 'hevc', profiles: ['main 10'] }, { codec: 'av1' }]);
    expect(JSON.stringify(c)).not.toContain('<');
  });
  it('a block with nothing usable left is null; an out-of-range height is dropped, not the block', () => {
    expect(parseClientCaps(caps({ containers: ['x'], video: [{ codec: 'x' }], audio: [] }))).toBeNull();
    expect(parseClientCaps(caps({ video: [{ codec: 'h264', maxHeight: 99999 }] }))!.video).toEqual([{ codec: 'h264' }]);
  });
});

describe('/api/version', () => {
  it('minAndroid is a strict x.y.z next to the version constant', () => {
    expect(MIN_ANDROID).toBe('2.0.0');
    expect(parseSemver(MIN_ANDROID)).toEqual([2, 0, 0]);
  });
  it('authOrigin is the OIDC issuer origin, or null without an external sign-in page', () => {
    const app = 'https://friend.example.com';
    expect(authOrigin({ OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/', PUBLIC_URL: app })).toBe('https://auth.example.com');
    expect(authOrigin({ OIDC_ISSUER: 'https://auth.example.com:8443/application/o/ff/', PUBLIC_URL: app })).toBe('https://auth.example.com:8443');
    expect(authOrigin({ OIDC_ISSUER: '', PUBLIC_URL: app })).toBeNull();
    expect(authOrigin({ OIDC_ISSUER: 'not a url', PUBLIC_URL: app })).toBeNull();
    expect(authOrigin({ OIDC_ISSUER: 'https://friend.example.com/application/o/ff/', PUBLIC_URL: app })).toBeNull();
    expect(authOrigin({ OIDC_ISSUER: 'https://auth.example.com/', PUBLIC_URL: '' })).toBe('https://auth.example.com');
  });
});

let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
let src: { Container: string; Height: number };
let profiles: any[] = [];
let queries: string[] = [];

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': () => ({ json: { Items: [{ Id: ID, Name: 'Film', Type: 'Movie' }], TotalRecordCount: 1 } }),
    'POST /Items/[^/]+/PlaybackInfo': (u, _i, body) => {
      profiles.push(body.DeviceProfile); queries.push(u.search);
      return { json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: 'ms1', Container: src.Container, SupportsDirectPlay: true, Bitrate: 6_000_000, RunTimeTicks: 1e9,
        MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'hevc', Height: src.Height }] }] } };
    },
  });
  s = await env.login();
});
afterAll(() => env.close());
beforeEach(() => { profiles = []; queries = []; src = { Container: 'mkv', Height: 2160 }; });

const info = (extra: Record<string, unknown> = {}) =>
  env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { itemId: ID, ...extra } });

describe('POST /api/playback/info with a capability block', () => {
  it('no caps: the Jellyfin DeviceProfile is exactly the browser profile of today (snapshot)', async () => {
    expect((await info()).statusCode).toBe(200);
    expect(profiles[0]).toEqual({
      Name: 'FriendFlix Web', MaxStreamingBitrate: 60_000_000, CodecProfiles: [],
      DirectPlayProfiles: [{ Container: 'mp4,m4v,webm', Type: 'Video', VideoCodec: 'h264,vp9,av1', AudioCodec: 'aac,mp3,opus,flac' }],
      TranscodingProfiles: [{ Container: 'ts', Type: 'Video', AudioCodec: 'aac,mp3', VideoCodec: 'h264', Protocol: 'hls', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true }],
      SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }, { Format: 'srt', Method: 'External' }, { Format: 'ass', Method: 'External' }],
    });
  });
  it('invalid or foreign caps behave exactly like no caps (profile, query and answer)', async () => {
    const base = await info();
    const baseProfile = profiles[0], baseQuery = queries[0];
    for (const bad of [caps({ client: 'ios' }), caps({ audio: Array.from({ length: 17 }, () => 'aac') }), 'junk', 42, { client: 'android' }]) {
      const r = await info({ caps: bad });
      expect(r.statusCode).toBe(200);
      expect(profiles.at(-1)).toEqual(baseProfile);
      expect(queries.at(-1)).toBe(baseQuery);
      expect(r.json().directUrl).toBe(base.json().directUrl);
      expect(r.json().transcodeReason).toBe(base.json().transcodeReason);
    }
  });
  it('valid caps: HEVC and MKV in the direct-play profile, the source plays directly, and the server never sees the raw block', async () => {
    const before = await info();
    expect(before.json().directUrl).toBeUndefined(); // a browser cannot play MKV
    const r = await info({ caps: caps() });
    expect(r.statusCode).toBe(200);
    const p = profiles.at(-1);
    expect(p.Name).toBe('FriendFlix Android');
    expect(p.DirectPlayProfiles).toEqual([{ Container: 'mp4,mkv', Type: 'Video', VideoCodec: 'h264,hevc', AudioCodec: 'aac,eac3' }]);
    expect(p.CodecProfiles).toEqual([{ Type: 'Video', Codec: 'hevc', Conditions: [
      { Condition: 'LessThanEqual', Property: 'Height', Value: '2160', IsRequired: true },
      { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'main|main 10', IsRequired: false },
    ] }]);
    expect(p.TranscodingProfiles).toEqual(profiles[0].TranscodingProfiles); // the HLS fallback is unchanged
    expect(r.json().directUrl).toMatch(/^\/media\/Videos\//);
  });
  it('a container the app did not list still transcodes', async () => {
    src.Container = 'avi';
    const r = await info({ caps: caps() });
    expect(r.json().directUrl).toBeUndefined();
  });
  it('role max height 720 still wins over HEVC 2160 caps: height condition, no direct play', async () => {
    const admin = env.ctx.roles.admin!;
    env.ctx.roles = { ...env.ctx.roles, admin: { ...admin, maxHeight: 720 } };
    try {
      const r = await info({ caps: caps() });
      expect(r.statusCode).toBe(200);
      const p = profiles.at(-1);
      expect(p.DirectPlayProfiles).toEqual([]);
      expect(p.CodecProfiles[0]).toEqual({ Type: 'Video', Conditions: [{ Condition: 'LessThanEqual', Property: 'Height', Value: '720', IsRequired: true }] });
      expect(queries.at(-1)).toContain('MaxHeight=720');
      expect(queries.at(-1)).toContain('EnableDirectPlay=false');
      expect(r.json().directUrl).toBeUndefined();
      expect(r.json().hlsUrl).toContain('MaxHeight=720');
    } finally { env.ctx.roles = { ...env.ctx.roles, admin }; }
  });
  it('the bitrate cap of the role still applies (client maxBitrate cannot raise it)', async () => {
    const r = await info({ caps: caps(), maxBitrate: 200_000_000 });
    expect(profiles.at(-1).MaxStreamingBitrate).toBe(60_000_000);
    expect(r.json().maxBitrate).toBe(60_000_000);
  });
  it('extra subtitle formats are added after the browser ones, nothing else changes', async () => {
    await info({ caps: caps({ subtitles: ['ssa', 'subrip', 'srt'] }) });
    expect(profiles.at(-1).SubtitleProfiles.map((x: any) => x.Format)).toEqual(['vtt', 'srt', 'ass', 'ssa', 'subrip']);
  });
  it('caps with only some lists keep the browser defaults for the rest', async () => {
    await info({ caps: caps({ containers: [], audio: [], video: [{ codec: 'hevc' }] }) });
    expect(profiles.at(-1).DirectPlayProfiles).toEqual([{ Container: 'mp4,m4v,webm', Type: 'Video', VideoCodec: 'hevc', AudioCodec: 'aac,mp3,opus,flac' }]);
    expect(profiles.at(-1).CodecProfiles).toEqual([]);
  });
  it('a matroska container name from the server matches the mkv cap', async () => {
    src.Container = 'matroska,webm';
    expect((await info({ caps: caps() })).json().directUrl).toMatch(/^\/media\/Videos\//);
  });
});

describe('/api/version', () => {
  it('adds minAndroid and keeps the existing fields', async () => {
    const v = (await env.app.inject('/api/version')).json();
    expect(v).toEqual({ sha: expect.any(String), version: expect.any(String), codename: expect.any(String), build: expect.any(String), channel: null, label: expect.any(String), minAndroid: '2.0.0', authOrigin: 'https://auth.example.com' });
  });
});
