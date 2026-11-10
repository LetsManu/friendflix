// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseClientCaps } from '../src/media/clientCaps.js';
import { applyGate, jellyfinRanges, planStream, SURROUND_BUDGET, type PlanInput, type SourceFacts } from '../src/media/streamplan.js';
import { sourceFacts, toPlaybackDto } from '../src/jellyfin/dto.js';

const caps = (hls: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => parseClientCaps({
  client: 'web', appVersion: '3.3.0', containers: ['mp4'], video: [{ codec: 'h264' }, { codec: 'hevc', maxHeight: 2160, profiles: ['main', 'main 10'], tags: ['hvc1'] }],
  audio: ['aac', 'mp3', 'ac3', 'eac3'], subtitles: ['vtt'], ranges: ['sdr'], ...(hls ? { hls } : {}), ...over,
});
const HEVC_DEVICE = { video: ['h264', 'hevc'], audio: ['aac', 'mp3'], surround: [] };
const SURROUND_DEVICE = { video: ['h264', 'hevc'], audio: ['aac', 'mp3', 'eac3', 'ac3'], surround: ['eac3'] };

const stereoAac = { codec: 'aac', channels: 2, bitrate: 160_000 };
const wrenfield: SourceFacts = { videoCodec: 'hevc', videoBitrate: 5_000_000, height: 1080, width: 1920, range: 'SDR', profile: 'Main', audio: stereoAac };
const brindlemarsh: SourceFacts = { videoCodec: 'hevc', videoBitrate: 40_000_000, height: 2160, width: 3840, range: 'HDR10', profile: 'Main 10', audio: { codec: 'eac3', channels: 6, bitrate: 640_000 } };

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  caps: caps(HEVC_DEVICE), cast: false, remote: false, maxBitrate: 120_000_000, boxHeight: 1080, src: wrenfield, surroundOn: true, hevcStreams: 2, ...over,
});

/** a Jellyfin PlaybackInfo answer for a source with these streams, turned into the answer's HLS query */
const jfSource = (video: Record<string, unknown>, audio: Record<string, unknown>, container = 'mp4') => ({
  PlaySessionId: 'ps-12345678',
  MediaSources: [{ Id: 'ms1', Container: container, Bitrate: 9_000_000, MediaStreams: [{ Index: 0, Type: 'Video', ...video }, { Index: 1, Type: 'Audio', IsDefault: true, ...audio }] }],
});
const dto = (info: ReturnType<typeof jfSource>, maxBitrate: number, plan?: ReturnType<typeof planStream>) =>
  toPlaybackDto({ itemId: 'a'.repeat(32), info, deviceId: 'ff-d1', maxBitrate, resumeTicks: 0, plan });
const query = (d: { hlsUrl: string }) => new URLSearchParams(d.hlsUrl.slice(d.hlsUrl.indexOf('?') + 1));

