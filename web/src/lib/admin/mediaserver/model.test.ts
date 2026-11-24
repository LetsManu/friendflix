// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, tr } from '#lib/i18n';
import de from '#lib/i18n/locales/de/index';
import en from '#lib/i18n/locales/en/index';
import es from '#lib/i18n/locales/es/index';
import fr from '#lib/i18n/locales/fr/index';
import it_ from '#lib/i18n/locales/it/index';
import pl from '#lib/i18n/locales/pl/index';
import tr_ from '#lib/i18n/locales/tr/index';
import type { MediaManaged, MediaStatus, MediaView, MoveCandidate, MoveScan, MoveState, MoveView } from './api';
import {
  ACTION_ORDER, DEFAULT_MANAGED, MOVE_STEPS, TRIAL_KINDS, actionsFor, autoCandidate, backActive, choiceDisabled, codeLogHint, countdown, currentChoice, folderRowsError, idError,
  initialRows, defaultName, keptLibraries, kindName, livetvOffer, mediaErrorText, migratedFolders, migratedOverlap, wholeBaseMigrated, moveAbortable, moveActive, moveFollow, moveResult, moveSteps, moveSummary, saveErrorText,
  nameTakenRow, passphraseError, pinState, reasonText, scanFresh, setupSteps, sourceLine, statusStarting, versionCmp,
} from './model';

afterEach(async () => { await setLocale('de'); });

const managed = (o: Partial<MediaManaged> = {}): MediaManaged => ({
  kind: null, setup: 'none', setupError: null, adminUser: null, hasPassword: false, libraries: [], externalUrl: null, hasExternalKey: false, updatedAt: null, ...o,
});
const status = (o: Partial<MediaStatus> = {}): MediaStatus => ({
  available: true, reason: null, base: { set: false, path: null, pending: false, expiresAt: null }, desired: null, container: null, pin: null,
  pins: { ferrofin: true, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'x86_64', nvidia: false }, error: null, backups: [], hdr: null, ...o,
});
const view = (o: Partial<MediaView> = {}): MediaView => ({
  mode: 'external', offer: { managed: true, reason: null }, kinds: { ferrofin: true, jellyfin: true }, status: status(), managed: managed(),
  external: { url: null, hasKey: false }, livetvLibraryPath: null, ...o,
});
const DIGEST = `sha256:${'a'.repeat(64)}`;
const container = (o: Partial<NonNullable<MediaStatus['container']>> = {}): NonNullable<MediaStatus['container']> => ({
  state: 'running', health: 'healthy', kind: 'jellyfin', image: { digest: DIGEST, upstream: '10.11.0' }, template: 'current', tampered: false, createdAt: '2026-11-17T08:00:00.000Z', ...o,
});
const running = (o: { setup?: MediaManaged['setup']; pin?: MediaStatus['pin']; c?: Partial<NonNullable<MediaStatus['container']>>; backups?: MediaStatus['backups']; setupError?: string | null } = {}) => view({
  mode: 'managed', managed: managed({ kind: 'jellyfin', setup: o.setup ?? 'done', setupError: o.setupError ?? null }),
  status: status({ container: container(o.c), pin: o.pin !== undefined ? o.pin : { image: `docker.io/jellyfin/jellyfin:10.11.0@${DIGEST}`, upstream: '10.11.0', changed: false }, backups: o.backups ?? [] }),
});

