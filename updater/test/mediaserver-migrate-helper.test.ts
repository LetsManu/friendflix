// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FFMPEG_DIR } from '../src/mediaserver/template.js';
import { adjustXml, checkAdopted, copySource, main, scanSource } from '../src/mediaHelper.js';

let root: string;
let src: string;
let dst: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-migrate-'));
  src = join(root, 'source');
  dst = join(root, 'data');
  mkdirSync(src);
  mkdirSync(dst);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const SERVER_ID = '0123456789abcdef0123456789abcdef';

function put(base: string, rel: string, body: string | number): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), typeof body === 'number' ? 'x'.repeat(body) : body);
}

const NETWORK = `<?xml version="1.0" encoding="utf-8"?>
<NetworkConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <BaseUrl>/jellyfin</BaseUrl>
  <EnableHttps>true</EnableHttps>
  <RequireHttps>false</RequireHttps>
  <InternalHttpPort>8097</InternalHttpPort>
  <InternalHttpsPort>8920</InternalHttpsPort>
  <PublicHttpPort>8097</PublicHttpPort>
  <LocalNetworkSubnets>
    <string>192.0.2.0/24</string>
  </LocalNetworkSubnets>
</NetworkConfiguration>
`;
const ENCODING = `<?xml version="1.0" encoding="utf-8"?>
<EncodingOptions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <EncodingThreadCount>-1</EncodingThreadCount>
  <TranscodingTempPath>/config/transcodes</TranscodingTempPath>
  <EncoderAppPath>/usr/lib/jellyfin-ffmpeg/ffmpeg</EncoderAppPath>
  <EncoderAppPathDisplay>/usr/lib/jellyfin-ffmpeg/ffmpeg</EncoderAppPathDisplay>
</EncodingOptions>
`;
const SYSTEM = `<?xml version="1.0" encoding="utf-8"?>
<ServerConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <MetadataPath>/srv/jf-metadata</MetadataPath>
  <CachePath />
  <ServerName>Wohnzimmer</ServerName>
</ServerConfiguration>
`;
const libOptions = (savers: string | null, local = false): string => `<?xml version="1.0" encoding="utf-8"?>
<LibraryOptions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <SaveLocalMetadata>${local}</SaveLocalMetadata>
${savers === null ? '' : `  <MetadataSavers>${savers}</MetadataSavers>\n`}  <PathInfos>
    <MediaPathInfo>
      <Path>/movies</Path>
    </MediaPathInfo>
  </PathInfos>
</LibraryOptions>
`;

/**
 * a Jellyfin /config tree; returns the sizes of what is copied (without trickplay) and of trickplay. `program` is Jellyfin's
 * data dir below /config ('' official, 'data' linuxserver), `config` its config dir ('config' official, '' linuxserver).
 */