describe('planStream: a device that states nothing', () => {
  it('no hls block: today\'s values exactly (ts, h264, aac,mp3, 2 channels, 192 kbit/s)', () => {
    for (const c of [null, caps(undefined)]) {
      const p = planStream(input({ caps: c }));
      expect([p.segment, p.videoCodecs, p.audioCodecs, p.audioChannels, p.audioBitrate, p.wantsHevcEncode, p.codecParams]).toEqual(['ts', ['h264'], ['aac', 'mp3'], 2, 192_000, false, {}]);
    }
    expect(planStream(input({ caps: null, cast: true })).audioCodecs).toEqual(['aac']); // cast without cast caps: today's cast list
  });
  it('toPlaybackDto without a plan or caps builds today\'s HLS URL byte for byte', () => {
    const d = dto(jfSource({ Codec: 'h264', Height: 1080, Width: 1920, BitRate: 6_000_000 }, { Codec: 'aac', Channels: 2 }), 8_000_000);
    expect(d.hlsUrl).toBe('/media/Videos/' + 'a'.repeat(32) + '/master.m3u8?MediaSourceId=ms1&PlaySessionId=ps-12345678&DeviceId=ff-d1&VideoCodec=h264&AudioCodec=aac%2Cmp3&SegmentContainer=ts&MinSegments=1&BreakOnNonKeyFrames=false&TranscodingMaxAudioChannels=2&MaxStreamingBitrate=8000000&AudioBitrate=192000&AudioChannels=2&VideoBitrate=7808000&MaxHeight=1080&MaxWidth=1920');
    expect(d.delivery).toMatchObject({ video: 'copy', videoCodec: 'h264', why: ['stereo_device'] });
    const cast = toPlaybackDto({ itemId: 'a'.repeat(32), info: jfSource({ Codec: 'h264', Height: 1080 }, { Codec: 'aac', Channels: 2 }), deviceId: 'ff-d1', maxBitrate: 4_000_000, resumeTicks: 0, cast: true });
    expect(cast.hlsUrl).toBe('/media/Videos/' + 'a'.repeat(32) + '/master.m3u8?MediaSourceId=ms1&PlaySessionId=ps-12345678&DeviceId=ff-d1&VideoCodec=h264&AudioCodec=aac&SegmentContainer=ts&MinSegments=1&BreakOnNonKeyFrames=false&TranscodingMaxAudioChannels=2&MaxStreamingBitrate=4000000&AudioBitrate=192000&AudioChannels=2&VideoBitrate=3808000&MaxHeight=720&MaxWidth=1280&Level=41&MaxVideoBitDepth=8&RequireAvc=true&EnableTrickplay=false');
    const q = query(cast);
    expect([q.get('AudioCodec'), q.get('SegmentContainer'), q.get('Level'), q.get('MaxVideoBitDepth'), q.get('RequireAvc'), q.get('EnableTrickplay'), q.has('EnableAdaptiveBitrateStreaming')]).toEqual(['aac', 'ts', '41', '8', 'true', 'false', false]);
  });
});