describe('choices', () => {
  it('Jellyfin is the default managed kind while Ferrofin is a trial', () => {
    expect(DEFAULT_MANAGED).toBe('jellyfin');
    expect(TRIAL_KINDS).toEqual(['ferrofin']);
    expect(kindName('ferrofin')).toBe('Ferrofin');
    expect(kindName('jellyfin')).toBe('Jellyfin');
  });

  it('currentChoice: external, or the managed kind', () => {
    expect(currentChoice(view())).toBe('external');
    expect(currentChoice(view({ mode: 'managed', managed: managed({ kind: 'ferrofin' }) }))).toBe('ferrofin');
    // a managed mode without a kind (an older row) reads external
    expect(currentChoice(view({ mode: 'managed' }))).toBe('external');
  });

  it('choiceDisabled: every offer reason, a missing image, external never', () => {
    const reasons = ['no_updater', 'plex', 'url_pinned', 'ids_in_use', 'engine_old', 'proxy_outdated', 'no_project', 'no_network', 'updater_outdated', 'starting'] as const;
    for (const r of reasons) {
      const v = view({ offer: { managed: false, reason: r } });
      expect(choiceDisabled(v, 'ferrofin'), r).toBe(r);
      expect(choiceDisabled(v, 'jellyfin'), r).toBe(r);
      expect(choiceDisabled(v, 'external'), r).toBeNull();
    }
    const noImage = view({ kinds: { ferrofin: false, jellyfin: true } });
    expect(choiceDisabled(noImage, 'ferrofin')).toBe('image_missing');
    expect(choiceDisabled(noImage, 'jellyfin')).toBeNull();
    // the offer reason comes first; an offer without a reason still disables
    expect(choiceDisabled(view({ offer: { managed: false, reason: 'plex' }, kinds: { ferrofin: false, jellyfin: false } }), 'ferrofin')).toBe('plex');
    expect(choiceDisabled(view({ offer: { managed: false, reason: null } }), 'jellyfin')).toBe('no_updater');
    // a moved server stays Ferrofin: another kind is off with its reason (the updater refuses it); the address stays open
    const movedDesired = { kind: 'ferrofin' as const, folders: [{ rel: 'Filme', target: '/movies', migrated: true as const }], uid: 1000, gid: 1000, gpu: 'off' as const, mediaGid: null, egress: true, run: true, migrated: true as const };
    const movedView = view({ mode: 'managed', managed: managed({ kind: 'ferrofin', setup: 'done' }), status: status({ desired: movedDesired }) });
    expect(choiceDisabled(movedView, 'jellyfin')).toBe('moved');
    expect(choiceDisabled(movedView, 'ferrofin')).toBeNull();
    expect(choiceDisabled(movedView, 'external')).toBeNull();
    expect(reasonText('moved')).toBe('Nach dem Umzug bleibt der Server Ferrofin.');
    // recorded by the backend only (the updater's status not read yet)
    const movedFrom = { offered: false, reason: null, scan: null, state: null, migratedFrom: { name: 'jellyfin', version: '10.11.0', at: '2026-11-24T10:00:00.000Z' }, sourceState: null, requestsWarning: false };
    expect(choiceDisabled(view({ mode: 'managed', managed: managed({ kind: 'ferrofin' }), move: movedFrom }), 'jellyfin')).toBe('moved');
    // a stage 1 managed server may change its kind
    expect(choiceDisabled(view({ mode: 'managed', managed: managed({ kind: 'ferrofin' }) }), 'jellyfin')).toBeNull();
  });

  it('the reasons read as the spec words them', () => {
    // stage 2: the move is there (the button where it is offered), a fresh server is not
    expect(reasonText('ids_in_use')).toBe('FriendFlix hängt an den IDs deines bisherigen Servers: ein neuer verwalteter Server ginge nur als Umzug von Jellyfin.');
    expect(reasonText('plex')).toBe('Wechsel von Plex: kommt mit Stufe 4');
    for (const r of ['no_updater', 'url_pinned', 'engine_old', 'proxy_outdated', 'no_project', 'no_network', 'updater_outdated', 'starting', 'image_missing'] as const) expect(reasonText(r), r).not.toMatch(/^mediaserver\./);
    // the updater has not read the media status yet since it started: a neutral line, never "too old"
    expect(reasonText('starting')).toBe('Medienserver-Status wird gelesen…');
  });

  it('statusStarting: the updater has not read the media status yet (managed, or the reason the offer waits for)', () => {
    const starting = status({ available: false, reason: 'starting', pins: { ferrofin: false, jellyfin: false } });
    expect(statusStarting(view({ status: starting, offer: { managed: false, reason: 'starting' } }))).toBe(true);
    expect(statusStarting(view({ mode: 'managed', managed: managed({ kind: 'jellyfin', setup: 'done' }), status: starting, offer: { managed: false, reason: 'starting' } }))).toBe(true);
    // Plex: its own reason stands, the card is not held for the media status
    expect(statusStarting(view({ status: starting, offer: { managed: false, reason: 'plex' } }))).toBe(false);
    expect(statusStarting(view())).toBe(false);
    expect(statusStarting(view({ status: null, offer: { managed: false, reason: 'updater_outdated' } }))).toBe(false);
    expect(actionsFor(view({ mode: 'managed', managed: managed({ kind: 'jellyfin', setup: 'done' }), status: starting }))).toEqual([]);
  });
});

describe('base folder', () => {
  it('countdown: mm:ss, 00:00 once past', () => {
    const now = Date.parse('2026-11-17T10:00:00.000Z');
    expect(countdown('2026-11-17T10:30:00.000Z', now)).toBe('30:00');
    expect(countdown('2026-11-17T10:00:01.000Z', now)).toBe('00:01');
    expect(countdown('2026-11-17T10:00:00.400Z', now)).toBe('00:01');
    expect(countdown('2026-11-17T09:59:59.000Z', now)).toBe('00:00');
    expect(countdown('kein Datum', now)).toBe('00:00');
  });

  it('codeLogHint: the compose command and the Portainer path', () => {
    expect(codeLogHint.compose).toBe('docker compose logs updater | grep "media folder"');
    expect(codeLogHint.portainer).toContain('updater');
    expect(codeLogHint.portainer).toContain('Logs');
  });
});

describe('backups', () => {
  it('passphraseError: 12–1024 code points, typed twice the same', () => {
    expect(passphraseError('kurz', 'kurz')).toBe('short');
    expect(passphraseError('abcdefghijkl', 'abcdefghijkm')).toBe('mismatch');
    expect(passphraseError('abcdefghijkl', 'abcdefghijkl')).toBeNull();
    // code points, not UTF-16 units: 12 emoji are 12
    expect(passphraseError('🎬'.repeat(12), '🎬'.repeat(12))).toBeNull();
    expect(passphraseError('🎬'.repeat(11), '🎬'.repeat(11))).toBe('short');
    expect(passphraseError('x'.repeat(1025), 'x'.repeat(1025))).toBe('long');
    expect(passphraseError('x'.repeat(1024), 'x'.repeat(1024))).toBeNull();
  });
});