function jellyfin(layout: 'official' | 'linuxserver', o: { nfo?: boolean } = {}): { bytes: number; trickplay: number } {
  const p = layout === 'official' ? '' : 'data/';
  const c = layout === 'official' ? 'config/' : '';
  const copied: [string, string | number][] = [
    [`${p}data/jellyfin.db`, 4000],
    [`${p}data/jellyfin.db-wal`, 300],
    [`${p}data/device.txt`, `${SERVER_ID}\n`],
    [`${p}data/playlists/Abend/playlist.xml`, 120],
    [`${p}data/collections/Reihe [boxset]/collection.xml`, 90],
    [`${p}root/default/Filme/options.xml`, libOptions(o.nfo ? '<string>Nfo</string>' : '')],
    [`${p}root/default/Filme/movies.mblink`, '/movies'],
    [`${p}metadata/library/ab/abcd/poster.jpg`, 2500],
    [`${p}metadata/People/A/Ada/folder.jpg`, 700],
    [`${c}network.xml`, NETWORK],
    [`${c}encoding.xml`, ENCODING],
    [`${c}system.xml`, SYSTEM],
  ];
  for (const [rel, body] of copied) put(src, rel, body);
  put(src, `${p}data/trickplay/abcd/320 - 10x10/0.jpg`, 5000);
  put(src, `${p}data/trickplay/abcd/320 - 10x10/1.jpg`, 1000);
  // never copied, never counted
  put(src, 'log/log_20261124.log', 9000);
  put(src, `${p}data/keyframes/x.json`, 800);
  put(src, `${c}logging.default.json`, 50);
  put(src, `${p}plugins/Open Subtitles_20.0.0.0/meta.json`, JSON.stringify({ name: 'Open Subtitles', version: '20.0.0.0' }));
  put(src, `${p}plugins/Open Subtitles_20.0.0.0/OpenSubtitles.dll`, 600);
  put(src, `${p}plugins/Fanart_12.0.0.0/Fanart.dll`, 400);
  put(src, `${p}plugins/configurations/Fanart.xml`, 30);
  if (layout === 'linuxserver') {
    put(src, 'cache/images/x.jpg', 7000);
    put(src, 'data/transcodes/a.ts', 7000);
  }
  // symlinks are never followed
  symlinkSync('/etc', join(src, `${p}metadata/outside`));
  symlinkSync('/etc/hostname', join(src, `${p}metadata/library/ab/hostname.jpg`));
  const size = (b: string | number): number => (typeof b === 'number' ? b : Buffer.byteLength(b));
  return { bytes: copied.reduce((n, [, b]) => n + size(b), 0), trickplay: 6000 };
}

/** every entry below `dir` (not following links): path, kind, mode, size, mtime and content */
function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, r));
      h.update(`${r}|${st.mode}|${st.size}|${st.mtimeMs}|`);
      if (st.isSymbolicLink()) h.update(readlinkSync(join(dir, r)));
      else if (st.isDirectory()) walk(r);
      else h.update(readFileSync(join(dir, r)));
    }
  };
  walk('');
  return h.digest('hex');
}

describe('migrate-scan', () => {
  it('scan: official and linuxserver layouts, sizes with and without trickplay, plugins, nfo, server id', () => {
    const a = jellyfin('official');
    expect(scanSource(src)).toEqual({
      layout: 'official', serverId: SERVER_ID, bytes: a.bytes, trickplayBytes: a.trickplay, plugins: ['Fanart', 'Open Subtitles'], nfo: false,
    });
    rmSync(src, { recursive: true });
    mkdirSync(src);
    const b = jellyfin('linuxserver', { nfo: true });
    expect(scanSource(src)).toEqual({
      layout: 'linuxserver', serverId: SERVER_ID, bytes: b.bytes, trickplayBytes: b.trickplay, plugins: ['Fanart', 'Open Subtitles'], nfo: true,
    });
  });

  it('scan: nfo from a library without its own savers that saves local metadata; a server id with dashes', () => {
    jellyfin('official');
    writeFileSync(join(src, 'root/default/Filme/options.xml'), libOptions(null, true));
    writeFileSync(join(src, 'data/device.txt'), '01234567-89AB-CDEF-0123-456789ABCDEF');
    expect(scanSource(src)).toMatchObject({ nfo: true, serverId: SERVER_ID });
    writeFileSync(join(src, 'root/default/Filme/options.xml'), libOptions(null, false));
    expect(scanSource(src).nfo).toBe(false);
  });

  it('scan: an unknown layout is source_layout', () => {
    expect(() => scanSource(src)).toThrow('source_layout');
    jellyfin('official');
    // no server id
    rmSync(join(src, 'data/device.txt'));
    expect(() => scanSource(src)).toThrow('source_layout');
    writeFileSync(join(src, 'data/device.txt'), 'not-an-id');
    expect(() => scanSource(src)).toThrow('source_layout');
    writeFileSync(join(src, 'data/device.txt'), SERVER_ID);
    // both layouts at once
    put(src, 'data/data/jellyfin.db', 10);
    mkdirSync(join(src, 'data/root/default'), { recursive: true });
    expect(() => scanSource(src)).toThrow('source_layout');
    // a symlinked part of the layout
    rmSync(src, { recursive: true });
    mkdirSync(src);
    jellyfin('official');
    const real = join(root, 'elsewhere');
    mkdirSync(real);
    rmSync(join(src, 'root'), { recursive: true });
    mkdirSync(join(real, 'default'));
    symlinkSync(real, join(src, 'root'));
    expect(() => scanSource(src)).toThrow('source_layout');
  });
});