describe('planStream: HEVC', () => {
  it('Wrenfield Pier (HEVC SDR, 5 Mbit/s) at home: remux in fMP4, no conversion', () => {
    const p = planStream(input());
    expect(p).toMatchObject({ segment: 'mp4', videoCodecs: ['h264', 'hevc'], wantsHevcEncode: false });
    expect(p.delivery).toMatchObject({ video: 'copy', videoCodec: 'hevc' });
    expect(p.delivery.why).toContain('hevc_device');
    const d = dto(jfSource({ Codec: 'hevc', Height: 1080, Width: 1920, BitRate: 5_000_000, Profile: 'Main' }, { Codec: 'aac', Channels: 2 }, 'matroska,webm'), 120_000_000, p);
    expect(query(d).get('SegmentContainer')).toBe('mp4');
    expect(query(d).get('EnableAdaptiveBitrateStreaming')).toBe('false');
    expect(query(d).get('VideoCodec')).toBe('h264,hevc');
    expect(d.delivery).toEqual(p.delivery);
  });
  it('remote with a 4 Mbit/s cap wants a conversion; the gate decides', () => {
    const p = planStream(input({ remote: true, maxBitrate: 4_000_000, boxHeight: 720 }));
    expect(p.wantsHevcEncode).toBe(true);
    expect(p.segment).toBe('mp4');
    expect(p.videoCodecs).toEqual(['h264', 'hevc']);
    expect(p.delivery.why).toContain('h264_unproven'); // never claimed before the gate says yes
    const ok = applyGate(p, { ok: true });
    expect([ok.videoCodecs, ok.delivery.video, ok.delivery.videoCodec, ok.delivery.why]).toEqual([['hevc', 'h264'], 'hevc', 'hevc', ['hevc_upload', 'stereo_device']]);
    const busy = applyGate(p, { ok: false, why: 'h264_busy' });
    expect([busy.videoCodecs, busy.delivery.video, busy.delivery.why[0]]).toEqual([['h264', 'hevc'], 'h264', 'h264_busy']);
    expect(applyGate(planStream(input()), { ok: true })).toEqual(planStream(input())); // no encode wanted: nothing changes
  });
  it('a refused conversion of an H.264 source falls back to ts (nothing else needs fMP4)', () => {
    const h264 = { ...wrenfield, videoCodec: 'h264', profile: 'High', videoBitrate: 20_000_000 };
    const p = planStream(input({ remote: true, maxBitrate: 8_000_000, src: h264 }));
    expect([p.wantsHevcEncode, p.segment]).toEqual([true, 'mp4']);
    const refused = applyGate(p, { ok: false, why: 'h264_off' });
    expect([refused.segment, refused.delivery.why[0]]).toEqual(['ts', 'h264_off']);
  });
  it('a viewer at home never gets a conversion (h264_home); HEVC_STREAMS 0 reads h264_off', () => {
    const big = { ...wrenfield, videoBitrate: 30_000_000 };
    const home = planStream(input({ maxBitrate: 20_000_000, src: big }));
    expect([home.wantsHevcEncode, home.delivery.video, home.delivery.why[0]]).toEqual([false, 'h264', 'h264_home']);
    const off = planStream(input({ remote: true, maxBitrate: 20_000_000, src: big, hevcStreams: 0 }));
    expect([off.wantsHevcEncode, off.delivery.why[0]]).toEqual([false, 'h264_off']);
  });
  it('a device without HEVC in its hls claim gets H.264 (h264_device) and no HEVC list', () => {
    const p = planStream(input({ caps: caps({ video: ['h264'], audio: ['aac'], surround: [] }), remote: true, maxBitrate: 4_000_000 }));
    expect([p.videoCodecs, p.wantsHevcEncode, p.delivery.why[0], p.segment]).toEqual([['h264'], false, 'h264_device', 'ts']);
  });
  it('Brindlemarsh (HDR10 Main 10) on an SDR-only device: no HEVC encode, h264_hdr, the range goes to the server', () => {
    const p = planStream(input({ remote: true, maxBitrate: 8_000_000, src: brindlemarsh }));
    expect(p.wantsHevcEncode).toBe(false);
    expect(p.delivery).toMatchObject({ video: 'h264', videoCodec: 'h264' });
    expect(p.delivery.why[0]).toBe('h264_hdr');
    expect(p.codecParams['hevc-rangetype']).toBe(jellyfinRanges(['sdr']));
    const hdrDevice = planStream(input({ boxHeight: 2160, caps: caps(HEVC_DEVICE, { ranges: ['hdr10'] }), src: { ...brindlemarsh, videoBitrate: 30_000_000 } }));
    expect(hdrDevice.delivery.video).toBe('copy');
    expect(hdrDevice.codecParams['hevc-rangetype']).toBe('SDR|DOVIWithSDR|HDR10|DOVIWithHDR10');
  });
  it('the codec parameters come from the device', () => {
    const p = planStream(input());
    expect(p.codecParams).toMatchObject({ 'hevc-codectag': 'hvc1', 'hevc-profile': 'main,main10' });
    const both = planStream(input({ caps: caps(HEVC_DEVICE, { video: [{ codec: 'h264' }, { codec: 'hevc', profiles: ['main'], tags: ['hvc1', 'hev1'] }] }) }));
    expect(both.codecParams).toMatchObject({ 'hevc-codectag': 'hvc1,hev1', 'hevc-profile': 'main' });
    const url = query(dto(jfSource({ Codec: 'hevc', Height: 1080, Width: 1920, BitRate: 5_000_000 }, { Codec: 'aac', Channels: 2 }), 60_000_000, p));
    expect([url.get('hevc-codectag'), url.get('hevc-profile'), url.get('hevc-rangetype')]).toEqual(['hvc1', 'main,main10', 'SDR|DOVIWithSDR']);
  });
  it('a 10-bit source on a device that claims only Main is not copied', () => {
    const p = planStream(input({ caps: caps(HEVC_DEVICE, { video: [{ codec: 'h264' }, { codec: 'hevc', profiles: ['main'] }] }), src: { ...wrenfield, profile: 'Main 10' } }));
    expect(p.delivery.video).toBe('h264');
  });
  it('an unknown source video bitrate is never predicted as a copy (the server refuses it too)', () => {
    expect(planStream(input({ src: { ...wrenfield, videoBitrate: undefined } })).delivery.video).toBe('h264');
  });
  it('cast with an hls claim qualifies the H.264 limits so HEVC can still be copied', () => {
    const p = planStream(input({ cast: true }));
    const q = query(toPlaybackDto({ itemId: 'a'.repeat(32), info: jfSource({ Codec: 'hevc', Height: 1080, Width: 1920, BitRate: 5_000_000 }, { Codec: 'aac', Channels: 2 }), deviceId: 'd', maxBitrate: 20_000_000, resumeTicks: 0, cast: true, plan: p }));
    expect([q.get('Level'), q.get('MaxVideoBitDepth'), q.get('h264-level'), q.get('h264-videobitdepth')]).toEqual([null, null, '41', '8']);
  });
});