describe('folders', () => {
  const row = (rel: string, name = rel, type = 'movies' as const) => ({ rel, name, type });
  it('folderRowsError: the migrated folders count (none, the limit of 20 in total)', () => {
    expect(folderRowsError([], 1)).toBeNull();
    expect(folderRowsError(Array.from({ length: 18 }, (_, i) => row(`F${i}`)), 2)).toBeNull();
    expect(folderRowsError(Array.from({ length: 19 }, (_, i) => row(`F${i}`)), 2)).toBe('too_many');
  });

  it('migratedOverlap / wholeBaseMigrated: a folder that is, lies in or holds a migrated one; the whole base holds every folder', () => {
    const mig = [{ rel: 'Filme', target: '/movies', migrated: true as const }, { rel: 'Serien/Neu', target: '/tv', migrated: true as const }];
    expect(migratedOverlap('Filme', mig)).toBe('same');
    expect(migratedOverlap('Filme/Klassiker', mig)).toBe('overlap');
    expect(migratedOverlap('Serien', mig)).toBe('overlap');
    expect(migratedOverlap('Musik', mig)).toBeNull();
    expect(migratedOverlap('Filmeabend', mig)).toBeNull();
    expect(migratedOverlap('Musik', [])).toBeNull();
    expect(wholeBaseMigrated(mig)).toBe(false);
    const whole = [{ rel: '', target: '/media', migrated: true as const }];
    expect(wholeBaseMigrated(whole)).toBe(true);
    expect(migratedOverlap('Musik', whole)).toBe('overlap');
  });

  it('folderRowsError: none, too many, a bad name, a name twice, one inside another', () => {
    expect(folderRowsError([])).toBe('none');
    expect(folderRowsError(Array.from({ length: 21 }, (_, i) => row(`F${i}`)))).toBe('too_many');
    expect(folderRowsError(Array.from({ length: 20 }, (_, i) => row(`F${i}`)))).toBeNull();
    expect(folderRowsError([row('Filme', 'x'.repeat(61))])).toBe('name');
    expect(folderRowsError([row('Filme', 'x'.repeat(60))])).toBeNull();
    expect(folderRowsError([row('Filme', '   ')])).toBe('name');
    expect(folderRowsError([row('Filme', 'a\u0007b')])).toBe('name');
    // names compared trimmed and without regard to case (the server holds one library per name)
    expect(folderRowsError([row('A', 'Filme'), row('B', ' filme ')])).toBe('duplicate_name');
    expect(folderRowsError([row('Filme'), row('Filme/Neu', 'Neu')])).toBe('nested');
    expect(folderRowsError([row('Filme'), row('Filme 2')])).toBeNull();
  });

  it('initialRows / keptLibraries: the mounted folders are rows, a removed folder whose library exists is kept', () => {
    const libs = [
      { slug: 'filme', name: 'Filme', type: 'movies' as const, rel: 'Filme', created: true },
      { slug: 'serien', name: 'Serien', type: 'tvshows' as const, rel: 'Serien', created: true },
      { slug: 'alt', name: 'Alt', type: 'mixed' as const, rel: 'Alt', created: true },
    ];
    const v = view({
      mode: 'managed', managed: managed({ kind: 'jellyfin', libraries: libs }),
      status: status({ desired: { kind: 'jellyfin', folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien', target: '/media/serien' }], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true, run: true } }),
    });
    expect(initialRows(v)).toEqual([{ rel: 'Filme', name: 'Filme', type: 'movies' }, { rel: 'Serien', name: 'Serien', type: 'tvshows' }]);
    expect(keptLibraries(v).map((l) => l.slug)).toEqual(['alt']);
    // nothing deployed yet: every stored library is a row, none kept
    const fresh = view({ mode: 'managed', managed: managed({ kind: 'jellyfin', libraries: libs.slice(0, 1) }) });
    expect(initialRows(fresh)).toEqual([{ rel: 'Filme', name: 'Filme', type: 'movies' }]);
    expect(keptLibraries(fresh)).toEqual([]);
    expect(initialRows(view())).toEqual([]);
    // a moved server: its migrated folders are read-only (migratedFolders), never rows; a new one at /ffmedia/<slug> is a row
    const moved = view({
      mode: 'managed', managed: managed({ kind: 'ferrofin', libraries: [{ slug: 'neu', name: 'Neu', type: 'movies', rel: 'Neu', created: true }] }),
      status: status({ desired: { kind: 'ferrofin', folders: [{ rel: '', target: '/media', migrated: true }, { rel: 'Filme', target: '/media/neu', migrated: true }, { rel: 'Neu', target: '/ffmedia/neu' }],
        uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true, run: true, migrated: true } }),
    });
    expect(migratedFolders(moved)).toEqual([{ rel: '', target: '/media', migrated: true }, { rel: 'Filme', target: '/media/neu', migrated: true }]);
    expect(initialRows(moved)).toEqual([{ rel: 'Neu', name: 'Neu', type: 'movies' }]);
    expect(keptLibraries(moved)).toEqual([]);
    // a migrated target that looks like a slug never stands for a library
    const onlyMigrated = { ...moved, status: status({ desired: { ...moved.status!.desired!, folders: moved.status!.desired!.folders.slice(0, 2) } }) };
    expect(initialRows(onlyMigrated)).toEqual([]);
    expect(keptLibraries(onlyMigrated).map((l) => l.slug)).toEqual(['neu']);
    expect(migratedFolders(v)).toEqual([]);
    expect(migratedFolders(view())).toEqual([]);
    // a kept library's name on a chosen folder: that row gets the conflict
    expect(nameTakenRow([row('Neu', 'Kino'), row('Neu2', ' alt ')], keptLibraries(v))).toBe(1);
    expect(nameTakenRow([row('Neu', 'Kino')], keptLibraries(v))).toBe(-1);
  });

  it('livetvOffer: the folder named like the recordings path offers its target once its library is stored', () => {
    const libs = [{ slug: 'aufnahmen', name: 'Aufnahmen', type: 'mixed' as const, rel: 'TV/Aufnahmen', created: true }];
    const v = view({ mode: 'managed', managed: managed({ kind: 'jellyfin', libraries: libs }), livetvLibraryPath: '/data/aufnahmen/' });
    expect(livetvOffer(v, [{ rel: 'Filme' }, { rel: 'TV/Aufnahmen' }])).toEqual({ rel: 'TV/Aufnahmen', target: '/media/aufnahmen' });
    // already pointing there, no such folder, not stored yet, no path at all: nothing to offer
    expect(livetvOffer({ ...v, livetvLibraryPath: '/media/aufnahmen' }, [{ rel: 'TV/Aufnahmen' }])).toBeNull();
    expect(livetvOffer(v, [{ rel: 'Filme' }])).toBeNull();
    expect(livetvOffer({ ...v, managed: managed({ kind: 'jellyfin' }) }, [{ rel: 'TV/Aufnahmen' }])).toBeNull();
    expect(livetvOffer({ ...v, livetvLibraryPath: null }, [{ rel: 'TV/Aufnahmen' }])).toBeNull();
    // after a move a new folder mounts at /ffmedia/<slug>: the library entry says so, or the migrated spec does
    const moved = view({ mode: 'managed', managed: managed({ kind: 'ferrofin', libraries: [{ ...libs[0]!, ffmedia: true }] }), livetvLibraryPath: '/data/aufnahmen/' });
    expect(livetvOffer(moved, [{ rel: 'TV/Aufnahmen' }])).toEqual({ rel: 'TV/Aufnahmen', target: '/ffmedia/aufnahmen' });
    const spec = { kind: 'ferrofin' as const, folders: [{ rel: 'Filme', target: '/movies', migrated: true as const }], uid: 1000, gid: 1000, gpu: 'off' as const, mediaGid: null, egress: true, run: true, migrated: true as const };
    expect(livetvOffer({ ...v, status: status({ desired: spec }) }, [{ rel: 'TV/Aufnahmen' }])).toEqual({ rel: 'TV/Aufnahmen', target: '/ffmedia/aufnahmen' });
    expect(livetvOffer({ ...moved, livetvLibraryPath: '/ffmedia/aufnahmen' }, [{ rel: 'TV/Aufnahmen' }])).toBeNull();
  });

  it('defaultName: a picked folder\'s name cut at 60 without splitting a character', () => {
    expect(defaultName('Filme')).toBe('Filme');
    expect(defaultName('x'.repeat(70))).toBe('x'.repeat(60));
    // 59 units, then an emoji (2 units): it does not fit whole, and is never cut in half
    const cut = defaultName(`${'a'.repeat(59)}🎬b`);
    expect(cut).toBe('a'.repeat(59));
    expect(defaultName('🎬'.repeat(40))).toBe('🎬'.repeat(30));
    expect(folderRowsError([{ rel: 'x', name: defaultName('🎬'.repeat(40)), type: 'movies' }])).toBeNull();
  });

  it('idError: an integer 1–65535, never 0', () => {
    expect(idError(1000)).toBe(false);
    expect(idError(65535)).toBe(false);
    for (const bad of [0, -1, 65536, 1.5, Number.NaN]) expect(idError(bad), String(bad)).toBe(true);
  });
});

describe('setup progress', () => {
  it("setupSteps: 'libraries' with an error → libraries failed, the ones before done, the ones after todo", () => {
    const s = setupSteps(managed({ kind: 'jellyfin', setup: 'libraries', setupError: 'unreachable' }));
    expect(s).toEqual([
      { step: 'applying', state: 'done' }, { step: 'first_run', state: 'done' }, { step: 'api_key', state: 'done' },
      { step: 'libraries', state: 'failed' }, { step: 'hwaccel', state: 'todo' }, { step: 'finishing', state: 'todo' },
    ]);
    expect(setupSteps(managed({ setup: 'api_key' })).map((x) => x.state)).toEqual(['done', 'done', 'running', 'todo', 'todo', 'todo']);
    expect(setupSteps(managed({ setup: 'done' })).every((x) => x.state === 'done')).toBe(true);
    expect(setupSteps(managed({ setup: 'none' })).every((x) => x.state === 'todo')).toBe(true);
    // failed (a startup wizard someone else completed): the first start failed
    expect(setupSteps(managed({ setup: 'failed', setupError: 'wizard_taken' })).map((x) => x.state)).toEqual(['done', 'failed', 'todo', 'todo', 'todo', 'todo']);
  });
});

describe('status and actions', () => {
  it('versionCmp / pinState: same, update, newer than this build, unknown', () => {
    expect(versionCmp('10.11.0', '10.10.7')).toBe(1);
    expect(versionCmp('10.10.7', '10.11.0')).toBe(-1);
    expect(versionCmp('10.11.0', '10.11.0')).toBe(0);
    expect(versionCmp('10.11', '10.11.0')).toBe(0);
    expect(versionCmp('unknown', '10.11.0')).toBeNull();
    expect(pinState(running())).toBe('same');
    expect(pinState(running({ pin: { image: `docker.io/jellyfin/jellyfin:10.11.1@sha256:${'b'.repeat(64)}`, upstream: '10.11.1', changed: false } }))).toBe('update');
    expect(pinState(running({ c: { template: 'update_pending' } }))).toBe('update');
    expect(pinState(running({ pin: { image: `docker.io/jellyfin/jellyfin:10.11.0@${DIGEST}`, upstream: '10.11.0', changed: true } }))).toBe('update');
    expect(pinState(running({ pin: { image: `docker.io/jellyfin/jellyfin:10.10.7@sha256:${'b'.repeat(64)}`, upstream: '10.10.7', changed: false } }))).toBe('newer');
    expect(pinState(running({ pin: null }))).toBe('unknown');
    expect(pinState(view())).toBe('unknown');
  });

  it('actionsFor: a running server stops and restarts, a stopped one starts, in a fixed order', () => {
    expect(actionsFor(running())).toEqual(['stop', 'restart', 'backup', 'remove']);
    expect(actionsFor(running({ c: { state: 'exited' } }))).toEqual(['start', 'backup', 'remove']);
    const withBackup = running({ backups: [{ id: 'jellyfin-20261117-1030-10.11.0', kind: 'jellyfin', upstream: '10.11.0', at: '2026-11-17T10:30:00.000Z', tag: 'manual', size: 10 }] });
    expect(actionsFor(withBackup)).toEqual(['stop', 'restart', 'backup', 'restore', 'remove']);
    // a backup of the other kind cannot be restored here
    expect(actionsFor(running({ backups: [{ ...withBackup.status!.backups[0]!, kind: 'ferrofin' }] }))).not.toContain('restore');
    for (const a of actionsFor(withBackup)) expect(ACTION_ORDER).toContain(a);
    // no updater (or one that cannot reach its engine): nothing can be changed
    expect(actionsFor(view({ mode: 'managed', status: status({ available: false, container: container() }) }))).toEqual([]);
    expect(actionsFor(view({ status: null }))).toEqual([]);
    // external without a leftover container: nothing; with one: it can be removed
    expect(actionsFor(view())).toEqual([]);
    expect(actionsFor(view({ status: status({ container: container({ state: 'exited' }) }) }))).toEqual(['remove']);
    // managed, set up but no container yet (removed by hand): remove only
    expect(actionsFor(view({ mode: 'managed', managed: managed({ kind: 'jellyfin', setup: 'applying' }) }))).toEqual(['remove']);
  });

  it('Aktualisieren only once the managed setup is done (the first-run apply reads update_pending until finish-setup ran)', () => {
    const pending = { c: { template: 'update_pending' as const, kind: 'ferrofin' as const } };
    for (const setup of ['applying', 'first_run', 'api_key', 'libraries', 'hwaccel', 'finishing', 'failed'] as const) {
      expect(actionsFor(running({ ...pending, setup })), setup).not.toContain('update');
    }
    expect(actionsFor(running({ ...pending, setup: 'done' }))).toEqual(['stop', 'restart', 'update', 'backup', 'remove']);
    // newer than this build: never down, no update
    expect(actionsFor(running({ pin: { image: `x@sha256:${'b'.repeat(64)}`, upstream: '10.10.7', changed: false } }))).not.toContain('update');
  });
});

describe('save errors', () => {
  it('a refused or cancelled save reads as a sentence; anything else is left to the code', () => {
    expect(saveErrorText(new DOMException('x', 'SecurityError'))).toBe('Der Browser hat das Speichern nicht erlaubt. Versuch es noch einmal.');
    expect(saveErrorText(new DOMException('x', 'NotAllowedError'))).toBe(saveErrorText({ name: 'SecurityError' }));
    expect(saveErrorText(new DOMException('x', 'AbortError'))).toBe('Das Speichern wurde abgebrochen.');
    expect(saveErrorText(new Error('x'))).toBeNull();
    expect(saveErrorText(null)).toBeNull();
  });
});

describe('error texts', () => {
  const backend = (file: string) => readFileSync(new URL(`../../../../../backend/src/${file}`, import.meta.url), 'utf8');
  const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  const MEDIA_ERRORS = quoted(backend('mediaserver/client.ts').match(/export const MEDIA_ERRORS = \[([^\]]+)\]/)![1]!);
  const SETUP_CODES = quoted(backend('media/types.ts').match(/export type MediaSetupCode = ([^;]+);/)![1]!);
  const routes = backend('routes/adminMediaserver.ts');
  const ROUTE_CODES = [...new Set([
    ...[...routes.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]!),
    ...quoted(routes.match(/export type OfferReason = ([^;]+);/)![1]!),
    // base-confirm answers its result as the code (409)
    ...quoted(routes.match(/\['ok', 'wrong', 'expired', 'locked', 'no_pending'\]/)![0]).filter((c) => c !== 'ok'),
  ])];
  // backend updater.ts startedJob (a job that did not start) and the updater's own refusals the backend passes on
  const updaterTs = backend('updater.ts');
  const JOB_CODES = [...updaterTs.match(/export function startedJob[\s\S]*?\n}/)![0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  // the move's way back (backend mediaserver/move.ts BackError) and its scan's refusal
  const MOVE_CODES = quoted(backend('mediaserver/move.ts').match(/export type BackError = ([^;]+);/)![1]!);
  const UPDATER_CODES = ['busy', 'no_container', 'container_exists', 'path_invalid', 'path_refused', 'rate_limited', 'not_available', 'invalid_body', 'too_large', 'not_found', 'timeout'];

  it('the backend lists are read (the mirror cannot go stale silently)', () => {
    expect(MEDIA_ERRORS.length).toBeGreaterThan(30);
    expect(MEDIA_ERRORS).toContain('verify_failed');
    expect(SETUP_CODES).toEqual(expect.arrayContaining(['wizard_taken', 'library_name_taken', 'unreachable']));
    expect(MEDIA_ERRORS).toEqual(expect.arrayContaining(['source_missing', 'source_mismatch', 'source_layout', 'source_outside_base', 'source_version', 'no_space', 'adopt_failed', 'ids_mismatch', 'move_aborted', 'source_nested']));
    expect(MOVE_CODES).toEqual(expect.arrayContaining(['jellyfin_unreachable', 'not_moved', 'no_external', 'busy', 'updater_error']));
    expect(ROUTE_CODES).toEqual(expect.arrayContaining(['use_way_back', 'scan_required', 'not_abortable', 'jellyfin_unreachable', 'busy']));
    expect(ROUTE_CODES).toEqual(expect.arrayContaining([
      'ids_in_use', 'library_referenced', 'library_name_taken', 'invalid_body', 'reauth_required', 'unreachable', 'invalid_passphrase', 'length_required',
      'unsupported_media_type', 'updater_error', 'not_managed', 'no_external', 'wrong', 'expired', 'locked', 'no_pending',
    ]));
  });

  it('every code the card can receive has a readable text in all 7 locales; an unknown one still shows its code', async () => {
    const all = [...new Set([...MEDIA_ERRORS, ...SETUP_CODES, ...ROUTE_CODES, ...JOB_CODES, ...UPDATER_CODES, ...MOVE_CODES, 'not_supported', 'busy', 'no_target', 'backup_invalid', 'network'])];
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr'] as const) {
      await setLocale(l);
      const generic = mediaErrorText('zz_not_a_code');
      expect(generic, l).toContain('zz_not_a_code');
      for (const c of all) {
        const t = mediaErrorText(c);
        expect(t, `${l} ${c}`).not.toBe(mediaErrorText('zz_not_a_code').replace('zz_not_a_code', c));
        expect(t, `${l} ${c}`).not.toMatch(/\{\w+\}|\.\.\.|^mediaserver\./);
      }
    }
    await setLocale('de');
    // anything that is no code is never shown as it came
    expect(mediaErrorText('<b>x</b>')).not.toContain('<b>');
    expect(mediaErrorText(null)).not.toContain('null');
    expect(mediaErrorText('verify_failed')).not.toContain('verify_failed');
  });
});

describe('the move from Jellyfin', () => {
  const ID = 'a'.repeat(64);
  const scan = (o: Partial<MoveScan> = {}): MoveScan => ({
    source: { id: ID, name: 'jellyfin', image: 'jellyfin/jellyfin:10.11.0', version: '10.11.0' },
    folders: [{ rel: 'Filme', target: '/movies', migrated: true }, { rel: 'Serien', target: '/tv', migrated: true }], layout: 'official',
    bytes: 38e9, trickplayBytes: 12e9, plugins: ['Open Subtitles', 'Fanart'], nfo: true, ...o,
  });
  const state = (o: Partial<MoveState> = {}): MoveState => ({ phase: 'copying', error: null, jobId: 'j', startedAt: '2026-11-24T10:00:00.000Z', step: null, abort: false, ...o });
  const move = (o: Partial<MoveView> = {}): MoveView => ({ offered: false, reason: null, scan: null, state: null, migratedFrom: null, sourceState: null, requestsWarning: false, ...o });
  const moving = (st: Partial<MoveState>, o: Partial<MediaView> = {}) => view({ move: move({ state: state(st) }), ...o });
  const rows = (v: MediaView) => moveSteps(v).map((r) => `${r.step}:${r.state}`).join(' ');

  it('moveSummary: the folders as Ferrofin sees them, the copy with or without trickplay, the plugins left behind', () => {
    expect(moveSummary(scan(), false)).toEqual({ folders: ['/movies', '/tv'], bytes: 38e9, downtimeMin: 13, plugins: ['Open Subtitles', 'Fanart'] });
    expect(moveSummary(scan(), true)).toMatchObject({ bytes: 50e9, downtimeMin: 17 });
    // the whole base as one folder
    expect(moveSummary(scan({ folders: [{ rel: '', target: '/media', migrated: true }], plugins: [] }), false)).toMatchObject({ folders: ['/media'], plugins: [] });
  });

  it('moveSummary: the downtime is at least one minute (50 MB/s), whole minutes up', () => {
    expect(moveSummary(scan({ bytes: 0, trickplayBytes: 0 }), true).downtimeMin).toBe(1);
    expect(moveSummary(scan({ bytes: 1e6 }), false).downtimeMin).toBe(1);
    expect(moveSummary(scan({ bytes: 3e9 }), false).downtimeMin).toBe(1);
    expect(moveSummary(scan({ bytes: 3e9 + 1 }), false).downtimeMin).toBe(2);
  });

  it('moveSteps: the updater\'s steps, then the backend\'s phases, in a fixed order', () => {
    expect([...MOVE_STEPS]).toEqual(['copy_bulk', 'stop_source', 'copy', 'create', 'start', 'health', 'adopt', 'nfo', 'verify', 'switch', 'requests']);
    expect(moveSteps(view()).every((r) => r.state === 'todo')).toBe(true);
    expect(moveSteps(view()).map((r) => r.step)).toEqual([...MOVE_STEPS]);
    // the check, pull and image verify before the copy: the copy is the step under way
    for (const step of ['check', 'pull', 'verify', 'snapshot'] as const) expect(rows(moving({ step })), step).toMatch(/^copy_bulk:running stop_source:todo/);
    expect(rows(moving({ step: 'stop_source' }))).toMatch(/^copy_bulk:done stop_source:running copy:todo/);
    expect(rows(moving({ step: 'adopt' }))).toMatch(/health:done adopt:running nfo:todo/);
    // a rollback belongs to the deploy (create, start, health)
    expect(rows(moving({ step: 'rollback' }))).toMatch(/start:done health:running adopt:todo/);
    // copied, the backend has not taken it yet: its first phase is next
    expect(rows(moving({ step: null }, { status: status({ move: { phase: 'ready', step: null, source: { name: 'jellyfin', version: '10.11.0' }, folders: [], abort: false } }) }))).toMatch(/adopt:done nfo:running verify:todo/);
    expect(rows(moving({ step: null }))).toMatch(/^copy_bulk:running/);
    expect(rows(moving({ phase: 'nfo' }))).toMatch(/adopt:done nfo:running verify:todo/);
    expect(rows(moving({ phase: 'verify' }))).toMatch(/nfo:done verify:running switch:todo/);
    expect(rows(moving({ phase: 'switch' }))).toMatch(/verify:done switch:running requests:todo$/);
    expect(rows(moving({ phase: 'requests' }))).toMatch(/switch:done requests:running$/);
    expect(moveSteps(moving({ phase: 'done' })).every((r) => r.state === 'done')).toBe(true);
  });

  it('moveSteps: a failure in the copy marks the step it stopped at; one in a backend phase marks that phase (failedIn)', () => {
    expect(rows(moving({ phase: 'failed', error: 'no_space', step: 'check', failedIn: 'copying' }))).toMatch(/^copy_bulk:failed stop_source:todo/);
    expect(rows(moving({ phase: 'failed', error: 'adopt_failed', step: 'adopt', failedIn: 'copying' }))).toMatch(/health:done adopt:failed nfo:todo/);
    // the updater clears its step once its job succeeded: the backend's phase names the row
    expect(rows(moving({ phase: 'failed', error: 'unreachable', step: null, failedIn: 'nfo' }))).toMatch(/^(\w+:done ){7}nfo:failed verify:todo switch:todo requests:todo$/);
    expect(rows(moving({ phase: 'failed', error: 'ids_mismatch', failedIn: 'verify', errorMeta: { users: { total: 4, missing: 1 }, items: { sampled: 200, missing: 9 } } })))
      .toMatch(/^(\w+:done ){8}verify:failed switch:todo requests:todo$/);
    expect(rows(moving({ phase: 'failed', error: 'unexpected', failedIn: 'switch' }))).toMatch(/^(\w+:done ){9}switch:failed requests:todo$/);
    // an abort during the id check: that row, whatever step the job's record still holds
    expect(rows(moving({ phase: 'failed', error: 'move_aborted', step: 'adopt', failedIn: 'verify' }))).toMatch(/nfo:done verify:failed switch:todo/);
    // an older record without failedIn: the id check for ids_mismatch, else no row (the result line says why)
    expect(rows(moving({ phase: 'failed', error: 'ids_mismatch' }))).toMatch(/nfo:done verify:failed switch:todo/);
    expect(moveSteps(moving({ phase: 'failed', error: 'move_aborted' })).every((r) => r.state === 'todo')).toBe(true);
    // a copy failure whose step is gone marks none either
    expect(moveSteps(moving({ phase: 'failed', error: 'interrupted', failedIn: 'copying' })).every((r) => r.state === 'todo')).toBe(true);
  });

  it('moveActive, moveAbortable, backActive, moveFollow: what the card follows and offers', () => {
    expect(moveActive(view())).toBe(false);
    for (const phase of ['copying', 'nfo', 'verify', 'switch', 'requests'] as const) expect(moveActive(moving({ phase })), phase).toBe(true);
    for (const phase of ['done', 'failed'] as const) expect(moveActive(moving({ phase })), phase).toBe(false);
    for (const phase of ['copying', 'nfo', 'verify'] as const) expect(moveAbortable(moving({ phase })), phase).toBe(true);
    for (const phase of ['switch', 'requests', 'done', 'failed'] as const) expect(moveAbortable(moving({ phase })), phase).toBe(false);
    // an abort asked for already
    expect(moveAbortable(moving({ phase: 'copying', abort: true }))).toBe(false);
    for (const back of ['starting', 'switched', 'stopped'] as const) expect(backActive(moving({ phase: 'done', back })), back).toBe(true);
    for (const back of ['done', 'failed'] as const) expect(backActive(moving({ phase: 'done', back })), back).toBe(false);
    expect(moveFollow(view())).toBe(false);
    expect(moveFollow(moving({ phase: 'nfo' }))).toBe(true);
    expect(moveFollow(moving({ phase: 'done', back: 'switched' }))).toBe(true);
    expect(moveFollow(view({ move: move({ scan: { source: ID, state: 'running', at: '2026-11-24T10:00:00.000Z' } }) }))).toBe(true);
    expect(moveFollow(view({ move: move({ scan: { source: ID, state: 'done', result: scan(), at: '2026-11-24T10:00:00.000Z' } }) }))).toBe(false);
    // an older backend without the move
    expect(moveFollow({ ...view(), move: undefined })).toBe(false);
    expect(moveSteps({ ...view(), move: undefined }).every((r) => r.state === 'todo')).toBe(true);
  });

  it('autoCandidate: the one candidate that can be the source; scanFresh: a done scan of it, at most 9 minutes old', () => {
    const c = (o: Partial<MoveCandidate>): MoveCandidate => ({ id: ID, name: 'jellyfin', image: 'jellyfin/jellyfin:10.11.0', state: 'running', matches: true, ...o });
    expect(autoCandidate([c({})])?.id).toBe(ID);
    expect(autoCandidate([c({ matches: null })])?.id).toBe(ID);
    expect(autoCandidate([c({ matches: false })])).toBeNull();
    expect(autoCandidate([])).toBeNull();
    expect(autoCandidate([c({}), c({ id: 'b'.repeat(64), name: 'jellyfin-alt', matches: null })])).toBeNull();
    // the others are not the server FriendFlix uses
    expect(autoCandidate([c({}), c({ id: 'b'.repeat(64), matches: false })])?.id).toBe(ID);
    const at = '2026-11-24T10:00:00.000Z', t0 = Date.parse(at);
    const rec = { source: ID, state: 'done' as const, result: scan(), at };
    expect(scanFresh(rec, ID, t0 + 60_000)).toBe(true);
    expect(scanFresh(rec, ID, t0 + 9 * 60_000 + 1)).toBe(false);
    expect(scanFresh(rec, 'b'.repeat(64), t0)).toBe(false);
    expect(scanFresh({ ...rec, state: 'running', result: undefined }, ID, t0)).toBe(false);
    expect(scanFresh(null, ID, t0)).toBe(false);
  });

  it('moveResult: done, done with the updater\'s warning, failed with its reason and the id check\'s numbers', () => {
    expect(moveResult(null)).toBeNull();
    expect(moveResult(state({ phase: 'nfo' }))).toBeNull();
    expect(moveResult(state({ phase: 'done' }))).toEqual({ ok: true, text: tr('mediaserver.move.done') });
    expect(moveResult(state({ phase: 'done', errorMeta: { warning: 'updater_aborted' } }))?.text).toContain(tr('mediaserver.move.updaterAborted'));
    const failed = moveResult(state({ phase: 'failed', error: 'no_space' }))!;
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain(mediaErrorText('no_space'));
    const ids = moveResult(state({ phase: 'failed', error: 'ids_mismatch', errorMeta: { users: { total: 4, missing: 1 }, items: { sampled: 200, missing: 9 } } }))!.text;
    expect(ids).toContain(mediaErrorText('ids_mismatch'));
    expect(ids).toMatch(/4\b[\s\S]*1\b[\s\S]*200[\s\S]*9\b/);
  });

  it('sourceLine: the old Jellyfin stopped, running or gone', () => {
    expect(sourceLine(view())).toBeNull();
    expect(sourceLine(view({ move: move({ sourceState: 'exited' }) }))).toBe('stopped');
    expect(sourceLine(view({ move: move({ sourceState: 'created' }) }))).toBe('stopped');
    expect(sourceLine(view({ move: move({ sourceState: 'running' }) }))).toBe('running');
    expect(sourceLine(view({ move: move({ sourceState: 'restarting' }) }))).toBe('running');
    expect(sourceLine(view({ move: move({ sourceState: 'missing' }) }))).toBe('missing');
    expect(sourceLine(view({ move: move({ sourceState: 'dead' }) }))).toBeNull();
  });

  it('the move texts in all 7 locales: no placeholder left, the spec\'s German lines verbatim', async () => {
    const de_ = JSON.stringify((de as Record<string, unknown>).mediaserver);
    for (const w of ['Von Jellyfin umziehen', 'Erneut umziehen', 'Zurück zu Jellyfin', 'Umziehen', 'gleich in Ferrofin', '(ohne Trickplay)', 'Trickplay mitnehmen',
      'Laufende Wiedergaben brechen ab.', 'wird auf Ferrofin umgestellt.', 'wird danach gestoppt, bleibt für den Rückweg erhalten.', 'jederzeit mit einem Klick. Was auf Ferrofin geschaut wird, bleibt dort.',
      'Was seit dem Umzug auf Ferrofin geschaut wurde, ist in Jellyfin nicht drin.', 'Altes Jellyfin ist gestoppt und bleibt für den Rückweg erhalten.', 'Basisordner ändern', 'Wunsch-Dienst', 'Altes Jellyfin',
      'bis zu etwa', 'aus Jellyfin übernommen']) {
      expect(de_, w).toContain(w);
    }
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr'] as const) {
      await setLocale(l);
      const texts = [
        tr('mediaserver.move.titleFrom', { name: 'jellyfin' }), tr('mediaserver.move.folders', { list: '/movies, /tv' }), tr('mediaserver.move.copy', { size: '38 GB' }),
        tr('mediaserver.move.trickplay', { size: '12 GB' }), tr('mediaserver.move.downtime', { n: 4 }), tr('mediaserver.move.downtime', { n: 1 }),
        tr('mediaserver.move.moved', { name: 'jellyfin', date: '24.11.2026' }), tr('mediaserver.move.idsMismatch', { users: 4, usersMissing: 1, items: 200, itemsMissing: 9 }),
        tr('mediaserver.move.failed', { reason: 'x' }), tr('mediaserver.move.backFailed', { reason: 'x' }), tr('mediaserver.move.scanning', { name: 'jellyfin' }),
        tr('mediaserver.move.plugins', { list: '„Fanart“' }), ...MOVE_STEPS.map((s) => tr(`mediaserver.move.step.${s}`)),
      ];
      for (const t of texts) expect(t, `${l}: ${t}`).not.toMatch(/\{\w+\}|\.\.\.|^mediaserver\./);
      expect(tr('mediaserver.move.requestsWarning'), l).toContain('mediaserver');
      expect(tr('mediaserver.move.requestsWarning'), l).toContain('8096');
    }
  });
});