describe('migrate-copy', () => {
  it('copy bulk skips the database, final copies it and only changed files', async () => {
    jellyfin('linuxserver');
    const bulk = await copySource(src, dst, { pass: 'bulk', trickplay: false, layout: 'linuxserver' });
    expect(bulk.adjusted).toEqual([]);
    // Ferrofin's layout (try.sh): data/, root/default, metadata/, config/*.xml
    expect(existsSync(join(dst, 'data/jellyfin.db'))).toBe(false);
    expect(existsSync(join(dst, 'data/jellyfin.db-wal'))).toBe(false);
    expect(readFileSync(join(dst, 'data/device.txt'), 'utf8')).toBe(`${SERVER_ID}\n`);
    expect(existsSync(join(dst, 'data/playlists/Abend/playlist.xml'))).toBe(true);
    expect(existsSync(join(dst, 'data/collections/Reihe [boxset]/collection.xml'))).toBe(true);
    expect(existsSync(join(dst, 'root/default/Filme/movies.mblink'))).toBe(true);
    expect(existsSync(join(dst, 'metadata/library/ab/abcd/poster.jpg'))).toBe(true);
    expect(readFileSync(join(dst, 'config/network.xml'), 'utf8')).toBe(NETWORK);
    expect(lstatSync(join(dst, 'metadata/People/A/Ada/folder.jpg')).mtimeMs).toBeCloseTo(lstatSync(join(src, 'data/metadata/People/A/Ada/folder.jpg')).mtimeMs, 0);
    // not copied: trickplay (not chosen), logs, cache, transcodes, keyframes, plugins, json, symlinks
    for (const rel of ['data/trickplay', 'log', 'cache', 'data/transcodes', 'data/keyframes', 'plugins', 'config/logging.default.json', 'metadata/outside', 'metadata/library/ab/hostname.jpg', 'data/data', 'data/root']) {
      expect(existsSync(join(dst, rel)), rel).toBe(false);
    }
    expect(bulk.copied).toBe(10);
    expect(readdirSync(join(dst, 'data')).some((n) => n.endsWith('.part'))).toBe(false);

    // between the passes Jellyfin changes one image and its database, and leaves a stale shm in the target
    put(src, 'data/metadata/library/ab/abcd/poster.jpg', 2600);
    utimesSync(join(src, 'data/metadata/People/A/Ada/folder.jpg'), new Date('2026-11-20T10:00:00Z'), new Date('2026-11-20T10:00:00Z'));
    put(dst, 'data/jellyfin.db-shm', 5);
    const again = await copySource(src, dst, { pass: 'bulk', trickplay: false, layout: 'linuxserver' });
    expect(again.copied).toBe(2);
    expect(existsSync(join(dst, 'data/jellyfin.db-shm'))).toBe(true);

    put(src, 'data/metadata/library/ab/abcd/poster.jpg', 2700);
    const final = await copySource(src, dst, { pass: 'final', trickplay: true, layout: 'linuxserver' });
    // the two database files, the changed poster, the two trickplay images
    expect(final.copied).toBe(5);
    expect(readFileSync(join(dst, 'data/jellyfin.db'), 'utf8')).toBe('x'.repeat(4000));
    expect(existsSync(join(dst, 'data/jellyfin.db-wal'))).toBe(true);
    // a database file the source does not have is removed (a stale WAL/SHM next to a fresh copy corrupts it)
    expect(existsSync(join(dst, 'data/jellyfin.db-shm'))).toBe(false);
    expect(lstatSync(join(dst, 'metadata/library/ab/abcd/poster.jpg')).size).toBe(2700);
    expect(existsSync(join(dst, 'data/trickplay/abcd/320 - 10x10/1.jpg'))).toBe(true);
  });

  it('final adjusts BaseUrl, port, https, ffmpeg path, transcode path, metadata path and lists the keys', async () => {
    jellyfin('official');
    const r = await copySource(src, dst, { pass: 'final', trickplay: false, layout: 'official' });
    expect(r.adjusted).toEqual([
      'network.BaseUrl', 'network.EnableHttps', 'network.InternalHttpPort', 'network.PublicHttpPort', 'network.LocalNetworkSubnets',
      'encoding.EncoderAppPath', 'encoding.EncoderAppPathDisplay', 'encoding.TranscodingTempPath', 'system.MetadataPath',
    ]);
    const net = readFileSync(join(dst, 'config/network.xml'), 'utf8');
    expect(net).toContain('<BaseUrl />');
    expect(net).toContain('<EnableHttps>false</EnableHttps>');
    expect(net).toContain('<RequireHttps>false</RequireHttps>');
    expect(net).toContain('<InternalHttpPort>8096</InternalHttpPort>');
    expect(net).toContain('<PublicHttpPort>8096</PublicHttpPort>');
    expect(net).toContain('<InternalHttpsPort>8920</InternalHttpsPort>');
    expect(net).toMatch(/<LocalNetworkSubnets>\s*<string>192\.0\.2\.0\/24<\/string>\s*<string>10\.0\.0\.0\/8<\/string>\s*<string>172\.16\.0\.0\/12<\/string>\s*<string>192\.168\.0\.0\/16<\/string>\s*<\/LocalNetworkSubnets>/);
    const enc = readFileSync(join(dst, 'config/encoding.xml'), 'utf8');
    expect(enc).toContain(`<EncoderAppPath>${FFMPEG_DIR.ferrofin}/ffmpeg</EncoderAppPath>`);
    expect(enc).toContain(`<EncoderAppPathDisplay>${FFMPEG_DIR.ferrofin}/ffmpeg</EncoderAppPathDisplay>`);
    expect(enc).toContain('<TranscodingTempPath>/cache/transcodes</TranscodingTempPath>');
    expect(enc).toContain('<EncodingThreadCount>-1</EncodingThreadCount>');
    const sys = readFileSync(join(dst, 'config/system.xml'), 'utf8');
    expect(sys).toContain('<MetadataPath />');
    expect(sys).toContain('<CachePath />');
    expect(sys).toContain('<ServerName>Wohnzimmer</ServerName>');
    // the source keeps its values
    expect(readFileSync(join(src, 'config/network.xml'), 'utf8')).toBe(NETWORK);
    // a second final copies the adjusted XMLs again (they differ from the source) and adjusts them again
    const again = await copySource(src, dst, { pass: 'final', trickplay: false, layout: 'official' });
    expect(again.adjusted).toEqual(r.adjusted);
  });

  it('final adds a missing element, and leaves an unknown structure untouched', async () => {
    jellyfin('official');
    writeFileSync(join(src, 'config/encoding.xml'), '<?xml version="1.0"?>\n<EncodingOptions>\n  <EncodingThreadCount>-1</EncodingThreadCount>\n</EncodingOptions>\n');
    const odd = '<?xml version="1.0"?>\n<NetworkConfiguration>\n  <BaseUrl>/a</BaseUrl>\n  <BaseUrl>/b</BaseUrl>\n</NetworkConfiguration>\n';
    writeFileSync(join(src, 'config/network.xml'), odd);
    writeFileSync(join(src, 'config/system.xml'), '<Something />');
    const r = await copySource(src, dst, { pass: 'final', trickplay: false, layout: 'official' });
    expect(r.adjusted).toEqual(['encoding.EncoderAppPath', 'encoding.EncoderAppPathDisplay', 'encoding.TranscodingTempPath']);
    expect(readFileSync(join(dst, 'config/encoding.xml'), 'utf8')).toBe(
      '<?xml version="1.0"?>\n<EncodingOptions>\n  <EncodingThreadCount>-1</EncodingThreadCount>\n'
      + `  <EncoderAppPath>${FFMPEG_DIR.ferrofin}/ffmpeg</EncoderAppPath>\n  <EncoderAppPathDisplay>${FFMPEG_DIR.ferrofin}/ffmpeg</EncoderAppPathDisplay>\n`
      + '  <TranscodingTempPath>/cache/transcodes</TranscodingTempPath>\n</EncodingOptions>\n',
    );
    expect(readFileSync(join(dst, 'config/network.xml'), 'utf8')).toBe(odd);
    expect(readFileSync(join(dst, 'config/system.xml'), 'utf8')).toBe('<Something />');
  });

  it('adjustXml: empty and nil forms, unparseable subnets', () => {
    const edits = [{ key: 'BaseUrl', value: '' }, { key: 'Port', value: '8096' }];
    expect(adjustXml('<R>\n  <BaseUrl/>\n  <Port>8096</Port>\n</R>', 'R', edits)).toEqual({ text: '<R>\n  <BaseUrl/>\n  <Port>8096</Port>\n</R>', keys: [] });
    expect(adjustXml('<R>\n  <BaseUrl xsi:nil="true" />\n</R>', 'R', edits)!.keys).toEqual(['Port']);
    expect(adjustXml('<R>\n  <BaseUrl>a<b/></BaseUrl>\n</R>', 'R', edits)).toBeNull();
    expect(adjustXml('<Q>\n</Q>', 'R', edits)).toBeNull();
    expect(adjustXml('<R>\n  <S><x>1</x></S>\n</R>', 'R', [{ key: 'S', subnets: ['10.0.0.0/8'] }])).toBeNull();
    expect(adjustXml('<R>\n  <S />\n</R>', 'R', [{ key: 'S', subnets: ['10.0.0.0/8'] }])).toEqual({ text: '<R>\n  <S>\n    <string>10.0.0.0/8</string>\n  </S>\n</R>', keys: ['S'] });
  });

  it('the source tree is byte-identical after both passes', async () => {
    jellyfin('official');
    const before = treeHash(src);
    await copySource(src, dst, { pass: 'bulk', trickplay: true, layout: 'official' });
    await copySource(src, dst, { pass: 'final', trickplay: true, layout: 'official' });
    expect(treeHash(src)).toBe(before);
    expect(existsSync(join(dst, 'data/trickplay/abcd/320 - 10x10/0.jpg'))).toBe(true);
  });

  it('a target entry in the way of a folder is replaced, a symlinked target folder is not followed', async () => {
    jellyfin('official');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(dst, 'metadata'));
    writeFileSync(join(dst, 'root'), 'x');
    await copySource(src, dst, { pass: 'bulk', trickplay: false, layout: 'official' });
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(dst, 'metadata')).isDirectory()).toBe(true);
    expect(existsSync(join(dst, 'root/default/Filme/options.xml'))).toBe(true);
  });

  it('final prunes what the source no longer has (not metadata), stale adoption backups and temp files', async () => {
    jellyfin('official');
    put(src, 'root/default/Serien/options.xml', libOptions(''));
    put(src, 'data/playlists/Morgen/playlist.xml', 40);
    put(src, 'data/collections/Alt [boxset]/collection.xml', 40);
    put(src, 'config/dlna.xml', '<DlnaOptions />');
    put(src, 'metadata/library/cd/cdef/poster.jpg', 100);
    await copySource(src, dst, { pass: 'final', trickplay: true, layout: 'official' });
    expect(existsSync(join(dst, 'root/default/Serien/options.xml'))).toBe(true);
    expect(existsSync(join(dst, 'data/trickplay/abcd'))).toBe(true);
    // a retry days later: Jellyfin lost a library, a playlist, a collection, a config file and an image meanwhile
    rmSync(join(src, 'root/default/Serien'), { recursive: true });
    rmSync(join(src, 'data/playlists/Morgen'), { recursive: true });
    rmSync(join(src, 'data/collections'), { recursive: true });
    rmSync(join(src, 'config/dlna.xml'));
    rmSync(join(src, 'metadata/library/cd'), { recursive: true });
    // Ferrofin adopted the earlier copy, and an interrupted copy left temp files
    put(dst, 'data/jellyfin.db.pre-ferrofin', 10);
    put(dst, 'data/jellyfin.db.pre-ferrofin.1', 10);
    put(dst, 'metadata/library/ab/.ffmigrate.part', 10);
    put(dst, 'root/default/Filme/.ffmigrate.part', 10);
    // a symlink in the target is removed, never followed
    const outside = join(root, 'outside');
    put(outside, 'keep.txt', 'x');
    symlinkSync(outside, join(dst, 'root/default/Link'));
    expect(checkAdopted(dst)).toBe(true);
    const before = treeHash(src);
    await copySource(src, dst, { pass: 'final', trickplay: false, layout: 'official' });
    expect(treeHash(src)).toBe(before);
    expect(checkAdopted(dst)).toBe(false);
    for (const rel of [
      'root/default/Serien', 'root/default/Link', 'data/playlists/Morgen', 'data/collections', 'config/dlna.xml', 'data/trickplay',
      'data/jellyfin.db.pre-ferrofin', 'data/jellyfin.db.pre-ferrofin.1', 'metadata/library/ab/.ffmigrate.part', 'root/default/Filme/.ffmigrate.part',
    ]) expect(existsSync(join(dst, rel)), rel).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('x');
    expect(existsSync(join(dst, 'root/default/Filme/options.xml'))).toBe(true);
    expect(existsSync(join(dst, 'data/playlists/Abend/playlist.xml'))).toBe(true);
    expect(existsSync(join(dst, 'config/network.xml'))).toBe(true);
    expect(existsSync(join(dst, 'data/jellyfin.db'))).toBe(true);
    // metadata is never pruned: an orphaned image is harmless
    expect(existsSync(join(dst, 'metadata/library/cd/cdef/poster.jpg'))).toBe(true);
  });

  it('bulk prunes nothing', async () => {
    jellyfin('official');
    put(dst, 'root/default/Alt/options.xml', 10);
    put(dst, 'data/jellyfin.db.pre-ferrofin', 10);
    await copySource(src, dst, { pass: 'bulk', trickplay: false, layout: 'official' });
    expect(existsSync(join(dst, 'root/default/Alt/options.xml'))).toBe(true);
    expect(checkAdopted(dst)).toBe(true);
  });

  it('copy refuses a layout other than the one found', async () => {
    jellyfin('official');
    await expect(copySource(src, dst, { pass: 'bulk', trickplay: false, layout: 'linuxserver' })).rejects.toThrow('source_layout');
    expect(readdirSync(dst)).toEqual([]);
  });
});