describe('planStream: audio', () => {
  const surroundCaps = () => caps(SURROUND_DEVICE, { audioChannels: 6 });
  const eac3 = { codec: 'eac3', channels: 6, bitrate: 640_000 };
  it('EAC3 5.1 at 8 Mbit/s: copied, the list starts with eac3, 6 channels, the budget comes out of the cap', () => {
    const p = planStream(input({ caps: surroundCaps(), maxBitrate: 8_000_000, src: { ...wrenfield, audio: eac3 } }));
    expect(p.audioCodecs[0]).toBe('eac3');
    expect([p.audioChannels, p.audioBitrate, p.segment]).toEqual([6, 640_000, 'mp4']);
    expect(p.delivery).toMatchObject({ audio: 'copy', audioCodec: 'eac3', channels: 6 });
    expect(p.delivery.why).toContain('surround_device');
    const q = query(dto(jfSource({ Codec: 'hevc', Height: 1080, Width: 1920, BitRate: 5_000_000 }, { Codec: 'eac3', Channels: 6, BitRate: 640_000 }), 8_000_000, p));
    expect([q.get('TranscodingMaxAudioChannels'), q.get('AudioChannels'), q.get('AudioBitrate'), q.get('VideoBitrate')]).toEqual(['6', '6', '640000', String(8_000_000 - 640_000)]);
    expect(q.get('AudioCodec')?.startsWith('eac3')).toBe(true);
  });
  it('a copied track above the budget sends its own bitrate, so the server accepts the copy', () => {
    const p = planStream(input({ caps: surroundCaps(), maxBitrate: 12_000_000, src: { ...wrenfield, audio: { ...eac3, bitrate: 768_000 } } }));
    expect([p.delivery.audio, p.audioBitrate]).toEqual(['copy', 768_000]);
  });
  it('TrueHD 7.1 is converted to eac3 5.1', () => {
    const p = planStream(input({ caps: surroundCaps(), maxBitrate: 8_000_000, src: { ...wrenfield, audio: { codec: 'truehd', channels: 8 } } }));
    expect(p.delivery).toMatchObject({ audio: 'surround', audioCodec: 'eac3', channels: 6 });
    expect([p.audioChannels, p.audioBitrate]).toEqual([6, SURROUND_BUDGET.eac3]);
  });
  it('AAC-only surround devices convert to AAC 5.1 with the smaller budget', () => {
    const p = planStream(input({ caps: caps({ video: ['h264'], audio: ['aac'], surround: ['aac'] }, { audioChannels: 6 }), maxBitrate: 8_000_000, src: { ...wrenfield, audio: { codec: 'dts', channels: 6 } } }));
    expect([p.delivery.audio, p.delivery.audioCodec, p.audioBitrate]).toEqual(['surround', 'aac', 384_000]);
  });
  it('below 4 Mbit/s: stereo_bitrate; switched off: stereo_off; stereo track: stereo_source with the codec copied', () => {
    const base = { caps: surroundCaps(), src: { ...wrenfield, audio: eac3 } };
    const low = planStream(input({ ...base, maxBitrate: 1_500_000, boxHeight: 480 }));
    expect([low.delivery.audio, low.delivery.why.at(-1), low.audioChannels]).toEqual(['stereo', 'stereo_bitrate', 2]);
    const off = planStream(input({ ...base, maxBitrate: 8_000_000, surroundOn: false }));
    expect([off.delivery.audio, off.delivery.why.at(-1), off.audioChannels]).toEqual(['stereo', 'stereo_off', 2]);
    const night = planStream(input({ caps: surroundCaps(), maxBitrate: 8_000_000, src: { ...wrenfield, audio: { codec: 'aac', channels: 2, bitrate: 128_000 } } }));
    expect(night.delivery).toMatchObject({ audio: 'copy', audioCodec: 'aac', channels: 2 });
    expect(night.delivery.why.at(-1)).toBe('stereo_source');
  });
  it('a device that states 2 output channels gets stereo even with a surround claim (stereo_device)', () => {
    const p = planStream(input({ caps: caps(SURROUND_DEVICE, { audioChannels: 2 }), maxBitrate: 8_000_000, src: { ...wrenfield, audio: eac3 } }));
    expect([p.delivery.audio, p.delivery.why.at(-1)]).toEqual(['stereo', 'stereo_device']);
  });
});