describe('admin_missing names the way that is offered', () => {
  it('*Entfernen*, then *Einrichten* (never *Neu anlegen*, which the cases giving this code do not show), in all 7 locales', async () => {
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr'] as const) {
      await setLocale(l);
      const text = mediaErrorText('admin_missing');
      expect(text, l).toContain(tr('mediaserver.action.remove'));
      expect(text, l).toContain(tr('mediaserver.apply.setup'));
      expect(text, l).not.toContain(tr('mediaserver.status.recreate'));
    }
  });
});

describe('mediaserver area in every language', () => {
  type Tree = Record<string, unknown>;
  const keyOrder = (o: Tree, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !('other' in (v as Tree)) ? keyOrder(v as Tree, `${p}${k}.`) : [`${p}${k}`]));
  it('identical key order in all seven locales, placed right after syscheck', () => {
    const ref = keyOrder((de as Tree).mediaserver as Tree);
    expect(ref.length).toBeGreaterThan(100);
    for (const [name, d] of Object.entries({ en, es, fr, it: it_, pl, tr: tr_ })) {
      expect(keyOrder((d as Tree).mediaserver as Tree), name).toEqual(ref);
      const areas = Object.keys(d as Tree);
      expect(areas[areas.indexOf('syscheck') + 1], name).toBe('mediaserver');
    }
  });

  it('the spec\'s German names verbatim; never "..." and no other product name', () => {
    const flat = JSON.stringify((de as Tree).mediaserver);
    for (const w of ['Ferrofin (eigener)', 'Jellyfin (offiziell, verwaltet)', 'Bestehender Jellyfin/Plex (Adresse)', 'Code anfordern', 'Einrichten', 'Übernehmen', 'Starten', 'Stoppen',
      'Neu starten', 'Aktualisieren', 'Sicherung', 'Wiederherstellen', 'Protokoll', 'Entfernen', 'Neu anlegen', 'Nochmal', 'Erneut versuchen', 'Herunterladen',
      'Aus Datei wiederherstellen', 'HDR-Test', 'Test', 'Wechsel von Plex: kommt mit Stufe 4', 'neuer als dieser FriendFlix-Stand']) {
      expect(flat, w).toContain(w);
    }
    for (const d of [de, en, es, fr, it_, pl, tr_]) {
      const ms = (d as Tree).mediaserver as Record<string, Record<string, string>>;
      const s = JSON.stringify(ms);
      expect(s).not.toContain('...');
      expect(s).not.toMatch(/netflix|seerr/i);
      // stage 2 is here: the id reasons no longer promise it
      expect(`${ms.reason!.ids_in_use} ${ms.error!.ids_in_use}`).not.toMatch(/2/);
    }
    // the app's own word for the request service (Admin, Systemcheck), never another
    expect(flat).not.toContain('Anfrage');
  });
});