describe('check data and the verbs', () => {
  it('check data reports adopted', () => {
    expect(checkAdopted(dst)).toBe(false);
    put(dst, 'data/jellyfin.db', 10);
    expect(checkAdopted(dst)).toBe(false);
    mkdirSync(join(dst, 'data/jellyfin.db.pre-ferrofin'));
    expect(checkAdopted(dst)).toBe(false);
    rmSync(join(dst, 'data/jellyfin.db.pre-ferrofin'), { recursive: true });
    put(dst, 'data/jellyfin.db.pre-ferrofin', 10);
    expect(checkAdopted(dst)).toBe(true);
  });

  it('migrate verbs check their arguments', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const other = String((process.getuid?.() ?? 0) + 1);
      for (const args of [
        ['migrate-scan', 'x'],
        ['migrate-copy', 'bulk', '0', 'official'],
        ['migrate-copy', 'half', '0', 'official', other],
        ['migrate-copy', 'bulk', '2', 'official', other],
        ['migrate-copy', 'bulk', '0', 'debian', other],
        ['migrate-copy', 'bulk', '0', 'official', '-1'],
        ['migrate-copy', 'bulk', '0', 'official', '1e3'],
      ]) {
        out.mockClear();
        expect(await main(args), args.join(' ')).toBe(2);
        expect(out).toHaveBeenCalledWith('{"error":"invalid_body"}\n');
      }
      // the copy runs as the Ferrofin user, so what it writes is owned by it
      out.mockClear();
      expect(await main(['migrate-copy', 'bulk', '0', 'official', other])).toBe(2);
      expect(out).toHaveBeenCalledWith('{"error":"uid_mismatch"}\n');
    } finally { out.mockRestore(); }
  });
});