describe('planStream: mp3 only where the plan stays on TS', () => {
  const mp3Src: SourceFacts = { ...wrenfield, audio: { codec: 'mp3', channels: 2, bitrate: 128_000 } };
  it('H.264 copy / convert on TS: mp3 listed and copied', () => {
    const p = planStream(input({ src: { ...mp3Src, videoCodec: 'h264', profile: 'High' } }));
    expect([p.segment, p.audioCodecs, p.delivery.audio, p.delivery.audioCodec]).toEqual(['ts', ['aac', 'mp3'], 'copy', 'mp3']);
  });
  it('an HEVC copy plan (fMP4): aac only, the mp3 track is converted', () => {
    const p = planStream(input({ src: mp3Src }));
    expect([p.segment, p.keepMp4, p.audioCodecs, p.delivery.audio, p.delivery.audioCodec]).toEqual(['mp4', true, ['aac'], 'stereo', 'aac']);
  });
  it('an HEVC encode plan (fMP4): aac only', () => {
    const p = planStream(input({ remote: true, maxBitrate: 8_000_000, src: { ...brindlemarsh, range: 'SDR', profile: 'Main', audio: { codec: 'mp3', channels: 2, bitrate: 128_000 } } }));
    expect(p.wantsHevcEncode).toBe(true);
    expect([p.segment, p.audioCodecs, p.delivery.audioCodec]).toEqual(['mp4', ['aac'], 'aac']);
  });
  it('no hls block keeps aac,mp3 (byte-identical fallback)', () => {
    expect(planStream(input({ caps: caps(undefined), src: mp3Src })).audioCodecs).toEqual(['aac', 'mp3']);
  });
});

