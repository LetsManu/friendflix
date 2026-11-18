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
import type { MediaManaged, MediaStatus, MediaView } from './api';
import {
  ACTION_ORDER, DEFAULT_MANAGED, TRIAL_KINDS, actionsFor, choiceDisabled, codeLogHint, countdown, currentChoice, folderRowsError, idError, initialRows,
  defaultName, keptLibraries, kindName, livetvOffer, mediaErrorText, saveErrorText, nameTakenRow, passphraseError, pinState, reasonText, setupSteps, statusStarting, versionCmp,
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
  });

  it('the reasons read as the spec words them', () => {
    expect(reasonText('ids_in_use')).toBe('Umzug von deinem Jellyfin: kommt mit Stufe 2');
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
  const UPDATER_CODES = ['busy', 'no_container', 'container_exists', 'path_invalid', 'path_refused', 'rate_limited', 'not_available', 'invalid_body', 'too_large', 'not_found', 'timeout'];

  it('the backend lists are read (the mirror cannot go stale silently)', () => {
    expect(MEDIA_ERRORS.length).toBeGreaterThan(30);
    expect(MEDIA_ERRORS).toContain('verify_failed');
    expect(SETUP_CODES).toEqual(expect.arrayContaining(['wizard_taken', 'library_name_taken', 'unreachable']));
    expect(ROUTE_CODES).toEqual(expect.arrayContaining([
      'ids_in_use', 'library_referenced', 'library_name_taken', 'invalid_body', 'reauth_required', 'unreachable', 'invalid_passphrase', 'length_required',
      'unsupported_media_type', 'updater_error', 'not_managed', 'no_external', 'wrong', 'expired', 'locked', 'no_pending',
    ]));
  });

  it('every code the card can receive has a readable text in all 7 locales; an unknown one still shows its code', async () => {
    const all = [...new Set([...MEDIA_ERRORS, ...SETUP_CODES, ...ROUTE_CODES, ...JOB_CODES, ...UPDATER_CODES, 'not_supported', 'busy', 'no_target', 'backup_invalid', 'network'])];
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
      'Aus Datei wiederherstellen', 'HDR-Test', 'Test', 'Umzug von deinem Jellyfin: kommt mit Stufe 2', 'Wechsel von Plex: kommt mit Stufe 4', 'neuer als dieser FriendFlix-Stand']) {
      expect(flat, w).toContain(w);
    }
    for (const d of [de, en, es, fr, it_, pl, tr_]) {
      const s = JSON.stringify((d as Tree).mediaserver);
      expect(s).not.toContain('...');
      expect(s).not.toMatch(/netflix|seerr/i);
    }
  });
});
