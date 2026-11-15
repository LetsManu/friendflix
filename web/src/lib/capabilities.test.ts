// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { ALL_PERMS, permsFrom } from './perms';
import { ALL_AREAS, ALL_CAPS, ALL_FEATURES, areas, areasFrom, capsFrom, features, featuresFrom, featuresOfMe, linkShown, segmentShown, serverCaps } from './capabilities';

describe('server capabilities', () => {
  it('default: everything supported (before /api/me, older backends)', () => {
    expect(get(serverCaps)).toEqual(ALL_CAPS);
    expect(capsFrom(undefined)).toEqual(ALL_CAPS);
    expect(capsFrom(null)).toEqual(ALL_CAPS);
    expect(capsFrom('x')).toEqual(ALL_CAPS);
    for (const s of ['intro', 'outro', 'recap', 'preview', 'Intro']) expect(segmentShown(ALL_CAPS, s)).toBe(true);
    expect(linkShown(ALL_CAPS, '/calendar')).toBe(true);
  });
  it('the Jellyfin answer changes nothing', () => {
    const jf = { segments: ['intro', 'outro', 'recap', 'preview'], trickplay: true, upcoming: true, subtitleSearch: true, webhooks: true, changeFeed: false, planB: true, subtitleExtract: false, chapters: true };
    expect(capsFrom(jf)).toEqual(ALL_CAPS);
  });
  it('castHlsSubtitles: on by default, off only when the server says so (Plex)', () => {
    expect(ALL_CAPS.castHlsSubtitles).toBe(true);
    expect(capsFrom({ castHlsSubtitles: false }).castHlsSubtitles).toBe(false);
    expect(capsFrom({ castHlsSubtitles: 'no' }).castHlsSubtitles).toBe(true);
  });
  it('a reduced server hides exactly what it lacks', () => {
    const c = capsFrom({ segments: ['intro', 'outro', 7], upcoming: false, subtitleSearch: false, trickplay: 'yes' });
    expect(c.segments).toEqual(['intro', 'outro']);
    expect(segmentShown(c, 'recap')).toBe(false);
    expect(segmentShown(c, 'preview')).toBe(false);
    expect(segmentShown(c, 'intro')).toBe(true);
    expect(c.subtitleSearch).toBe(false);
    expect(c.trickplay).toBe(true); // malformed: keeps the default
    expect(linkShown(c, '/calendar')).toBe(false);
    expect(linkShown(c, '/upcoming')).toBe(true); // Seerr upcoming, not the media server
  });
  it('chapters: supported unless the server says no (older backends send nothing)', () => {
    expect(capsFrom({}).chapters).toBe(true);
    expect(capsFrom({ chapters: false }).chapters).toBe(false);
    expect(capsFrom({ chapters: 'no' }).chapters).toBe(true);
  });
});

describe('instance features', () => {
  it('default: everything on except surround (before /api/me, older backends); only an explicit false turns requests off', () => {
    expect(get(features)).toEqual(ALL_FEATURES);
    for (const raw of [undefined, null, 'x', {}, { requests: 'no' }, { requests: true }]) expect(featuresFrom(raw)).toEqual({ requests: true, postplay: true, surround: false, livetv: false });
    expect(featuresFrom({ requests: false })).toEqual({ requests: false, postplay: true, surround: false, livetv: false });
    expect(featuresFrom({ postplay: false })).toEqual({ requests: true, postplay: false, surround: false, livetv: false });
    expect(featuresFrom({ surround: true }).surround).toBe(true);
  });
  it('live TV is off unless the answer says an explicit true', () => {
    expect(featuresFrom({}).livetv).toBe(false);
    expect(featuresFrom({ livetv: true }).livetv).toBe(true);
    for (const v of ['true', 1, 'yes', null, false]) expect(featuresFrom({ livetv: v }).livetv).toBe(false);
    expect(featuresOfMe({ features: { livetv: true } }).livetv).toBe(true);
  });
  it('without a request service the upcoming and admin requests links are hidden; /requests stays (reminders)', () => {
    const off = featuresFrom({ requests: false });
    expect(linkShown(ALL_CAPS, '/requests', off)).toBe(true);
    for (const href of ['/upcoming', '/admin/requests']) {
      expect(linkShown(ALL_CAPS, href)).toBe(true);
      expect(linkShown(ALL_CAPS, href, off)).toBe(false);
    }
    expect(linkShown(ALL_CAPS, '/favorites', off)).toBe(true);
  });
});