describe('planStream: only the audio does not fit', () => {
  const viewer = (c: ReturnType<typeof caps>, src: SourceFacts, maxBitrate = 20_000_000) => planStream(input({ caps: c, src, maxBitrate }));
  it('Saltwater Almanac S2 E1 Night Market: H.264 + DTS 5.1 on a stereo browser: the video is copied, only the audio is converted to stereo', () => {
    const src: SourceFacts = { videoCodec: 'h264', videoBitrate: 5_000_000, height: 1080, width: 1920, range: 'SDR', profile: 'High', audio: { codec: 'dts', channels: 6, bitrate: 1_509_000 } };
    const p = viewer(caps({ video: ['h264'], audio: ['aac', 'mp3'], surround: [] }), src);
    expect(p.delivery).toMatchObject({ video: 'copy', videoCodec: 'h264', audio: 'stereo', audioCodec: 'aac', channels: 2 });
    expect(p.delivery.why).toContain('stereo_device');
    expect(p.segment).toBe('ts');
    const q = query(dto(jfSource({ Codec: 'h264', Height: 1080, Width: 1920, BitRate: 5_000_000 }, { Codec: 'dts', Channels: 6, BitRate: 1_509_000 }), 20_000_000, p));
    // nothing in the request forbids copying the video (Jellyfin decides video and audio copy independently: EncodingHelper.CanStreamCopyVideo / CanStreamCopyAudio)
    expect([q.get('AllowVideoStreamCopy'), q.get('VideoCodec'), q.get('AudioCodec'), q.get('TranscodingMaxAudioChannels')]).toEqual([null, 'h264', 'aac,mp3', '2']);
    expect(Number(q.get('VideoBitrate'))).toBeGreaterThanOrEqual(5_000_000);
  });
  it('Dunmoor S1 E5 Wrenfield Pier: HEVC Main + TrueHD 7.1 on an HEVC + surround device: the video is copied, the audio becomes eac3 5.1', () => {
    const src: SourceFacts = { videoCodec: 'hevc', videoBitrate: 12_000_000, height: 1080, width: 1920, range: 'SDR', profile: 'Main', audio: { codec: 'truehd', channels: 8 } };
    const p = viewer(caps(SURROUND_DEVICE, { audioChannels: 6 }), src);
    expect(p.delivery).toMatchObject({ video: 'copy', videoCodec: 'hevc', audio: 'surround', audioCodec: 'eac3', channels: 6 });
    expect(p.delivery.why).toEqual(expect.arrayContaining(['hevc_device', 'surround_device']));
    expect(p.segment).toBe('mp4');
    const q = query(dto(jfSource({ Codec: 'hevc', Height: 1080, Width: 1920, BitRate: 12_000_000, Profile: 'Main' }, { Codec: 'truehd', Channels: 8 }), 20_000_000, p));
    expect([q.get('AllowVideoStreamCopy'), q.get('VideoCodec'), q.get('AudioCodec')?.split(',')[0], q.get('TranscodingMaxAudioChannels'), q.get('VideoBitrate')]).toEqual([null, 'h264,hevc', 'eac3', '6', String(20_000_000 - 640_000)]);
  });
});

describe('sourceFacts', () => {
  it('reads the first video stream and the audio track the stream will carry', () => {
    const src = { MediaStreams: [
      { Index: 0, Type: 'Video', Codec: 'HEVC', BitRate: 5_000_000, Height: 1080, Width: 1920, VideoRangeType: 'SDR', Profile: 'Main' },
      { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, BitRate: 448_000, IsDefault: true },
      { Index: 2, Type: 'Audio', Codec: 'aac', Channels: 2 },
    ] };
    expect(sourceFacts(src)).toEqual({ videoCodec: 'hevc', videoBitrate: 5_000_000, height: 1080, width: 1920, range: 'SDR', profile: 'Main', audio: { codec: 'ac3', channels: 6, bitrate: 448_000 } });
    expect(sourceFacts(src, 2).audio).toEqual({ codec: 'aac', channels: 2 });
    expect(sourceFacts({ MediaStreams: [] })).toMatchObject({ videoCodec: '', height: 0, range: 'Unknown' });
  });
});

