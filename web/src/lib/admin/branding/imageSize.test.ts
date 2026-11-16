// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readImageSize } from './imageSize';

const bytes = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (w: number, h: number) => bytes(PNG_SIG, be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
const riff = (chunk: string, body: number[]) => bytes('RIFF', le32(4 + 8 + body.length), 'WEBP', chunk, le32(body.length), body);

describe('readImageSize: the size from the header, nothing decoded', () => {
  it('PNG: the IHDR', () => {
    expect(readImageSize(png(1000, 600))).toEqual({ type: 'png', width: 1000, height: 600 });
    expect(readImageSize(png(50_000, 1))).toEqual({ type: 'png', width: 50_000, height: 1 });
    expect(readImageSize(png(0x80000001, 1))!.width).toBe(0x80000001); // unsigned
  });
  it('PNG: cut short or without IHDR first', () => {
    expect(readImageSize(png(10, 10).subarray(0, 20))).toBeNull();
    expect(readImageSize(bytes(PNG_SIG, be32(13), 'IDAT', be32(1), be32(1)))).toBeNull();
  });
  it('WebP VP8X: the canvas (24-bit, minus one)', () => {
    expect(readImageSize(riff('VP8X', [0x10, 0, 0, 0, ...le24(2559), ...le24(1599)]))).toEqual({ type: 'webp', width: 2560, height: 1600 });
    expect(readImageSize(riff('VP8X', [0, 0, 0, 0, ...le24(15_999), ...le24(0)]))).toEqual({ type: 'webp', width: 16_000, height: 1 });
  });
  it('WebP VP8L: 14-bit sizes after the 0x2f signature', () => {
    const bits = (w: number, h: number) => le32(((w - 1) | ((h - 1) << 14)) >>> 0);
    expect(readImageSize(riff('VP8L', [0x2f, ...bits(512, 512), 0, 0, 0, 0, 0]))).toEqual({ type: 'webp', width: 512, height: 512 });
    expect(readImageSize(riff('VP8L', [0x2f, ...bits(16_384, 3), 0, 0, 0, 0, 0]))).toEqual({ type: 'webp', width: 16_384, height: 3 });
    expect(readImageSize(riff('VP8L', [0x00, ...bits(10, 10), 0, 0, 0, 0, 0]))).toBeNull();
  });
  it('WebP VP8: the key frame after its start code (scale bits ignored)', () => {
    expect(readImageSize(riff('VP8 ', [0x50, 0x2a, 0x00, 0x9d, 0x01, 0x2a, ...le16(2048), ...le16(512 | 0x4000), 0, 0]))).toEqual({ type: 'webp', width: 2048, height: 512 });
    expect(readImageSize(riff('VP8 ', [0x50, 0x2a, 0x00, 0x00, 0x00, 0x00, ...le16(10), ...le16(10), 0, 0]))).toBeNull();
    expect(readImageSize(riff('ALPH', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
  it('JPEG: the segments are walked to the frame header (APPn, DQT and DHT skipped, fill bytes allowed)', () => {
    const app0 = [0xff, 0xe0, ...be16(16), ...'JFIF\0'.split('').map((c) => c.charCodeAt(0)), 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const exif = [0xff, 0xe1, ...be16(2 + 300), ...new Array(300).fill(0)];
    const dqt = [0xff, 0xdb, ...be16(67), ...new Array(65).fill(1)];
    const dht = [0xff, 0xc4, ...be16(4), 0, 0];
    const sof = (m: number, w: number, h: number) => [0xff, m, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    expect(readImageSize(bytes([0xff, 0xd8], app0, exif, dqt, dht, sof(0xc0, 1000, 600)))).toEqual({ type: 'jpeg', width: 1000, height: 600 });
    expect(readImageSize(bytes([0xff, 0xd8], app0, [0xff], sof(0xc2, 13_000, 20)))).toEqual({ type: 'jpeg', width: 13_000, height: 20 }); // progressive, a fill byte
    // the scan before any frame header, a broken marker, a header cut short
    expect(readImageSize(bytes([0xff, 0xd8], app0, [0xff, 0xda, 0, 8]))).toBeNull();
    expect(readImageSize(bytes([0xff, 0xd8], [0x12, 0x34, 0, 4]))).toBeNull();
    expect(readImageSize(bytes([0xff, 0xd8], app0, [0xff, 0xc0, 0, 17, 8]))).toBeNull();
    expect(readImageSize(bytes([0xff, 0xd8], [0xff, 0xe0, 0, 1, 0, 0]))).toBeNull();
  });
  it('anything else: null', () => {
    expect(readImageSize(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(readImageSize(bytes('GIF89a', [1, 0, 1, 0]))).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
  });
});