describe('featuresOfMe (the one requests fold)', () => {
  it('no right to request = no request service; the service flag alone also counts; nothing sent = on', () => {
    expect(featuresOfMe({ features: { requests: true }, perms: { requests: false } }).requests).toBe(false);
    expect(featuresOfMe({ features: { requests: false }, perms: { requests: true } }).requests).toBe(false);
    expect(featuresOfMe({ features: { requests: true }, perms: { cast: false } }).requests).toBe(true);
    expect(featuresOfMe({}).requests).toBe(true);
    expect(featuresOfMe({ features: { postplay: false }, perms: { requests: false } })).toMatchObject({ requests: false, postplay: false });
  });
});

describe('rights and links', () => {
  it('the party link needs the party right; without perms it shows', () => {
    expect(linkShown(ALL_CAPS, '/party')).toBe(true);
    expect(linkShown(ALL_CAPS, '/party', ALL_FEATURES, permsFrom({ party: false }))).toBe(false);
    expect(linkShown(ALL_CAPS, '/vote', ALL_FEATURES, permsFrom({ party: false }))).toBe(false); // votes are part of Gemeinsam (roles redesign §4.7)
  });
});

describe('areas (roles redesign §4.6, §6)', () => {
  it('areasFrom: missing or not a boolean = on (an older backend sends nothing)', () => {
    expect(areasFrom(undefined)).toEqual({ library: true, livetv: true, requests: true, together: true, downloads: true });
    expect(areasFrom(undefined)).toEqual(ALL_AREAS);
    expect(areasFrom('x')).toEqual(ALL_AREAS);
    expect(areasFrom({ library: false })).toEqual({ ...ALL_AREAS, library: false });
    expect(areasFrom({ library: 0, livetv: 'no', downloads: false })).toEqual({ ...ALL_AREAS, downloads: false });
    expect(get(areas)).toEqual(ALL_AREAS);
  });
  it('library pages need the Mediathek, upcoming needs Wünsche, parties and votes need Gemeinsam', () => {
    const noLib = { ...ALL_AREAS, library: false };
    for (const href of ['/tonight', '/favorites', '/lists', '/history', '/match', '/collections', '/now', '/calendar', '/stats', '/downloads', '/watchlist', '/requests']) {
      expect(linkShown(ALL_CAPS, href, ALL_FEATURES, ALL_PERMS), href).toBe(true);
      expect(linkShown(ALL_CAPS, href, ALL_FEATURES, ALL_PERMS, noLib), href).toBe(false);
    }
    expect(linkShown(ALL_CAPS, '/upcoming', ALL_FEATURES, ALL_PERMS, { ...ALL_AREAS, requests: false })).toBe(false);
    expect(linkShown(ALL_CAPS, '/party', ALL_FEATURES, ALL_PERMS, { ...ALL_AREAS, together: false })).toBe(false);
    expect(linkShown(ALL_CAPS, '/vote', ALL_FEATURES, ALL_PERMS, { ...ALL_AREAS, together: false })).toBe(false);
    for (const href of ['/settings', '/devices', '/remote', '/me']) expect(linkShown(ALL_CAPS, href, ALL_FEATURES, ALL_PERMS, { library: false, livetv: false, requests: false, together: false, downloads: false }), href).toBe(true);
  });
});