describe('planStream: review fixes', () => {
  it('Dolby Vision stays direct play: a dovi range never reaches the HLS plan', () => {
    const p = planStream(input({ caps: caps(HEVC_DEVICE, { ranges: ['sdr', 'hdr10', 'dovi'] }) }));
    expect(p.codecParams['hevc-rangetype']).toBe('SDR|DOVIWithSDR|HDR10|DOVIWithHDR10');
    expect(p.codecParams['hevc-rangetype']!.split('|')).not.toContain('DOVI');
    const dovi = planStream(input({ boxHeight: 2160, caps: caps(HEVC_DEVICE, { ranges: ['sdr', 'dovi'] }), src: { ...brindlemarsh, range: 'DOVI', videoBitrate: 30_000_000 } }));
    expect(dovi.delivery.video).toBe('h264');
  });
  it('a device whose hevc entry names no hvc1 tag gets no HEVC stream (the server always writes hvc1)', () => {
    const hev1 = caps(HEVC_DEVICE, { video: [{ codec: 'h264' }, { codec: 'hevc', tags: ['hev1'] }] });
    const p = planStream(input({ caps: hev1, remote: true, maxBitrate: 4_000_000 }));
    expect([p.videoCodecs, p.segment, p.wantsHevcEncode, p.delivery.why[0]]).toEqual([['h264'], 'ts', false, 'h264_device']);
  });
  it('reasons: no "device plays no HEVC" on an HEVC device unless that is the cause', () => {
    expect(planStream(input({ src: { ...wrenfield, videoBitrate: undefined } })).delivery.why).not.toContain('h264_device');
    const vc1 = planStream(input({ src: { ...wrenfield, videoCodec: 'vc1', videoBitrate: 2_000_000 } }));
    expect(vc1.delivery.why).not.toContain('h264_device');
    const h264 = planStream(input({ src: { ...wrenfield, videoCodec: 'h264', profile: 'High' } }));
    expect([h264.delivery.video, h264.delivery.why]).toEqual(['copy', ['stereo_device']]);
    expect(planStream(input({ caps: caps({ video: ['h264'], audio: ['aac'], surround: [] }), src: { ...wrenfield, videoCodec: 'h264', videoBitrate: 200_000_000 } })).delivery.why[0]).toBe('h264_device');
    expect(planStream(input({ src: { ...brindlemarsh, range: 'Unknown' } })).delivery.why).not.toContain('h264_hdr');
  });
  it('the audio track is the one Jellyfin streams without AudioStreamIndex: first by Index with channels, not the IsDefault one', () => {
    const src = { MediaStreams: [
      { Index: 3, Type: 'Audio', Codec: 'aac', Channels: 2, IsDefault: true },
      { Index: 1, Type: 'Audio', Codec: 'eac3', Channels: 6 },
    ] };
    expect(sourceFacts(src).audio).toMatchObject({ codec: 'eac3', channels: 6 });
    expect(sourceFacts(src, 3).audio).toMatchObject({ codec: 'aac' });
  });
  it('a source wider than the box is not predicted as a copy (2048x858 in a 1080 box)', () => {
    expect(planStream(input({ src: { ...wrenfield, width: 2048, height: 858 } })).delivery.video).toBe('h264');
    expect(planStream(input({ src: { ...wrenfield, width: 1920, height: 800 } })).delivery.video).toBe('copy');
    expect(sourceFacts({ MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 2048, Height: 858 }] }).width).toBe(2048);
  });
  it('5.0 / 4.0 sources convert to AAC when it is in the list (Jellyfin shifts ac3 / eac3 behind it below 6 channels)', () => {
    const c = caps({ video: ['h264'], audio: ['aac', 'eac3'], surround: ['eac3', 'aac'] }, { audioChannels: 6 });
    const five = planStream(input({ caps: c, maxBitrate: 8_000_000, src: { ...wrenfield, audio: { codec: 'dts', channels: 5 } } }));
    expect([five.delivery.audioCodec, five.audioBitrate]).toEqual(['aac', 384_000]);
    const six = planStream(input({ caps: c, maxBitrate: 8_000_000, src: { ...wrenfield, audio: { codec: 'dts', channels: 6 } } }));
    expect(six.delivery.audioCodec).toBe('eac3');
  });
  it('plan.videoBitrate is the VideoBitrate parameter', () => {
    const p = planStream(input({ caps: caps(SURROUND_DEVICE, { audioChannels: 6 }), maxBitrate: 8_000_000, src: { ...wrenfield, audio: { codec: 'eac3', channels: 6, bitrate: 640_000 } } }));
    expect(p.videoBitrate).toBe(7_360_000);
    expect(planStream(input({ maxBitrate: 400_000, boxHeight: 360 })).videoBitrate).toBe(300_000);
  });
});
