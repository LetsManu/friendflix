// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ltvStatusMock, ltvStatusRoute, type LtvStatusMock } from './livetvStatus.js';
import { advanceLivetvJob, livetvJob, type LivetvJobOutcome } from './updater.js';
/**
 * Admin API fixtures for the mocked FriendFlix backend (shapes follow backend/src/routes/admin.ts, seerr.ts, polls.ts,
 * hubs.ts, digest.ts). Stateful: mutations change the state, so specs can assert what the UI did.
 * Wired into installApi (mocks/api.ts); switch the session to an admin with `api.asAdmin = true` before page.goto().
 */

const NOW = Date.now();
const ago = (h: number): string => new Date(NOW - h * 3600e3).toISOString();
const fut = (h: number): string => new Date(NOW + h * 3600e3).toISOString();
/** access_until set and not in the future (the backend refuses to unlock such an account: 409 access_expired) */
const accessEnded = (until: string | null): boolean => until !== null && Date.parse(until) <= Date.now();
/** uuid-shaped ids (the backend validates uuids for users/devices) */
export const auid = (n: number): string => `00000000-0000-4000-a000-${n.toString().padStart(12, '0')}`;

export interface AdminUser { id: string; name: string; email: string | null; role: string; disabled: boolean; jellyfin_username: string; seerr_user_id: number | null; created_at: string; last_seen: string | null; access_until?: string | null; profiles?: number; /** why a locked account is locked (default manual) */ locked_reason?: 'manual' | 'expired' | 'deletion'; /** scheduled deletion (Block 23 self-service) */ deletion_at?: string | null; /** claimed by the deletion tick, users row still there (steps 1-4) */ cleanup?: { step: number; error: string | null };
  /** switch overrides of the person (user_limits.perms; backend counts them in `overrides`), the other stored overrides (limits), the admin's note, no 2FA at the sign-in provider */
  perms?: Record<string, boolean>; otherOverrides?: number; /** the stored non-switch overrides in the PUT encoding (null never stored; 'unlimited' lifts a cap); their count is `otherOverrides` once written */ ov?: Record<string, unknown>; kidsProfiles?: number; note?: string | null; mfaOff?: boolean }
/** a claimed deletion whose users row is gone (status=deleting lists it by pseudonym); step = the step in work (1-6) */
export interface AdminCleanup { id: string; pseudonym: string; started_at: string; step: number; error: string | null }
export interface AdminDevice { user_id: string; device_id: string; label: string; approved: boolean; last_seen: string; name: string; /** the admin's own device (backend: current) */ current?: boolean; /** TV devices (`tv-…` ids): opens Live TV at start (devices.start_live) */ startLive?: boolean }
export interface AdminRequest { id: number; title: string; mediaType: 'movie' | 'tv'; requestedBy: string; status: string; createdAt: string }
export interface AdminInvite { id: string; role: string; note: string | null; expires_at: string; used_at: string | null; used_by_name: string | null; uses: number; max_uses: number; access_days: number | null }
/** open approval request (GET /api/admin/approvals) */
export interface AdminApproval { id: string; name: string; email: string | null; requested_at: string }
export interface PreviewRow { itemId: string; name: string; type: string; status: 'ok' | 'failed' | 'missing' | 'preparing'; bytes: number | null; audioLang: string | null; error: string | null; createdAt: string | null }
export interface ConvMock {
  limit: number; auto: number; custom: number | null; priority: 'films' | 'live' | 'equal';
  running: Array<{ kind: 'film' | 'live' | 'record' | 'download' | 'reencode'; hevc: boolean; label: string | null; since: string | null; device: string | null }>;
  bench: { jellyfin: { speed: number; hwAccel: string; at: string } | null; livetv: { speed: number; encoder: string; at: string } | null; recommended: number | null; stale: boolean; noRealtime: boolean };
  measure: { running: boolean; busy: 'watching' | 'unknown' | null; last: { outcome: 'ok' | 'failed' | 'no_title' | 'busy' | 'no_user' | 'unsupported'; at: string | null } | null };
  /** POST /api/admin/conversions/benchmark calls so far; the next answer (default 202 started, the measurement then runs) */
  posts: number;
  benchAnswer: { status: number; body: Record<string, unknown> } | null;
}
export interface AuditRow { id: number; at: string; action: string; target: string | null; meta: Record<string, unknown>; actor: string | null; target_name: string | null }

export const ROLES = {
  admin: { label: 'Admin', builtinLabel: true }, friend: { label: 'Freund', builtinLabel: true }, family: { label: 'Familie', builtinLabel: true }, guest: { label: 'Gast', builtinLabel: true },
};
const NAMES = ['Anna Beispiel', 'Ben Test', 'Clara Fischer', 'David Müller', 'Emma Schneider', 'Felix Weber', 'Greta Wagner', 'Hannes Becker', 'Ida Hoffmann', 'Jonas Schäfer', 'Katharina Bauer-Langenberger', 'Leon Richter'];

export interface AdminState {
  users: AdminUser[];
  devices: AdminDevice[];
  /** every request; the list endpoint filters by state */
  requests: AdminRequest[];
  invites: AdminInvite[];
  /** accounts made from an invite (GET /api/admin/invites/:id/uses) */
  inviteUses: Record<string, Array<{ id: string; name: string; email: string | null; role: string; disabled: boolean; at: string }>>;
  approvals: AdminApproval[];
  audit: AuditRow[];
  polls: Array<{ id: string; title: string; creator: string; winnerOptionId: string; closesAt?: string; options: Array<{ id: string; title: string; votes?: number; inLibrary?: boolean }> }>;
  lists: Array<{ id: string; name: string; owner: { id: string; name: string }; itemCount: number; featured: boolean }>;
  hubs: Array<{ id: string; name: string; source: string; sourceValue: string; accent?: string | null; imageItemId?: string | null; enabled: boolean }>;
  /** hover-preview clips of the library (content pages) */
  previews: PreviewRow[];
  /** Admin → Wiedergabe-Check, card Umwandlungen (GET/POST /api/admin/conversions; backend ConversionsView): limit / custom / priority follow the CONVERSION_* settings (mocks/api.ts) */
  conv: ConvMock;
  /** streams running right now (/api/admin/live) */
  live: Array<{ userId: string; userName: string; profileName: string | null; playSessionId: string; itemId: string; title: string; seriesName: string | null; type: string | null; positionTicks: number; runtimeTicks: number | null; isPaused: boolean; updatedAt: string; source: string }>;
  /** Seerr reachable (summary.services.seerr, request counts) */
  seerrUp: boolean;
  /** make GET /api/admin/summary fail (500) */
  summaryFails: boolean;
  /** Admin -> Live-TV (enable card, enable / disable) */
  livetv: LivetvMock;
  /** recommendation item index (summary.recoIndex) */
  recoIndex: { supported: boolean; running: boolean; items: number; updatedAt: string | null };
  /** removal dates ("Bald weg", /api/admin/leaving) */
  leaving: LeavingRow[];
  /** optional TMDB/OMDb keys (/api/admin/sources); the real API never returns more than last4 */
  sources: SourceRow[];
  /** Block 22: health snapshot (/api/admin/health); `healthRefreshed` replaces it on ?refresh=1 */
  health: Record<string, any>;
  healthRefreshed: Record<string, any> | null;
  /** query strings of /api/admin/health calls ('' or '?refresh=1') */
  healthCalls: string[];
  /** Block 23 phase 3: /api/admin/health/login (backend flowCheck.ts LoginCheck) */
  loginCheck: Record<string, any>;
  /** POST /api/admin/authentik/repair: the bodies received and the answer (the result's `check` replaces loginCheck) */
  repairs: Array<Record<string, unknown>>;
  repairReply: Record<string, any> | null;
  /** /api/admin/streams */
  streams: Record<string, any>;
  /** /api/admin/errors */
  errors: { entries: Array<Record<string, any>>; overflow: number };
  /** Block 22 banner: the snapshot's issues (/api/admin/health/banner minus dismissals), dismissals by id → fp, number of banner calls */
  bannerIssues: Array<{ id: string; level: 'warn' | 'err'; reason: string; fp: string; detail?: { n?: number; pct?: number } }>;
  dismissed: Record<string, string>;
  bannerCalls: number;
  bannerFails: boolean;
  /** Block 22 library hygiene (/api/admin/hygiene*): rows with every issue, ignored "itemId|code" pairs, scan state */
  hygiene: HygieneMock;
  /** Block 22 usage (/api/admin/usage*): query strings of the list calls, user ids of detail calls, `since` */
  usageCalls: string[];
  usageDetailCalls: string[];
  usageSince: string | null;
  /** accounts the next bulk `repair` fails on (the answer is then `{ done, failed }`) */
  repairFails: Set<string>;
  /** Block 23 user detail (/api/admin/users/:id*): Authentik state (mfa null = no Authentik API), link health, limits, profiles, activity calls */
  detailMfa: { totp: boolean; webauthn: boolean; static: boolean } | null;
  /** Block 23 self-service: deletions whose users row is gone, and ids the deletion tick has claimed (restore answers 409) */
  cleanups: AdminCleanup[];
  claimed: Set<string>;
  authentik: { recovery: boolean; mfaSetup: boolean };
  linkedOk: { jellyfin: boolean | null; requests: boolean };
  limits: Record<string, DetailLimits>;
  userProfiles: Record<string, DetailProfile[]>;
  /** the cap a profile had before it stopped being a kids profile (the DB column keeps it) */
  keptCap: Map<string, number>;
  /** the last profile number handed out (new kids profiles) */
  profileSeq: number;
  /** the media server refuses the policy of the next kids changes (PATCH …/profiles/:pid → 502 jellyfin, stored and audited anyway) */
  profileMediaFails: boolean;
  /** Sicht prüfen: when each /check request came (the route allows 30 a minute, then 429) */
  checkTimes: number[];
  /** Sicht prüfen on an adapter that hides unrated titles under any cap (Plex: an explicit age null): a grown-up's cap hides them as `unrated` */
  checkHidesUnrated: boolean;
  activityCalls: number;
  /** licences revoked via DELETE /api/admin/downloads/:id */
  revokedLicences: string[];
  /** the role matrix behind GET/PUT/POST/DELETE /api/admin/roles* (spec §4.1) */
  matrix: MatrixMock;
}
/**
 * Admin -> Live-TV (backend/src/livetv/adminRoutes.ts): the state the page polls, enable and disable. An enable job moves one step per
 * GET of the state and, after `jobPolls` of them, ends with `outcome`: succeeded flips `installed` after the detection lag (no reload on the page). A refused
 * request (no updater, foreign stack, busy, `refuse`) leaves `wanted` as it was.
 */
export interface LivetvMock {
  installed: boolean;
  /** what the admin asked for (LIVETV_WANTED) */
  wanted: boolean;
  /** LIVETV_OFFER_HIDDEN, kept in step with the settings row by mocks/api.ts */
  offerHidden: boolean;
  /** an updater answers (status.stack says whose stack it is) */
  updater: boolean;
  stack: 'own' | 'foreign' | null;
  ltState: 'absent' | 'disabled' | 'enabled' | 'stop_failed';
  ltError: string | null;
  /** an updater from before livetv: its status carries no livetv (null), POST answers 409 updater_outdated */
  ltOld: boolean;
  /** an updater that answers but refuses the backend's signature (unauthorized) or garbles (invalid_answer) */
  updaterError: 'unauthorized' | 'invalid_answer' | null;
  job: any;
  tick: number;
  jobPolls: number;
  outcome: LivetvJobOutcome;
  failCode: string | null;
  benchmark: 'started' | 'busy' | 'running' | 'no_user' | 'unsupported' | 'error' | null;
  advice: { level: 'warn' | 'info' | 'ok'; key: string; driver?: string } | null;
  /** the next enable / disable answers this (status, code) */
  refuse: { status: number; error: string } | null;
  failedSources: number;
  /** after a succeeded enable the detection needs this many more GETs of the state before `installed` flips (the page says "wird geprüft") */
  detectLag: number;
  /**
   * after a succeeded disable / remove the same for `installed` going false: the real backend's detection is cached, so the job's
   * end never flips it at once (1b review I4); the page has to keep asking
   */
  offLag: number;
  lagLeft: number;
  /** what `installed` becomes when lagLeft runs out */
  lagTo: boolean;
  /** GET state calls and the POSTed bodies, in order */
  gets: number;
  posts: Array<{ path: 'enable' | 'disable'; body: any }>;
  /** the installed area's *Quellen* tab (Task 21, built on the contracts of Tasks 15, 16, 20) */
  area: LivetvAreaMock;
  /** the *Live-Status* tab and the guide counts (Task 26, mocks/livetvStatus.ts) */
  status: LtvStatusMock;
}
/** a source as `GET /api/admin/livetv/sources` answers it (backend SourceView, Task 15): never a URL, only `urlHint` / `epgHint` */
export interface LtvSourceMock {
  id: string; kind: 'm3u' | 'feeds'; name: string; urlHint: string | null; epgHint: string | null; userAgent: string | null; allowLan: boolean;
  refresh: '6h' | '12h' | '24h' | 'weekly' | 'manual'; skipGroups: string[]; numbering: 'chno' | 'order'; numberBase: number; logoPref: 'm3u' | 'xmltv';
  epgShiftMin: number; maxStreams: number | null; enabled: boolean; position: number; channelCount: number; pendingGroups: number;
  state: {
    lastRefreshAt: string | null; lastOkAt: string | null; lastError: string | null; counts: { channels: number; added: number; removed: number } | null;
    epg: { lastRefreshAt: string | null; lastOkAt: string | null; lastError: string | null; programmes: number | null };
  };
}
/**
 * an own feed (a channel of the `feeds` source): the AdminChannel fields the card reads (plan Task 19, backend ownfeeds.ts); `push` only
 * on push feeds (`hint` = 'ff-' + 6, no ellipsis; `portInRange` is computed from `ports` when answered); `ingest` = what livetv's
 * GET /v1/ingest says about a push feed (`pending` = livetv does not know it yet)
 */
export interface LtvFeedMock {
  id: string; sourceId: string; name: string; number: number | null; streamKind: 'hls' | 'ts' | 'srt';
  push?: { port: number; hint: string };
  ingest: { state: 'receiving' | 'idle' | 'pending'; rejected1h: number } | null;
  /** hidden channel: withdrawn from livetv (ingest state `off`, as for a disabled source) */
  hidden?: boolean;
}
/**
 * a channel of the *Kanäle* tab (Task 23, on backend adminChannels.ts `AdminChannel`): the import values and the overrides are kept apart, so
 * the view can answer `overridden` and the reset can drop them; `shiftOv` is `epg_shift_override_min`, `base` the inherited offset
 */
export interface LtvChanMock {
  id: string; sourceId: string; streamKind: 'hls' | 'ts' | 'srt'; ingest: 'pull' | 'push';
  importName: string; importNumber: number | null; importGroup: string | null;
  nameOv: string | null; numberOv: number | null; groupOv: string | null; logoHash: string | null; logoOv: boolean;
  hidden: boolean; missing: boolean; epg: boolean; epgOff: boolean;
  base: { min: number; from: 'list' | 'source' | 'none' }; shiftOv: number | null;
  mode: 'passthrough' | 'remux' | 'transcode' | null; probeError: string | null;
  push?: { port: number; hint: string };
}
export const LTV_GROUP_NAMES: Record<string, string> = { 'g-regional': 'Regional', 'g-sport': 'Sport' };
/** a channel group as `GET /api/admin/livetv/groups` answers it (backend GroupView, Task 18) */
export interface LtvGroupMock { id: string; name: string; kidFriendly: boolean; roles: string[]; released: boolean; position: number; channels: number; providerGroups: string[] }
export interface LivetvAreaMock {
  sources: LtvSourceMock[];
  /** the *Kanäle* list (Task 23) and the query strings of its list requests */
  channels: LtvChanMock[];
  chQueries: string[];
  /** the next stream test(s): the probe facts, or a refusal; `chTestBusy` answers 409 test_running once */
  chTest: { ok: true } | { ok: false; error: string } | { status: number; error: string };
  chTestBusy: boolean;
  /** the next stream tests answer a preview (the channel could start): url and token of a test token */
  chPreview: boolean;
  /** the raw logo uploads that reached the server */
  logoPuts: Array<{ id: string; type: string; bytes: number }>;
  feeds: LtvFeedMock[];
  /** *Gruppen & Rechte* (Task 25): the groups, and the per-person exceptions by user id (livetv_group_users) */
  groups: LtvGroupMock[];
  exceptions: Record<string, { allow: string[]; deny: string[] }>;
  /** LIVETV_SRT_PORTS as livetv's /v1/system reports it, and the host shown to encoders (LIVETV_SRT_HOST) */
  ports: number[];
  /** livetv reports its range (false: `GET /ingest` answers `ports: null`, every feed `error`) */
  portsKnown: boolean;
  host: string | null;
  /** the answer of POST /sources/test: the result, or a 422 code */
  test: { channels: number; groups: Array<{ name: string; channels: number }>; samples: string[]; epgChannels: number | null; epgError: string | null } | { error: string; status?: number };
  /** the next POST /sources/test answers 409 test_running once (another check of this admin still runs) */
  testBusy: boolean;
  /** whether livetv takes the new ingest set on push writes (`synced` of Task 20's answers) */
  synced: boolean;
  /** a started refresh finishes after this many GETs of /sources, with this outcome */
  refreshPolls: number;
  refreshOutcome: { counts: { channels: number; added: number; removed: number } } | { error: string };
  refreshing: Record<string, number>;
  /** livetv's GET /v1/ingest fails: every push feed in range is `error` */
  ingestFails: boolean;
  /** every write, in order (method, path, body) */
  calls: Array<{ m: string; p: string; body: any }>;
  seq: number;
}
const ltvState = (o: Partial<LtvSourceMock['state']> = {}): LtvSourceMock['state'] => ({
  lastRefreshAt: null, lastOkAt: null, lastError: null, counts: null, epg: { lastRefreshAt: null, lastOkAt: null, lastError: null, programmes: null }, ...o,
});
const ltvSource = (o: Partial<LtvSourceMock> & Pick<LtvSourceMock, 'id' | 'kind' | 'name'>): LtvSourceMock => ({
  urlHint: null, epgHint: null, userAgent: null, allowLan: false, refresh: '24h', skipGroups: [], numbering: 'chno', numberBase: 1, logoPref: 'm3u', epgShiftMin: 0,
  maxStreams: null, enabled: true, position: 0, channelCount: 0, pendingGroups: 0, state: ltvState(), ...o,
});
/** the provider's 18 groups as `POST /sources/test` lists them (Task 22's picker): 412 channels, "Erwachsene" 100 of them */
export const LTV_GROUPS: Array<{ name: string; channels: number }> = [
  ['DE | Sport', 42], ['DE | Nachrichten', 30], ['DE | Kinder', 20], ['DE | Dokumentation', 25], ['DE | Unterhaltung', 40], ['AT | Sport', 12],
  ['AT | Regional', 18], ['CH | Regional', 15], ['Erwachsene', 100], ['Musik', 22], ['Filme', 30], ['Serien', 28], ['Natur & Tiere', 10],
  ['Wetter', 5], ['Bergblick Sport', 8], ['Hafenregion', 3], ['Sternwarte', 2], ['Radio-Visuell', 2],
].map(([name, channels]) => ({ name: name as string, channels: channels as number }));
/** 232 channels: the provider's 1…230 (Nordlicht TV first) and the two own feeds 801 / 802 */
function ltvChannels(): LtvChanMock[] {
  const base = (over: Partial<LtvChanMock> & Pick<LtvChanMock, 'id' | 'importName' | 'importNumber'>): LtvChanMock => ({
    sourceId: 'src-nordlicht', streamKind: 'hls', ingest: 'pull', importGroup: 'g-regional', nameOv: null, numberOv: null, groupOv: null, logoHash: null, logoOv: false,
    hidden: false, missing: false, epg: true, epgOff: false, base: { min: 0, from: 'none' }, shiftOv: null, mode: null, probeError: null, ...over,
  });
  const named: Record<number, string> = { 1: 'Nordlicht TV', 2: 'Wetterkanal Küste', 3: 'Bergblick Sport', 4: 'Kids Insel', 5: 'Sternwarte 24' };
  const rows = Array.from({ length: 230 }, (_, i) => base({ id: `ch-${i + 1}`, importName: named[i + 1] ?? `Regionalkanal ${i + 1}`, importNumber: i + 1 }));
  const at = (n: number) => rows[n - 1]!;
  Object.assign(at(1), { base: { min: 60, from: 'list' }, logoHash: 'a'.repeat(64) });
  Object.assign(at(3), { importGroup: 'g-sport', mode: 'passthrough' });
  Object.assign(at(4), { nameOv: 'Kinderinsel', importGroup: null, mode: 'remux' });
  Object.assign(at(5), { epg: false });
  Object.assign(at(7), { hidden: true });
  Object.assign(at(8), { missing: true });
  Object.assign(at(9), { probeError: 'timeout' });
  Object.assign(at(10), { importGroup: 'g-sport', base: { min: -60, from: 'source' } });
  return [
    ...rows,
    base({ id: 'ch-hafen', sourceId: 'src-feeds', importName: 'Hafenkanal', importNumber: 801, importGroup: null, epg: false }),
    base({ id: 'ch-wolkenlos', sourceId: 'src-feeds', importName: 'Kanal Wolkenlos', importNumber: 802, importGroup: null, epg: false, streamKind: 'srt', ingest: 'push', push: { port: 9001, hint: 'ff-QW7RT5' } }),
  ];
}
const ltvGroup = (o: Partial<LtvGroupMock> & Pick<LtvGroupMock, 'id' | 'name' | 'position' | 'channels'>): LtvGroupMock => ({ kidFriendly: false, roles: [], released: true, providerGroups: [], ...o });
export function livetvAreaMock(): LivetvAreaMock {
  const today = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  return {
    sources: [
      ltvSource({
        id: 'src-nordlicht', kind: 'm3u', name: 'Nordlicht Paket', urlHint: 'https://iptv.example.com/…', epgHint: 'https://iptv.example.com/…', channelCount: 412, pendingGroups: 2, position: 0,
        state: ltvState({ lastRefreshAt: today(6, 12), lastOkAt: today(6, 12), counts: { channels: 412, added: 3, removed: 1 }, epg: { lastRefreshAt: today(6, 12), lastOkAt: today(6, 12), lastError: null, programmes: 6812 } }),
      }),
      ltvSource({ id: 'src-feeds', kind: 'feeds', name: 'Eigene Streams', refresh: 'manual', channelCount: 2, position: 1 }),
    ],
    feeds: [
      { id: 'ch-hafen', sourceId: 'src-feeds', name: 'Hafenkanal', number: 801, streamKind: 'hls', ingest: null },
      { id: 'ch-wolkenlos', sourceId: 'src-feeds', name: 'Kanal Wolkenlos', number: 802, streamKind: 'srt', push: { port: 9001, hint: 'ff-QW7RT5' }, ingest: { state: 'receiving', rejected1h: 2 } },
    ],
    // Task 25: five released groups (Kinderinsel + Natur & Tiere are kid-friendly: 11 + 12 = 23 channels), two the import left unreleased (matches the source card's "2 neue Gruppen")
    groups: [
      ltvGroup({ id: 'g-sport', name: 'Sport', roles: ['family', 'friend'], position: 0, channels: 34, providerGroups: ['DE | Sport', 'DE | Sport HD'] }),
      ltvGroup({ id: 'g-nachrichten', name: 'Nachrichten', roles: ['family', 'friend', 'guest'], position: 1, channels: 18, providerGroups: ['DE | News'] }),
      ltvGroup({ id: 'g-kinder', name: 'Kinderinsel', kidFriendly: true, roles: ['family', 'friend'], position: 2, channels: 11, providerGroups: ['DE | Kids'] }),
      ltvGroup({ id: 'g-natur', name: 'Natur & Tiere', kidFriendly: true, roles: ['family'], position: 3, channels: 12, providerGroups: ['DE | Doku Natur'] }),
      ltvGroup({ id: 'g-regional', name: 'Regional', position: 4, channels: 9 }),
      ltvGroup({ id: 'g-kino', name: 'Kinofilme', released: false, position: 5, channels: 41, providerGroups: ['DE | Cinema'] }),
      ltvGroup({ id: 'g-musik', name: 'Musik & Konzert', released: false, position: 6, channels: 27, providerGroups: ['DE | Konzert', 'DE | Musik'] }),
    ],
    exceptions: {},
    ports: Array.from({ length: 10 }, (_, i) => 9000 + i),
    portsKnown: true,
    host: 'friend.example.com',
    test: { channels: 412, groups: LTV_GROUPS, samples: ['Nordlicht TV', 'Hafenkanal', 'Bergblick Sport', 'Kinderinsel', 'Sternwarte 24'], epgChannels: 398, epgError: null },
    refreshPolls: 1,
    refreshOutcome: { counts: { channels: 415, added: 3, removed: 0 } },
    refreshing: {},
    ingestFails: false,
    testBusy: false,
    synced: true,
    channels: ltvChannels(),
    chQueries: [],
    chTest: { ok: true },
    chTestBusy: false,
    chPreview: false,
    logoPuts: [],
    calls: [],
    seq: 0,
  };
}
/** the backend's maskUrl (Task 15): scheme + host + "/…", never a path, query or credentials */
const maskUrl = (raw: string): string => { const u = new URL(raw); return `${u.protocol}//${u.host}/…`; };
export interface MatrixMockRole {
  key: string; label: string | null; builtinLabel: boolean; base: 'family' | 'friend' | 'guest' | 'admin'; origin: 'code' | 'env' | 'admin'; invitable: boolean;
  /** false = an env-only role: not in the roles table (the order write ignores its key) */
  stored: boolean; accounts: number; profiles: number; kidsProfiles: number;
  /** open invites holding the role (a delete needs a target while any exist) */
  invites: number;
  /** an env role whose key left ROLE_TEMPLATES ("nicht mehr in .env"): deletable */
  envGone: boolean;
  values: Record<string, unknown>; sources: Record<string, 'default' | 'env' | 'role' | 'admin'>; missingLibraries: string[];
}
export interface MatrixMock {
  /** which optional features the server reports (a field with `requires` is hidden while its feature is off) */
  features: { requests: boolean; cast: boolean; livetv: boolean };
  /** PUT /api/admin/roles/:role answers 502 policy_partial (settings stored) when a media-enforced field changed */
  policyPartial: boolean;
  /** how many identities the partial failure reports as failed */
  failed: number;
  libraries: Array<{ id: string; name: string }>;
  roles: MatrixMockRole[];
  /** the bodies of the role writes, per role key */
  puts: Array<{ role: string; body: Record<string, unknown> }>;
  /** the role deletes that went through (the target the people moved to) and the key lists of the order writes */
  deletes: Array<{ role: string; moveTo: string | null }>;
  orders: string[][];
}
/** field table of backend/src/perms.ts MATRIX_FIELDS */
export const MATRIX_FIELDS_MOCK: Array<Record<string, unknown>> = [
  { key: 'libraries', group: 'access', kind: 'libraries' },
  { key: 'maxParentalRating', group: 'access', kind: 'rating', options: [null, 0, 6, 12, 16, 18] },
  { key: 'maxStreams', group: 'playback', kind: 'int', min: 1, max: 50 },
  { key: 'maxBitrate', group: 'playback', kind: 'bitrate', min: 300_000, max: 200_000_000 },
  { key: 'remoteMaxBitrate', group: 'playback', kind: 'bitrate', min: 300_000, max: 200_000_000 },
  { key: 'transcoding', group: 'playback', kind: 'bool' },
  { key: 'maxHeight', group: 'playback', kind: 'height', options: [null, 720, 1080, 1440, 2160] },
  { key: 'download', group: 'downloads', kind: 'bool' },
  { key: 'maxDownloads', group: 'downloads', kind: 'int', min: 0, max: 200 },
  { key: 'downloadMaxHeight', group: 'downloads', kind: 'height', options: [480, 720, 1080, 2160] },
  { key: 'downloadDays', group: 'downloads', kind: 'int', min: 1, max: 90 },
  { key: 'requests', group: 'requests', kind: 'bool', requires: 'requests' },
  { key: 'requestsPerMonth', group: 'requests', kind: 'int', min: 0, max: 100, options: [null], requires: 'requests' },
  { key: 'party', group: 'together', kind: 'bool' },
  { key: 'partySchedule', group: 'together', kind: 'bool' },
  { key: 'comments', group: 'together', kind: 'bool' },
  { key: 'cast', group: 'cast', kind: 'bool', requires: 'cast' },
  { key: 'liveTv', group: 'livetv', kind: 'bool', requires: 'livetv' },
  { key: 'liveRecord', group: 'livetv', kind: 'bool', requires: 'livetv' },
];
const PERM_KEYS_MOCK = ['requests', 'cast', 'party', 'partySchedule', 'comments', 'liveTv', 'liveRecord'];
const MEDIA_KEYS_MOCK = ['libraries', 'maxParentalRating', 'maxStreams', 'maxBitrate', 'transcoding', 'maxHeight', 'download'];
const MATRIX_BASE_VALUES: Record<string, unknown> = {
  libraries: 'all', maxParentalRating: null, maxStreams: 2, maxBitrate: 20_000_000, remoteMaxBitrate: 8_000_000, transcoding: true, maxHeight: null,
  download: false, maxDownloads: 15, downloadMaxHeight: 720, downloadDays: 30, requests: true, requestsPerMonth: 3,
  party: true, partySchedule: false, comments: true, cast: true, liveTv: false, liveRecord: false,
};
/** what each mocked role inherits without a role row (code defaults of the built-ins, the env role's ROLE_TEMPLATES values) */
const MATRIX_INHERITED: Record<string, Record<string, unknown>> = {
  admin: { maxStreams: 4, maxBitrate: 40_000_000, download: true, maxDownloads: 25, partySchedule: true },
  family: { maxStreams: 4, maxBitrate: 40_000_000, download: true, maxDownloads: 25, downloadMaxHeight: 1080, partySchedule: true },
  friend: {},
  guest: { maxParentalRating: 12, maxStreams: 1, maxBitrate: 8_000_000, remoteMaxBitrate: 4_000_000, maxHeight: 1080, maxDownloads: 0, downloadMaxHeight: 0, requests: false, party: false, comments: false, cast: false },
  crew: { maxStreams: 3, partySchedule: true },
};
/** the inherited value of a field (PUT null): the role's own entry, else its base's (an admin-made copy) */
const inheritedValue = (r: Pick<MatrixMockRole, 'key' | 'base'>, k: string): unknown => ({ ...MATRIX_BASE_VALUES, ...(MATRIX_INHERITED[r.key] ?? MATRIX_INHERITED[r.base]) })[k];
function matrixRole(key: string, label: string | null, base: MatrixMockRole['base'], origin: MatrixMockRole['origin'], accounts: number, profiles: number, kids: number, stored = true): MatrixMockRole {
  const values = { ...MATRIX_BASE_VALUES, ...MATRIX_INHERITED[key] };
  return {
    key, label, builtinLabel: origin === 'code', base, origin, invitable: key !== 'admin', stored, accounts, profiles, kidsProfiles: kids, invites: 0, envGone: false,
    values, sources: Object.fromEntries(Object.keys(values).map((k) => [k, origin === 'env' ? 'env' : 'default'])), missingLibraries: [],
  };
}
/**
 * An env role whose key the roles table cannot hold (ROLE_TEMPLATES key outside the role-key shape, here with a space and an umlaut): `stored: false`,
 * kept behind the stored roles, no rename / invitable / order. A normal env role (Crew) has a row like any other, as the backend's syncRoles makes it.
 */
export const ENV_ONLY_KEY = 'Küche Crew';
export const envOnlyRole = (): MatrixMockRole => matrixRole(ENV_ONLY_KEY, 'Kombüse', 'friend', 'env', 0, 0, 0, false);
/** the built-ins in the backend's catalogue order (position: Admin, Familie, Freund, Gast), then the env role (Crew, base friend, stored) */
export function matrixMock(): MatrixMock {
  return {
    features: { requests: true, cast: true, livetv: false },
    policyPartial: false,
    failed: 2,
    libraries: [{ id: 'lib1', name: 'Filme' }, { id: 'lib2', name: 'Serien' }, { id: 'lib3', name: 'Musik' }],
    roles: [
      matrixRole('admin', 'Admin', 'admin', 'code', 1, 2, 0),
      matrixRole('family', 'Familie', 'family', 'code', 3, 6, 3),
      matrixRole('friend', 'Freund', 'friend', 'code', 7, 9, 1),
      matrixRole('guest', 'Gast', 'guest', 'code', 3, 5, 2),
      matrixRole('crew', 'Crew', 'friend', 'env', 2, 2, 0),
    ],
    puts: [], deletes: [], orders: [],
  };
}
export interface DetailLimits { maxStreams: number | null; remoteBitrate: number | null; maxDownloads: number | null; downloadMaxHeight: number | null; requestsPerMonth: number | null }
export interface DetailProfile { id: string; name: string; kids: boolean; /** the age cap of a kids profile (0/6/12), null on a grown-up one */ maxRating: number | null; avatar: string; lastUsed: string | null; isOwner: boolean; hasPin: boolean }
/** role values the limits page shows as placeholders */
export const DETAIL_ROLE_LIMITS: DetailLimits = { maxStreams: 2, remoteBitrate: 8_000_000, maxDownloads: 5, downloadMaxHeight: 720, requestsPerMonth: 3 };
export type HygieneCode = 'no_overview' | 'no_poster' | 'no_backdrop' | 'no_year' | 'no_ids' | 'no_audio' | 'audio_unknown' | 'foreign_no_subs' | 'forced_only' | 'image_subs_only' | 'dup_ids' | 'dup_title' | 'dup_episode' | 'no_source' | 'zero_runtime' | 'heavy_bitrate' | 'hevc_10bit' | 'video_codec' | 'audio_codec';
export interface HygieneItem {
  itemId: string; type: 'Movie' | 'Series' | 'Episode'; name: string; seriesId: string | null; seriesName: string | null; year: number | null;
  issues: HygieneCode[]; versions: number; container: string | null; bitrate: number | null; sizeBytes: number | null;
  video: string | null; audio: string[]; subtitles: string[]; dupOf: string[];
}
export interface HygieneMock {
  supported: boolean; canRefresh: boolean; running: boolean; lastDone: string | null; lastFull: string | null;
  items: HygieneItem[]; ignored: Set<string>; refreshed: string[]; scans: number;
}
export const HYG_CAT: Record<HygieneCode, 'info' | 'language' | 'duplicate' | 'file'> = {
  no_overview: 'info', no_poster: 'info', no_backdrop: 'info', no_year: 'info', no_ids: 'info',
  no_audio: 'language', audio_unknown: 'language', foreign_no_subs: 'language', forced_only: 'language', image_subs_only: 'language',
  dup_ids: 'duplicate', dup_title: 'duplicate', dup_episode: 'duplicate',
  no_source: 'file', zero_runtime: 'file', heavy_bitrate: 'file', hevc_10bit: 'file', video_codec: 'file', audio_codec: 'file',
};
const HYG_WARN = new Set<HygieneCode>(['no_overview', 'no_poster', 'no_audio', 'foreign_no_subs', 'dup_ids', 'dup_episode', 'no_source', 'zero_runtime', 'video_codec']);
const hx = (n: number): string => n.toString(16).padStart(32, '0');
function hygieneItems(): HygieneItem[] {
  const base = { seriesId: null, seriesName: null, versions: 1, container: 'mkv', bitrate: 12e6, sizeBytes: 4.2 * 1024 ** 3, video: 'h264 1080p', audio: ['deu ac3 6ch'], subtitles: ['deu'], dupOf: [] };
  const rows: HygieneItem[] = [
    { ...base, itemId: hx(0x701), type: 'Movie', name: 'Lantern Bay', year: 2019, issues: ['foreign_no_subs', 'hevc_10bit'], video: 'hevc 10-bit 2160p HDR', audio: ['eng eac3 6ch'], subtitles: [], bitrate: 48e6, sizeBytes: 38 * 1024 ** 3 },
    { ...base, itemId: hx(0x702), type: 'Movie', name: 'Quiet Harbor', year: 2004, issues: ['no_poster', 'no_backdrop'] },
    { ...base, itemId: hx(0x703), type: 'Movie', name: 'Ironwood', year: 2011, issues: ['dup_ids'], dupOf: [hx(0x704)] },
    { ...base, itemId: hx(0x704), type: 'Movie', name: 'Ironwood', year: 2011, issues: ['dup_ids'], dupOf: [hx(0x703)], versions: 2 },
    { ...base, itemId: hx(0x705), type: 'Series', name: 'Sundial', year: 2020, issues: ['no_overview'], container: null, bitrate: null, sizeBytes: null, video: null, audio: [], subtitles: [] },
    { ...base, itemId: hx(0x706), type: 'Episode', name: 'Pilot', seriesId: hx(0x705), seriesName: 'Sundial', year: 2020, issues: ['image_subs_only'], subtitles: ['deu pgs'] },
    { ...base, itemId: hx(0x707), type: 'Movie', name: 'Old Reel', year: 1962, issues: ['video_codec', 'audio_codec'], container: 'avi', video: 'mpeg2 576p', audio: ['eng dts 2ch'] },
  ];
  for (let i = 0; i < 60; i++) rows.push({ ...base, itemId: hx(0x800 + i), type: 'Episode', name: `Folge ${i + 1}`, seriesId: hx(0x7ff), seriesName: 'Zephyr Road', year: 2015, issues: ['heavy_bitrate'], bitrate: 41e6 + i * 1e5 });
  return rows;
}
export interface SourceRow { name: 'tmdb' | 'omdb'; set: boolean; last4: string | null; from: 'db' | 'file' | null; invalid: boolean; usedToday?: number; budget?: number }
export interface LeavingRow { itemId: string; name: string | null; type: string | null; year: number | null; leavesAt: string; days: number; note: string | null; setBy: string | null }
/** local calendar day `offset` days from today (YYYY-MM-DD) */
export const leaveDay = (offset: number): string => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const LEAVING_TITLES: Record<string, [string, string, number]> = {
  '00000000000000000000000000000001': ['Inkwell', 'Movie', 2010], '00000000000000000000000000000002': ['Interlace', 'Movie', 2014],
  '00000000000000000000000000000003': ['The Dawn Keeper', 'Movie', 2008], '00000000000000000000000000000004': ['Dunwick', 'Movie', 2017],
};
const leavingRow = (itemId: string, days: number, note: string | null): LeavingRow => {
  const t = LEAVING_TITLES[itemId];
  return { itemId, name: t?.[0] ?? null, type: t?.[1] ?? null, year: t?.[2] ?? null, leavesAt: leaveDay(days), days, note, setBy: 'Tester' };
};

const previewItems: PreviewRow[] = Array.from({ length: 60 }, (_, i) => ({ itemId: 'it' + i, name: 'Titel Nummer ' + i, type: i % 3 ? 'Movie' : 'Series', status: (['ok', 'ok', 'ok', 'failed', 'missing', 'preparing'] as const)[i % 6]!, bytes: i % 6 < 3 ? 3_400_000 + i * 1000 : null, audioLang: i % 6 < 3 ? 'deu' : null, error: i % 6 === 3 ? 'ffmpeg exited with code 1' : null, createdAt: ago(i) }));

export function livetvMock(): LivetvMock {
  return {
    installed: false, wanted: false, offerHidden: false, updater: true, stack: 'own', ltState: 'absent', ltError: null, ltOld: false, updaterError: null, job: null, tick: 0, jobPolls: 2, outcome: 'succeeded', failCode: null,
    benchmark: null, advice: null, refuse: null, failedSources: 0, detectLag: 0, offLag: 2, lagLeft: 0, lagTo: true, gets: 0, posts: [], area: livetvAreaMock(), status: ltvStatusMock(),
  };
}

/** rights facts of the first accounts (Anna: a switch exception, a limit and a kids profile with a note; Ben and Clara have no 2FA).
 *  Cloned per state: the mock writes into `perms`/`ov`, and a shared object would carry one test's save into the next test of the worker */
const SEED: Array<Partial<AdminUser>> = [
  { perms: { party: false }, otherOverrides: 1, ov: { maxStreams: 3 }, kidsProfiles: 1, note: 'Teilt das Konto mit ihrer Familie' },
  { mfaOff: true },
  { kidsProfiles: 2, mfaOff: true },
];

export function adminState(): AdminState {
  const users: AdminUser[] = [
    { id: 'u1', name: 'Tester', email: 'tester@example.org', role: 'admin', disabled: false, jellyfin_username: 'tester', seerr_user_id: 1, created_at: ago(24 * 400), last_seen: ago(0.1) },
    ...NAMES.map((n, i) => ({ id: auid(i + 2), name: n, email: i % 3 === 2 ? null : `${n.split(' ')[0]!.toLowerCase()}@example.org`, role: ['friend', 'family', 'guest', 'friend'][i % 4]!, disabled: i === 4, jellyfin_username: n.split(' ')[0]!.toLowerCase(), seerr_user_id: null, created_at: ago(24 * (i + 3)), last_seen: ago(i * 7), ...structuredClone(SEED[i]) })),
  ];
  return {
    users,
    devices: Array.from({ length: 8 }, (_, i) => ({ user_id: auid(i + 2), device_id: `dev-${i}-0123456789ab`, label: ['Chrome auf Windows', 'Safari auf iPhone', 'LG webOS TV', 'Firefox auf Linux'][i % 4]!, approved: i > 3, last_seen: ago(i * 11 + 1), name: NAMES[i]! })),
    requests: [
      { id: 101, title: 'Dunmoor: Part Two', mediaType: 'movie', requestedBy: 'Anna Beispiel', status: 'angefragt', createdAt: ago(3) },
      { id: 102, title: 'Sundial', mediaType: 'tv', requestedBy: 'Ben Test', status: 'angefragt', createdAt: ago(9) },
      { id: 103, title: 'Paper Lanterns', mediaType: 'movie', requestedBy: 'Clara Fischer', status: 'angefragt', createdAt: ago(20) },
      { id: 104, title: 'Silkroad', mediaType: 'tv', requestedBy: 'David Müller', status: 'angefragt', createdAt: ago(30) },
      { id: 105, title: 'The Bramble', mediaType: 'tv', requestedBy: 'Clara Fischer', status: 'genehmigt', createdAt: ago(50) },
      { id: 106, title: 'Quiet Mornings', mediaType: 'movie', requestedBy: 'Emma Schneider', status: 'verfügbar', createdAt: ago(90) },
    ],
    invites: [
      { id: auid(201), role: 'friend', note: 'Für Annas Bruder', expires_at: fut(30), used_at: null, used_by_name: null, uses: 0, max_uses: 1, access_days: null },
      { id: auid(202), role: 'guest', note: null, expires_at: ago(5), used_at: null, used_by_name: null, uses: 0, max_uses: 1, access_days: null },
      { id: auid(203), role: 'family', note: 'Oma', expires_at: fut(2), used_at: ago(1), used_by_name: 'Oma Inge', uses: 1, max_uses: 1, access_days: null },
      { id: auid(204), role: 'guest', note: 'Spieleabend', expires_at: fut(40), used_at: ago(3), used_by_name: 'Mila Kraus', uses: 2, max_uses: 5, access_days: 30 },
    ],
    inviteUses: {
      [auid(203)]: [{ id: auid(50), name: 'Oma Inge', email: null, role: 'family', disabled: false, at: ago(1) }],
      [auid(204)]: [{ id: auid(51), name: 'Mila Kraus', email: 'mila@example.org', role: 'guest', disabled: false, at: ago(3) }, { id: auid(52), name: 'Tom Kraus', email: null, role: 'guest', disabled: false, at: ago(2) }],
    },
    approvals: [
      { id: auid(401), name: 'Mia Neu', email: 'mia@example.org', requested_at: ago(2) },
      { id: auid(402), name: 'Paul Fremd', email: null, requested_at: ago(20) },
    ],
    audit: [
      { id: 50, at: ago(0.2), action: 'user.disable', target: auid(6), meta: {}, actor: 'Tester', target_name: 'Emma Schneider' },
      { id: 49, at: ago(1), action: 'user.role', target: auid(3), meta: { from: 'guest', to: 'friend' }, actor: 'Tester', target_name: 'Ben Test' },
      { id: 48, at: ago(2), action: 'invite.create', target: auid(201), meta: { role: 'friend', authentik: true }, actor: 'Tester', target_name: null },
      { id: 47, at: ago(5), action: 'device.approve', target: auid(7), meta: { by: 'admin' }, actor: 'Tester', target_name: 'Felix Weber' },
      { id: 46, at: ago(8), action: 'request.approve', target: '99', meta: {}, actor: 'Tester', target_name: null },
      { id: 45, at: ago(26), action: 'list.feature', target: '11111111-1111-4111-8111-111111111111', meta: {}, actor: 'Tester', target_name: 'Filmabend' },
      { id: 44, at: ago(30), action: 'role.playback', target: 'family', meta: { transcoding: true, maxHeight: 1080 }, actor: 'Tester', target_name: null },
      { id: 43, at: ago(49), action: 'user.provisioned', target: auid(13), meta: {}, actor: null, target_name: 'Leon Richter' },
      { id: 42, at: ago(60), action: 'system.update', target: null, meta: { from: 'a', to: 'b' }, actor: 'Tester', target_name: null },
    ],
    polls: [{ id: 'p1', title: 'Filmabend Freitag', creator: 'Anna Beispiel', winnerOptionId: 'o2', closesAt: ago(2), options: [{ id: 'o1', title: 'Hearth', votes: 2, inLibrary: true }, { id: 'o2', title: 'Dunmoor: Part Two', votes: 5, inLibrary: false }] }],
    lists: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Filmabend', owner: { id: auid(2), name: 'Anna' }, itemCount: 12, featured: true },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Annas Klassiker', owner: { id: auid(3), name: 'Ben' }, itemCount: 4, featured: false },
    ],
    hubs: [
      { id: 'h1', name: 'Mythos', source: 'studio', sourceValue: 'Mythos Studios', enabled: true },
      { id: 'h2', name: 'Pinecone', source: 'studio', sourceValue: 'Pinecone', accent: '#3a7bd5', enabled: false },
    ],
    previews: previewItems.map((p) => ({ ...p })),
    conv: {
      limit: 3, auto: 3, custom: null, priority: 'films',
      running: [
        { kind: 'film', hevc: false, label: 'Dunmoor', since: null, device: 'Wohnzimmer-TV' },
        { kind: 'download', hevc: false, label: 'Dunmoor', since: null, device: null },
      ],
      bench: { jellyfin: { speed: 4.6, hwAccel: 'qsv', at: ago(6) }, livetv: { speed: 4.4, encoder: 'h264_qsv', at: ago(6) }, recommended: 3, stale: false, noRealtime: false },
      measure: { running: false, busy: null, last: null },
      posts: 0, benchAnswer: null,
    },
    live: [
      { userId: auid(2), userName: 'Anna Beispiel', profileName: 'Anna', playSessionId: 'ps-anna', itemId: 'it1', title: 'Hearth', seriesName: null, type: 'Movie', positionTicks: 30 * 6e8, runtimeTicks: 170 * 6e8, isPaused: false, updatedAt: ago(0), source: 'portal' },
      { userId: auid(3), userName: 'Ben Test', profileName: null, playSessionId: 'ps-ben', itemId: 'it2', title: 'Pilot', seriesName: 'Sundial', type: 'Episode', positionTicks: 10 * 6e8, runtimeTicks: 55 * 6e8, isPaused: true, updatedAt: ago(0), source: 'portal' },
    ],
    seerrUp: true,
    summaryFails: false,
    recoIndex: { supported: true, running: false, items: 1234, updatedAt: ago(3) },
    livetv: livetvMock(),
    leaving: [leavingRow('00000000000000000000000000000001', 1, 'Lizenz endet'), leavingRow('00000000000000000000000000000002', 5, null), leavingRow('00000000000000000000000000000003', 20, 'Rechte laufen aus')],
    sources: [{ name: 'tmdb', set: false, last4: null, from: null, invalid: false }, { name: 'omdb', set: true, last4: 'k3y9', from: 'db', invalid: false, usedToday: 12, budget: 900 }],
    health: healthOk(),
    healthRefreshed: null,
    healthCalls: [],
    loginCheck: loginCheckOk(),
    repairs: [],
    repairReply: null,
    matrix: matrixMock(),
    streams: { streams: [], totals: { direct: 0, remux: 0, transcode: 0 }, details: true, failed: [] },
    errors: { entries: [], overflow: 0 },
    bannerIssues: [],
    dismissed: {},
    bannerCalls: 0,
    bannerFails: false,
    hygiene: { supported: true, canRefresh: true, running: false, lastDone: ago(0.2), lastFull: ago(48), items: hygieneItems(), ignored: new Set(), refreshed: [], scans: 0 },
    usageCalls: [],
    usageDetailCalls: [],
    usageSince: leaveDay(-10),
    detailMfa: { totp: true, webauthn: false, static: true },
    repairFails: new Set(),
    cleanups: [],
    claimed: new Set(),
    authentik: { recovery: true, mfaSetup: false },
    linkedOk: { jellyfin: true, requests: true },
    limits: {},
    userProfiles: {},
    keptCap: new Map(),
    profileSeq: 0,
    profileMediaFails: false,
    checkTimes: [],
    checkHidesUnrated: false,
    activityCalls: 0,
    revokedLicences: [],
  };
}

const profilesOf = (st: AdminState, u: AdminUser): DetailProfile[] => (st.userProfiles[u.id] ??= [
  { id: `${u.id.slice(0, -4)}p001`, name: u.name.split(' ')[0]!, kids: false, maxRating: null, avatar: 'a2', lastUsed: u.last_seen, isOwner: true, hasPin: false },
  { id: `${u.id.slice(0, -4)}p002`, name: 'Kinder', kids: true, maxRating: 6, avatar: 'a4', lastUsed: null, isOwner: false, hasPin: true },
]);
/** GET /api/admin/users/:id (shape of backend/src/routes/adminUsers.ts; never credentials or the Authentik sub) */
function userDetail(st: AdminState, u: AdminUser) {
  const profiles = profilesOf(st, u);
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role, disabled: u.disabled, lockedReason: u.disabled ? (u.locked_reason ?? 'manual') : null, accessUntil: u.access_until ?? null, deletionAt: u.deletion_at ?? null, createdAt: u.created_at, lastActive: u.last_seen, avatar: null },
    mfa: st.detailMfa,
    authentik: st.authentik,
    totals: { d7: { hours: 3.5, streams: 4 }, d30: { hours: 12.5, streams: 15 }, all: { hours: 140, streams: 230 }, downloads: 3, requests: 7 },
    linked: { jellyfin: { ok: st.linkedOk.jellyfin, username: u.jellyfin_username }, requests: { ok: st.linkedOk.requests, id: st.linkedOk.requests ? 7 : null } },
    profiles,
    devices: st.devices.filter((d) => d.user_id === u.id).map((d, i) => ({ id: d.device_id, name: d.label, lastSeen: d.last_seen, approved: d.approved, sessions: i + 1 })),
    licenses: [{ id: auid(601), itemId: 'it1', status: 'fetched', ready: true, title: 'Hearth', seriesName: null, season: null, episode: null, profileId: profiles[0]!.id, createdAt: ago(30), validUntil: fut(24 * 20), expiresAt: fut(24 * 20), bytes: 1.2e9 }].filter((l) => !st.revokedLicences.includes(l.id)),
  };
}

/** Block 22: aggregated usage per account (shapes follow backend/src/routes/usage.ts; never a title) */
function usageRows(st: AdminState, days: number) {
  const f = days / 30;
  return st.users.map((u, i) => {
    const streams = i === 0 ? 8 : i === 1 ? 12 : i % 3 === 0 ? 0 : Math.round((i + 2) * f);
    return {
      userId: u.id, name: u.name, role: u.role, disabled: u.disabled, lastSeen: u.last_seen,
      seconds: i === 0 ? Math.round(5400 * f) : streams * 2400, movieSeconds: i === 0 ? Math.round(3600 * f) : streams * 1200, seriesSeconds: i === 0 ? Math.round(1800 * f) : streams * 1200,
      titles: Math.ceil(streams / 2), streams, transcodes: i === 0 ? 2 : Math.floor(streams / 4), topReason: i === 0 ? 'videoCodec' : streams >= 4 ? 'network' : null,
      devices: i === 0 ? 3 : 1, devicesUsed: i === 0 ? 2 : streams ? 1 : 0, liveNow: st.live.filter((l) => l.userId === u.id).length,
    };
  });
}
function usageDetail(userId: string, days: number) {
  const out = [];
  for (let d = days - 1; d >= 0; d--) out.push({ day: leaveDay(-d), seconds: d % 3 === 0 ? 1800 + d * 60 : 0 });
  return {
    userId, days: out,
    devices: [
      { label: 'Chrome auf Windows', lastSeen: ago(1), streams: 5, transcodes: 1, app: false },
      { label: 'Infuse', lastSeen: leaveDay(-2), streams: 3, transcodes: 1, app: true },
      { label: '', lastSeen: null, streams: 1, transcodes: 0, app: false },
    ],
    reasons: { videoCodec: 2, network: 1 }, since: leaveDay(-10),
  };
}

const hygEff = (h: HygieneMock, r: HygieneItem): HygieneCode[] => r.issues.filter((c) => !h.ignored.has(`${r.itemId}|${c}`));
function hygieneSummary(h: HygieneMock) {
  const byCategory = { info: 0, language: 0, duplicate: 0, file: 0 };
  const byIssue: Record<string, number> = {};
  let total = 0;
  for (const r of h.items) {
    const eff = hygEff(h, r);
    if (!eff.length) continue;
    total++;
    for (const c of new Set(eff.map((x) => HYG_CAT[x]))) byCategory[c]++;
    for (const c of eff) byIssue[c] = (byIssue[c] ?? 0) + 1;
  }
  return { state: { supported: h.supported, running: h.running, lastDone: h.lastDone, lastFull: h.lastFull }, total, byCategory, byIssue, ignored: h.ignored.size, canRefresh: h.canRefresh };
}
function hygieneList(h: HygieneMock, sp: URLSearchParams) {
  const cat = sp.get('category'), issue = sp.get('issue'), type = sp.get('type'), series = sp.get('seriesId'), q = (sp.get('q') ?? '').toLowerCase();
  let rows = h.items.map((r) => ({ r, eff: hygEff(h, r) })).filter(({ r, eff }) => eff.length
    && (!cat || eff.some((c) => HYG_CAT[c] === cat)) && (!issue || eff.includes(issue as HygieneCode)) && (!type || r.type === type)
    && (!series || r.seriesId === series) && (!q || `${r.name} ${r.seriesName ?? ''}`.toLowerCase().includes(q)));
  const sort = sp.get('sort') ?? 'name';
  const dir = (sp.get('dir') ?? (sort === 'name' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  const key = (x: { r: HygieneItem; eff: HygieneCode[] }): string | number => (sort === 'issues' ? x.eff.length : sort === 'size' ? x.r.sizeBytes ?? -1 : sort === 'bitrate' ? x.r.bitrate ?? -1 : `${x.r.seriesName ?? x.r.name} ${x.r.name}`.toLowerCase());
  rows = [...rows].sort((a, b) => { const x = key(a), y = key(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'de', { numeric: true })) * dir; });
  const off = Number(sp.get('offset') ?? 0), lim = Number(sp.get('limit') ?? 50);
  return { items: rows.slice(off, off + lim).map(({ r, eff }) => ({ ...r, issues: eff.map((code) => ({ code, severity: HYG_WARN.has(code) ? 'warn' : 'info' })) })), total: rows.length };
}

const GiB = 1024 ** 3;
/** Block 23 phase 3: a healthy sign-in check */
export function loginCheckOk(): Record<string, any> {
  const row = (kind: string, slug: string, state = 'ok') => ({ kind, slug, state, stages: [] });
  return {
    mode: 'app', implicitConsent: true, authCodeGrant: true, issuerMatches: true, passkeys: 'in-app', passkeysReason: 'ok', passkeySignIn: 'ok', unreachable: false, warnings: [],
    flows: [row('login', 'default-authentication-flow'), row('recovery', 'default-recovery-flow'), row('invalidation', 'default-invalidation-flow'), row('setup-totp', 'default-authenticator-totp-setup')],
  };
}

/** Block 22: a healthy snapshot (shapes follow backend/src/health.ts) */
export function healthOk(): Record<string, any> {
  return {
    at: new Date().toISOString(),
    services: [
      { id: 'media', level: 'ok', ms: 40 }, { id: 'postgres', level: 'ok', ms: 2 }, { id: 'redis', level: 'ok', ms: 1 }, { id: 'gateway', level: 'ok', ms: 12 },
      { id: 'oidc', level: 'ok', ms: 80 }, { id: 'requests', level: 'ok', ms: 30 }, { id: 'tmdb', level: 'off', reason: 'not_set' }, { id: 'omdb', level: 'ok' }, { id: 'playbackCheck', level: 'ok' },
    ],
    disks: [
      { id: 'downloads', level: 'ok', totalBytes: 500 * GiB, freeBytes: 300 * GiB, usedPct: 40, ownBytes: 12 * GiB, capBytes: 50 * GiB },
      { id: 'previews', level: 'ok', totalBytes: 100 * GiB, freeBytes: 80 * GiB, usedPct: 20, ownBytes: 99e6 },
      { id: 'database', level: 'ok', ownBytes: 300e6 },
    ],
    errors: { level: 'ok', server15: 0, client15: 0, playback60: 0 },
    issues: [],
    worst: 'ok',
  };
}

const PENDING = 'angefragt';
const STATE_KEY: Record<string, string> = { angefragt: 'pending', genehmigt: 'approved', 'in Arbeit': 'processing', 'verfügbar': 'available', abgelehnt: 'declined' };
const reqFilter: Record<string, (r: AdminRequest) => boolean> = {
  pending: (r) => r.status === PENDING, approved: (r) => r.status === 'genehmigt', processing: (r) => r.status === 'in Arbeit', available: (r) => r.status === 'verfügbar', all: () => true,
};

// ---- People list endpoints (users, devices, invites, audit): search / filter / sort / paging like the backend ----
const norm = (v: string): string => v.toLowerCase();
function paged<T>(rows: T[], sp: URLSearchParams, def: number): { slice: T[]; total: number } {
  const limit = Number(sp.get('limit') ?? def), offset = Number(sp.get('offset') ?? 0);
  return { slice: rows.slice(offset, offset + limit), total: rows.length };
}
function sorted<T>(rows: T[], sp: URLSearchParams, keys: Record<string, (r: T) => string | number>): T[] {
  const k = keys[sp.get('sort') ?? ''];
  if (!k) return rows;
  const dir = sp.get('dir') === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => { const x = k(a), y = k(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir; });
}
const WEEK = 7 * 86400e3;
/** the backend's `overrides` count: stored switch exceptions plus the other stored limits (an admin's switches never count) */
const overridesOf = (u: AdminUser): number => (u.otherOverrides ?? 0) + (u.role === 'admin' ? 0 : Object.keys(u.perms ?? {}).length);
/** the switch the person effectively has */
function effectivePerm(st: AdminState, row: { id: string; role: string | null }, key: string): boolean {
  if (row.role === 'admin') return true;
  const own = st.users.find((x) => x.id === row.id)?.perms?.[key];
  return own ?? (st.matrix.roles.find((r) => r.key === row.role)?.values[key] === true);
}
function usersList(st: AdminState, sp: URLSearchParams) {
  // perm=key:on|off and mfa=off as the backend: the effective switch (role value, the person's exception on top; admins may do everything); mfa only with the provider's API
  const permFilter = sp.get('perm')?.split(':') ?? null, mfaOff = sp.get('mfa') === 'off' && st.authentik.recovery;
  const q = norm(sp.get('q') ?? ''), status = sp.get('status'), inactive = sp.get('lastActive') === '90+', lastActive = inactive ? 0 : Number(sp.get('lastActive') ?? 0), now = Date.now();
  // status=pending: the open approval requests in the same row shape (backend: pending true, role null)
  const all = status === 'pending'
    ? st.approvals.map((a) => ({ id: a.id, name: a.name, email: a.email, role: null as unknown as string, disabled: false, jellyfin_username: '', seerr_user_id: null, created_at: a.requested_at, last_seen: null, access_until: null, locked_reason: null, deletion_at: null as string | null, cleanup: null as { step: number; error: string | null; gone: boolean } | null, profiles: 0, devices: 0, pending: true, overrides: 0, kidsProfiles: 0, note: null }))
    : st.users.map((u) => ({ ...u, access_until: u.access_until ?? null, locked_reason: u.disabled ? (u.locked_reason ?? 'manual') : null, deletion_at: u.deletion_at ?? null,
      cleanup: status === 'deleting' && u.cleanup ? { ...u.cleanup, gone: false } : null, profiles: u.profiles ?? 1, devices: st.devices.filter((d) => d.user_id === u.id).length, pending: false,
      overrides: overridesOf(u), kidsProfiles: u.kidsProfiles ?? 0, note: u.note ?? null }))
      // status=deleting: plus the cleanup rows (backend: pseudonym as name, no e-mail or role, cleanup {step, error})
      .concat(status === 'deleting' ? st.cleanups.map((c) => ({ id: c.id, name: c.pseudonym, email: null, role: null as unknown as string, disabled: true, jellyfin_username: '', seerr_user_id: null, created_at: c.started_at, last_seen: null, access_until: null, locked_reason: 'deletion' as const, deletion_at: null, profiles: 0, devices: 0, pending: false, overrides: 0, kidsProfiles: 0, note: null, cleanup: { step: c.step, error: c.error, gone: true } })) : []);
  let rows = all.filter((u) => (!q || norm(`${u.name} ${u.email ?? ''} ${u.jellyfin_username}`).includes(q)) && (!sp.get('role') || u.role === sp.get('role'))
    && (!status || status === 'pending' || (status === 'locked' && u.disabled) || (status === 'active' && !u.disabled && !u.deletion_at)
      || (status === 'deleting' && (Boolean(u.deletion_at) || Boolean(u.cleanup)))
      || (status === 'expiring' && u.access_until !== null && Date.parse(u.access_until) >= now && Date.parse(u.access_until) <= now + WEEK))
    && (!lastActive || (u.last_seen !== null && Date.parse(u.last_seen) >= now - lastActive * 86400e3))
    && (!inactive || u.last_seen === null || Date.parse(u.last_seen) < now - 90 * 86400e3)
    && (sp.get('overrides') !== '1' || u.overrides > 0) && (sp.get('kids') !== '1' || u.kidsProfiles > 0)
    && (!permFilter || (u.role !== null && effectivePerm(st, u, permFilter[0]!) === (permFilter[1] === 'on')))
    && (!mfaOff || ('mfaOff' in u && u.mfaOff === true)));
  rows = sorted(rows, sp, { name: (u) => u.name, email: (u) => u.email ?? '', role: (u) => u.role, status: (u) => Number(u.disabled), lastSeen: (u) => u.last_seen ?? '', accessUntil: (u) => u.access_until ?? '', profiles: (u) => u.profiles, devices: (u) => u.devices });
  const { slice, total } = paged(rows, sp, 1000);
  return { users: slice, total };
}
function devicesList(st: AdminState, sp: URLSearchParams) {
  const q = norm(sp.get('q') ?? '');
  let rows = [...st.devices].sort((a, b) => Number(a.approved) - Number(b.approved) || b.last_seen.localeCompare(a.last_seen));
  rows = rows.filter((d) => (!q || norm(`${d.name} ${d.label}`).includes(q)) && (!sp.get('status') || (sp.get('status') === 'approved') === d.approved));
  rows = sorted(rows, sp, { user: (d) => d.name, device: (d) => d.label, lastSeen: (d) => d.last_seen, status: (d) => Number(d.approved) });
  const { slice, total } = paged(rows, sp, 300);
  return { devices: slice, total, pending: st.devices.filter((d) => !d.approved).length };
}
function invitesList(st: AdminState, sp: URLSearchParams) {
  const q = norm(sp.get('q') ?? ''), now = new Date().toISOString();
  const status = (i: AdminInvite) => (i.uses >= i.max_uses ? 'used' : i.expires_at < now ? 'expired' : 'open');
  let rows = st.invites.filter((i) => (!q || norm(`${i.note ?? ''} ${i.role} ${i.used_by_name ?? ''}`).includes(q)) && (!sp.get('status') || status(i) === sp.get('status')));
  rows = sorted(rows, sp, { role: (i) => i.role, note: (i) => i.note ?? '', validUntil: (i) => i.expires_at, status: (i) => status(i) });
  const { slice, total } = paged(rows, sp, 100);
  return { invites: slice.map((i) => ({ ...i, created_at: i.expires_at })), total };
}
const AUDIT_ACTOR = 'Tester';
/** `?area=people` (backend admin.ts): the audit categories about people and their roles */
const AUDIT_PEOPLE = new Set(['user', 'role', 'invite', 'profile', 'device']);
function auditList(st: AdminState, sp: URLSearchParams) {
  const area = sp.get('area') === 'people';
  const target = sp.get('target'), q = norm(sp.get('q') ?? ''), action = sp.get('action'), actor = sp.get('actor'), from = sp.get('from'), to = sp.get('to');
  let rows = st.audit.filter((e) => (!target || e.target === target) && (!q || norm(`${e.action} ${e.actor ?? ''} ${e.target_name ?? ''}`).includes(q))
    && (!area || AUDIT_PEOPLE.has(e.action.split('.')[0]!))
    && (!action || e.action === action || e.action.startsWith(`${action}.`))
    && (!actor || (actor === 'system' ? e.actor === null : e.actor === AUDIT_ACTOR))
    && (!from || e.at >= from) && (!to || e.at <= to));
  if (sp.get('dir') === 'asc') rows = [...rows].reverse();
  const { slice, total } = paged(rows, sp, 100);
  return { entries: slice.map((e) => ({ ...e, actor_id: e.actor ? 'u1' : null })), total };
}

const ENV_LINE = 'COMPOSE_PROFILES=livetv';
function livetvState(lt: LivetvMock) {
  lt.gets++;
  const install = () => { lt.installed = true; lt.ltState = 'enabled'; lt.ltError = null; };
  if (lt.lagLeft > 0 && --lt.lagLeft === 0) { if (lt.lagTo) install(); else lt.installed = false; }
  // the job moves one step per poll; its end flips installed after `detectLag` (enable) / `offLag` (disable / remove) more polls,
  // like the backend's cached detection; the updater's own state changes at once
  if (lt.job?.state === 'running' && String(lt.job.action).startsWith('livetv-')) {
    if (advanceLivetvJob(lt.job, lt.tick++, lt.jobPolls, lt.outcome, lt.failCode)) {
      if (lt.job.state === 'succeeded') {
        if (lt.job.action === 'livetv-enable') { if (lt.detectLag > 0) { lt.lagLeft = lt.detectLag; lt.lagTo = true; } else install(); }
        else {
          lt.ltState = lt.job.action === 'livetv-remove' ? 'absent' : 'disabled'; lt.ltError = null;
          if (lt.offLag > 0) { lt.lagLeft = lt.offLag; lt.lagTo = false; } else lt.installed = false;
        }
      } else if (lt.job.action === 'livetv-enable') lt.ltState = 'disabled'; // the backend keeps `wanted` after a failed enable
    }
  }
  return {
    installed: lt.installed, reachable: lt.installed, version: lt.installed ? '1.0.0' : null, wanted: lt.wanted, offerHidden: lt.offerHidden,
    updater: {
      available: lt.updater && !lt.updaterError, stack: lt.updater && !lt.updaterError ? lt.stack : null, job: lt.updater && !lt.updaterError ? lt.job : null,
      error: lt.updater ? lt.updaterError : null,
      livetv: lt.updater && !lt.ltOld && !lt.updaterError ? { state: lt.ltState, container: lt.installed ? 'running' : null, error: lt.ltError } : null,
    },
    envLine: ENV_LINE, benchmark: lt.installed ? lt.benchmark : null,
    gpu: { jellyfin: lt.installed ? 'qsv' : null, livetv: lt.installed ? { driver: 'iHD', devices: 1 } : null, advice: lt.installed ? lt.advice : null },
  };
}
function livetvRoute(lt: LivetvMock, m: string, p: string, sp: URLSearchParams, body: any, J: Reply): Promise<void> | null {
  if (p === '/api/admin/livetv/state' && m === 'GET') return J(livetvState(lt));
  if ((p === '/api/admin/livetv/enable' || p === '/api/admin/livetv/disable') && m === 'POST') {
    const path = p.endsWith('enable') ? 'enable' : 'disable';
    lt.posts.push({ path, body });
    const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => J({ error, ...extra, wanted: lt.wanted }, status);
    if (lt.refuse) { const r = lt.refuse; lt.refuse = null; return refuse(r.status, r.error); }
    if (!lt.updater) return refuse(409, 'no_updater', { envLine: ENV_LINE });
    if (lt.updaterError) return refuse(502, lt.updaterError === 'unauthorized' ? 'unauthorized' : 'updater_error');
    if (lt.stack === 'foreign') return refuse(409, 'foreign_stack', { envLine: ENV_LINE });
    if (lt.ltOld) return refuse(409, 'updater_outdated');
    if (lt.job?.state === 'running') return refuse(409, 'busy');
    if (path === 'disable' && body?.removeCache && !body?.removeImage) return J({ error: 'invalid', field: 'removeCache' }, 400);
    lt.tick = 0;
    lt.job = livetvJob(path === 'enable' ? 'livetv-enable' : body?.removeImage ? 'livetv-remove' : 'livetv-disable');
    if (path === 'enable') lt.wanted = true; else lt.wanted = false;
    return J({ job: lt.job, wanted: path === 'enable' }, 202);
  }
  return ltvStatusRoute(lt.status, m, p, J) ?? livetvAreaRoute(lt.area, lt.installed, m, p, sp, body, J);
}

/**
 * The *Quellen* tab's routes, as the plan's contracts declare them: sources CRUD + test (Task 15), refresh 202 with the result through
 * GET (Task 16, spec §10), own feeds with the one-time push answer, ports and ingest state (Task 20).
 */
function livetvAreaRoute(a: LivetvAreaMock, installed: boolean, m: string, p: string, sp: URLSearchParams, body: any, J: Reply): Promise<void> | null {
  let mm: RegExpMatchArray | null;
  if (m !== 'GET') a.calls.push({ m, p, body });
  const inRange = (port: number) => !a.portsKnown || a.ports.includes(port);
  const feedView = (f: LtvFeedMock) => ({
    id: f.id, name: f.name, number: f.number, groupId: null, sourceId: f.sourceId, streamKind: f.streamKind, ingest: f.push ? 'push' : 'pull',
    ...(f.push ? { push: { port: f.push.port, hint: f.push.hint, portInRange: inRange(f.push.port) } } : {}),
  });
  const httpUrl = (v: unknown) => { try { const u = new URL(String(v)); return u.protocol === 'http:' || u.protocol === 'https:' ? u : null; } catch { return null; } };
  const nowIso = () => new Date().toISOString();
  /** `checkSourceUrl` refuses single-label hosts (`http://backend/list`, `localhost`) with `refused` */
  const singleLabel = (u: URL) => !u.hostname.includes('.') && !u.hostname.includes(':');

  if (p === '/api/admin/livetv/sources' && m === 'GET') {
    for (const [id, left] of Object.entries(a.refreshing)) {
      if (left > 1) { a.refreshing[id] = left - 1; continue; }
      delete a.refreshing[id];
      const s = a.sources.find((x) => x.id === id);
      if (!s) continue;
      const at = nowIso(), o = a.refreshOutcome;
      if ('error' in o) s.state = { ...s.state, lastRefreshAt: at, lastError: o.error };
      else { s.state = { ...s.state, lastRefreshAt: at, lastOkAt: at, lastError: null, counts: o.counts }; s.channelCount = o.counts.channels; }
    }
    return J(a.sources); // a bare array (backend adminRoutes.ts → listSources)
  }
  if (p === '/api/admin/livetv/sources/test' && m === 'POST') {
    if (a.testBusy) { a.testBusy = false; return J({ error: 'test_running' }, 409); }
    for (const field of ['url', 'epgUrl'] as const) {
      if (body?.[field] === undefined || (field === 'epgUrl' && (body.epgUrl === null || body.epgUrl === ''))) continue; // null / '' = no guide
      const u = httpUrl(body[field]);
      if (!u) return J({ error: 'invalid', field }, 400);
      if (singleLabel(u)) return J({ error: 'refused', field }, 400);
    }
    if (body?.url === undefined && !body?.sourceId) return J({ error: 'invalid', field: 'url' }, 400);
    // livetv's refusals answer 422 { error }, an unreached livetv 503 livetv_unreachable (Task 15 as built)
    return 'error' in a.test ? J({ error: a.test.error }, a.test.status ?? 422) : J(a.test);
  }
  if (p === '/api/admin/livetv/sources' && m === 'POST') {
    const u = httpUrl(body?.url);
    if (!u) return J({ error: 'invalid', field: 'url' }, 400);
    if (singleLabel(u)) return J({ error: 'refused', field: 'url' }, 400);
    if (typeof body?.name !== 'string' || !body.name.trim()) return J({ error: 'invalid', field: 'name' }, 400);
    const s = ltvSource({
      id: `src-${++a.seq}`, kind: 'm3u', name: body.name, urlHint: maskUrl(u.href), epgHint: body.epgUrl ? maskUrl(body.epgUrl) : null, userAgent: body.userAgent ?? null,
      allowLan: Boolean(body.allowLan), refresh: body.refresh ?? '24h', skipGroups: body.skipGroups ?? [], numbering: body.numbering ?? 'chno', numberBase: body.numberBase ?? 1, logoPref: body.logoPref ?? 'm3u',
      epgShiftMin: body.epgShiftMin ?? 0, maxStreams: body.maxStreams ?? null, position: a.sources.length,
    });
    a.sources.push(s);
    return J(s, 201);
  }
  if ((mm = p.match(/^\/api\/admin\/livetv\/sources\/([^/]+)(\/refresh)?$/))) {
    const s = a.sources.find((x) => x.id === mm![1]);
    if (!s) return J({ error: 'not_found' }, 404);
    if (mm[2] && m === 'POST') {
      // Task 16 (livetv16 af2c8fc4): own feeds have no list, nothing loads while livetv is not installed, a running one is not restarted
      if (s.kind === 'feeds') return J({ error: 'no_list' }, 409);
      if (!installed) return J({ error: 'livetv_off' }, 409);
      if (a.refreshing[s.id]) return J({ started: false }, 202);
      a.refreshing[s.id] = a.refreshPolls;
      return J({ started: true }, 202);
    }
    if (!mm[2] && m === 'PATCH') {
      const b = body ?? {};
      if (b.url !== undefined) { const u = httpUrl(b.url); if (!u) return J({ error: 'invalid', field: 'url' }, 400); s.urlHint = maskUrl(u.href); }
      if (b.epgUrl === null || b.epgUrl === '') s.epgHint = null; else if (b.epgUrl !== undefined) s.epgHint = maskUrl(b.epgUrl);
      for (const k of ['name', 'userAgent', 'allowLan', 'refresh', 'skipGroups', 'numbering', 'numberBase', 'logoPref', 'epgShiftMin', 'maxStreams', 'enabled'] as const) {
        if (b[k] !== undefined) (s as any)[k] = b[k];
      }
      return J(s);
    }
    if (!mm[2] && m === 'DELETE') {
      a.sources = a.sources.filter((x) => x.id !== s.id);
      return J({ channels: s.channelCount });
    }
  }
  const kanaele = channelsRoute(a, m, p, sp, body, J);
  if (kanaele) return kanaele;
  if (p === '/api/admin/livetv/channels' && m === 'GET') {
    const rows = a.feeds.filter((f) => f.sourceId === sp.get('source'));
    return J({ channels: rows.map(feedView), total: rows.length });
  }
  if (p === '/api/admin/livetv/ingest' && m === 'GET') {
    // backend ownfeeds.ts ingestView: out of range first, then livetv not reached / range unknown, then livetv's own word
    const feeds = a.feeds.filter((f) => f.push).map((f) => {
      const active = !f.hidden && a.sources.find((x) => x.id === f.sourceId)?.enabled !== false;
      const state = !active ? 'off' : a.portsKnown && !a.ports.includes(f.push!.port) ? 'out_of_range' : a.ingestFails || !a.portsKnown ? 'error' : f.ingest?.state ?? 'pending';
      return { channelId: f.id, state, rejected1h: a.ingestFails ? 0 : f.ingest?.rejected1h ?? 0 };
    });
    const ports = a.portsKnown && a.ports.length ? { from: Math.min(...a.ports), to: Math.max(...a.ports) } : null;
    return J({ host: a.host, ports, feeds });
  }
  if (p === '/api/admin/livetv/channels' && m === 'POST') {
    const b = body ?? {};
    if (typeof b.name !== 'string' || !b.name.trim()) return J({ error: 'invalid', field: 'name' }, 400);
    let feeds = a.sources.find((x) => x.kind === 'feeds');
    const port = b.ingest === 'push' ? a.ports.find((pt) => !a.feeds.some((f) => f.push?.port === pt)) : undefined;
    if (b.ingest === 'push' && port === undefined) return J({ error: 'srt_ports_full', n: a.ports.length }, 409);
    let found: 'hls' | 'ts' | 'srt' = 'srt';
    if (b.ingest === 'pull') {
      let u: URL;
      try { u = new URL(b.url); if (!['http:', 'https:', 'srt:'].includes(u.protocol)) throw new Error('scheme'); } catch { return J({ error: 'invalid', field: 'url' }, 400); }
      if (singleLabel(u)) return J({ error: 'refused', field: 'url' }, 400);
      found = u.protocol === 'srt:' ? 'srt' : /\.ts$/i.test(u.pathname) ? 'ts' : 'hls';
      if (b.kind !== undefined && (b.kind === 'srt') !== (found === 'srt')) return J({ error: 'invalid', field: 'kind' }, 400);
    }
    if (!feeds) { feeds = ltvSource({ id: `src-${++a.seq}`, kind: 'feeds', name: 'Eigene Streams', refresh: 'manual', position: a.sources.length }); a.sources.push(feeds); }
    const id = `ch-${++a.seq}`;
    const f: LtvFeedMock = b.ingest === 'push'
      ? { id, sourceId: feeds.id, name: b.name, number: b.number ?? null, streamKind: 'srt', push: { port: port!, hint: 'ff-AB12CD' }, ingest: { state: 'idle', rejected1h: 0 } }
      : { id, sourceId: feeds.id, name: b.name, number: b.number ?? null, streamKind: b.kind ?? found, ingest: null };
    a.feeds.push(f);
    feeds.channelCount = a.feeds.filter((x) => x.sourceId === feeds!.id).length;
    return J({ channel: feedView(f), ...(f.push ? { push: pushAnswer(a, f.push.port) } : {}), synced: f.push ? a.synced : true }, 201);
  }
  if ((mm = p.match(/^\/api\/admin\/livetv\/channels\/([^/]+)(\/push-credentials|\/push-port)?$/))) {
    const f = a.feeds.find((x) => x.id === mm![1]);
    if (!f) return J({ error: 'not_found' }, 404);
    if (mm[2] === '/push-credentials' && m === 'POST') return f.push ? J({ channel: feedView(f), push: pushAnswer(a, f.push.port), synced: a.synced }) : J({ error: 'not_push' }, 409);
    if (mm[2] === '/push-port' && m === 'POST') {
      const port = a.ports.find((pt) => !a.feeds.some((x) => x.push?.port === pt));
      if (!f.push) return J({ error: 'not_push' }, 409);
      if (inRange(f.push.port)) return J({ error: 'port_in_range' }, 409); // a working encoder is never cut off
      if (port === undefined) return J({ error: 'srt_ports_full', n: a.ports.length }, 409);
      f.push = { ...f.push, port };
      return J({ port, synced: a.synced });
    }
    if (!mm[2] && m === 'DELETE') { a.feeds = a.feeds.filter((x) => x.id !== f.id); return J({ ok: true, synced: f.push ? a.synced : true }); }
  }
  return null;
}
/** the programme "now" of a channel at its effective offset: Nordlicht TV has one at +1 h and another at +1,5 h, nothing at other offsets */
function ltvNow(c: LtvChanMock, min: number): { title: string; start: string; end: string } | null {
  if (c.id !== 'ch-1') return null;
  const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  if (min === 60) return { title: 'Wetter am Hafen', start: at(19, 45), end: at(20, 15) };
  if (min === 90) return { title: 'Die Leuchtturmwärter', start: at(20, 15), end: at(21, 0) };
  return null;
}
/** one channel as `AdminChannel` (backend adminChannels.ts toAdmin) */
function ltvChanView(a: LivetvAreaMock, c: LtvChanMock) {
  const overridden: Record<string, unknown> = {};
  if (c.nameOv !== null) overridden.name = c.importName;
  if (c.numberOv !== null) overridden.number = c.importNumber;
  if (c.groupOv !== null) overridden.group = c.importGroup;
  if (c.logoOv) overridden.logo = true;
  const shift = c.shiftOv !== null ? { min: c.shiftOv, from: 'channel' } : c.base;
  const number = c.numberOv ?? c.importNumber;
  return {
    id: c.id, number, name: c.nameOv ?? c.importName, groupId: c.groupOv ?? c.importGroup, sourceId: c.sourceId, streamKind: c.streamKind, ingest: c.ingest,
    logoHash: c.logoHash, hidden: c.hidden, missing: c.missing, epg: c.epg, now: c.epg ? ltvNow(c, shift.min) : null, mode: c.probeError ? null : c.mode, probeError: c.probeError,
    overridden, dupNumber: !c.missing && number !== null && a.channels.some((o) => o !== c && !o.missing && (o.numberOv ?? o.importNumber) === number), epgShift: shift,
    ...(c.push ? { push: { port: c.push.port, hint: c.push.hint, portInRange: a.ports.includes(c.push.port) } } : {}),
  };
}
const LTV_FACTS = { video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'remux' } as const;
/**
 * The *Kanäle* tab's routes (Task 19 as built: list with filters and 100-row pages, one channel, PATCH answering the channel, bulk, the
 * stream test with its one-flight 409, the raw logo upload). `limit=200` is the own-feeds card's list and stays with it.
 */
function channelsRoute(a: LivetvAreaMock, m: string, p: string, sp: URLSearchParams, body: any, J: Reply): Promise<void> | null {
  const byId = (id: string | undefined) => a.channels.find((c) => c.id === id);
  if (p === '/api/admin/livetv/channels' && m === 'GET' && sp.get('limit') !== '200') {
    a.chQueries.push(sp.toString());
    const q = (sp.get('q') ?? '').trim().toLowerCase();
    let rows = a.channels.filter((c) => {
      const v = ltvChanView(a, c);
      if (q && !(v.name.toLowerCase().includes(q) || String(v.number) === q)) return false;
      if (sp.get('source') && c.sourceId !== sp.get('source')) return false;
      const g = sp.get('group');
      if (g === 'none' ? v.groupId !== null : g && v.groupId !== g) return false;
      const st = sp.get('state');
      if (st === 'visible' && (c.hidden || c.missing)) return false;
      if (st === 'hidden' && (!c.hidden || c.missing)) return false;
      if (st === 'missing' && !c.missing) return false;
      if (sp.get('epg') === 'yes' && !c.epg) return false;
      if (sp.get('epg') === 'no' && c.epg) return false;
      if (sp.get('error') === '1' && c.probeError === null) return false;
      return true;
    }).map((c) => ltvChanView(a, c));
    const dir = sp.get('dir') === 'desc' ? -1 : 1;
    const key = sp.get('sort') ?? 'number';
    rows = rows.sort((x, y) => dir * (key === 'name' ? x.name.localeCompare(y.name) : key === 'source' ? x.sourceId.localeCompare(y.sourceId) || (x.number ?? 0) - (y.number ?? 0) : (x.number ?? 1e9) - (y.number ?? 1e9)));
    const offset = Number(sp.get('offset') ?? 0), limit = Number(sp.get('limit') ?? 100);
    return J({ channels: rows.slice(offset, offset + limit), total: rows.length });
  }
  if (p === '/api/admin/livetv/channels/bulk' && m === 'POST') {
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
    const rows = ids.map(byId).filter((c): c is LtvChanMock => Boolean(c));
    if (!ids.length || !['hide', 'show', 'group', 'renumber', 'reset', 'test'].includes(body?.action)) return J({ error: 'invalid', field: 'action' }, 400);
    if (body.action === 'test') {
      if (new Set(ids).size > 20) return J({ error: 'invalid', field: 'ids' }, 400);
      if (a.chTestBusy) { a.chTestBusy = false; return J({ error: 'test_running' }, 409); }
      return J({ results: rows.map((c) => {
        const ok = !('status' in a.chTest) && a.chTest.ok;
        if (ok) { c.mode = 'remux'; c.probeError = null; return { id: c.id, ok: true, needs: 'remux' }; }
        c.mode = null; c.probeError = 'error' in a.chTest ? a.chTest.error : 'timeout';
        return { id: c.id, ok: false, error: c.probeError };
      }) });
    }
    if (body.action === 'group' && body.groupId !== null && !(body.groupId in LTV_GROUP_NAMES)) return J({ error: 'invalid', field: 'groupId' }, 400);
    if (body.action === 'renumber') {
      if (!Number.isInteger(body.from) || body.from < 1) return J({ error: 'invalid', field: 'from' }, 400);
      rows.sort((x, y) => (x.numberOv ?? x.importNumber ?? 1e9) - (y.numberOv ?? y.importNumber ?? 1e9) || (x.nameOv ?? x.importName).localeCompare(y.nameOv ?? y.importName)).forEach((c, i) => { c.numberOv = body.from + i; });
    }
    for (const c of rows) {
      if (body.action === 'hide') c.hidden = true;
      else if (body.action === 'show') c.hidden = false;
      else if (body.action === 'group') c.groupOv = body.groupId;
      else if (body.action === 'reset') { c.nameOv = c.numberOv = c.groupOv = c.shiftOv = null; c.logoOv = false; c.epgOff = false; }
    }
    return J({ changed: rows.length });
  }
  // *Reihenfolge* → Speichern (Task 19 orderChannels): consecutive numbers in the given order, from the smallest number of the set
  if (p === '/api/admin/livetv/channels/order' && m === 'PUT') {
    const ids: unknown = body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some((i) => typeof i !== 'string') || new Set(ids).size !== ids.length) return J({ error: 'invalid', field: 'ids' }, 400);
    const rows = (ids as string[]).map(byId);
    if (rows.some((c) => !c)) return J({ error: 'invalid', field: 'ids' }, 400);
    const have = (rows as LtvChanMock[]).map((c) => c.numberOv ?? c.importNumber).filter((n): n is number => n !== null);
    const from = have.length ? Math.min(...have) : 1;
    (rows as LtvChanMock[]).forEach((c, i) => { c.numberOv = from + i; });
    return J({ from });
  }
  const mm = p.match(/^\/api\/admin\/livetv\/channels\/([^/]+?)(\/test|\/logo)?$/);
  const c = mm ? byId(mm[1]) : undefined;
  if (!mm || !c || mm[1] === 'bulk' || mm[1] === 'order') return null;
  if (!mm[2] && m === 'GET') return J(ltvChanView(a, c));
  if (!mm[2] && m === 'PATCH') {
    const b = body ?? {};
    const bad = (field: string) => J({ error: 'invalid', field }, 400);
    for (const k of Object.keys(b)) if (!['name', 'number', 'groupId', 'hidden', 'epg', 'epgShiftMin'].includes(k)) return bad(k);
    if ('name' in b && b.name !== null && !(typeof b.name === 'string' && b.name.trim().length >= 1 && b.name.trim().length <= 60)) return bad('name');
    if ('groupId' in b && b.groupId !== null && !(b.groupId in LTV_GROUP_NAMES)) return bad('groupId');
    if ('epgShiftMin' in b && b.epgShiftMin !== null && !(Number.isInteger(b.epgShiftMin) && b.epgShiftMin % 30 === 0 && b.epgShiftMin >= -720 && b.epgShiftMin <= 840)) return bad('epgShiftMin');
    if ('name' in b) c.nameOv = b.name === null ? null : b.name.trim();
    if ('number' in b) c.numberOv = b.number;
    if ('groupId' in b) c.groupOv = b.groupId;
    if ('hidden' in b) c.hidden = b.hidden;
    if ('epg' in b) c.epgOff = b.epg === false;
    if ('epgShiftMin' in b) c.shiftOv = b.epgShiftMin;
    return J(ltvChanView(a, c));
  }
  if (mm[2] === '/test' && m === 'POST') {
    if (a.chTestBusy) { a.chTestBusy = false; return J({ error: 'test_running' }, 409); }
    const t = a.chTest;
    if ('status' in t) return J({ error: t.error }, t.status);
    if (!t.ok) { c.mode = null; c.probeError = t.error; return J({ ok: false, video: null, audio: null, needs: null, error: t.error }); }
    c.mode = 'remux'; c.probeError = null;
    return J({ ok: true, ...LTV_FACTS, ...(a.chPreview ? { preview: { url: `/media/l/${'p'.repeat(43)}/index.m3u8`, token: 'p'.repeat(43) } } : {}) });
  }
  if (mm[2] === '/logo' && m === 'PUT') {
    const up = body as { contentType: string; bytes: number };
    a.logoPuts.push({ id: c.id, type: up.contentType, bytes: up.bytes });
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(up.contentType)) return J({ error: 'unsupported_type' }, 415);
    if (up.bytes > 512 * 1024) return J({ error: 'too_large' }, 413);
    c.logoHash = 'b'.repeat(64); c.logoOv = true;
    return J(ltvChanView(a, c));
  }
  if (mm[2] === '/logo' && m === 'DELETE') { c.logoOv = false; c.logoHash = c.id === 'ch-1' ? 'a'.repeat(64) : null; return J(ltvChanView(a, c)); }
  return null;
}
/** the one-time push answer (Task 20): stream id "ff-" + 16 characters, a 32-character passphrase, the full SRT URL */
function pushAnswer(a: LivetvAreaMock, port: number) {
  const streamId = 'ff-AB12CDEFGH2345JK', passphrase = 'Zq3xV9mB2nK7pL4wR8tY6uH1jG5fD0sA';
  // no host (neither LIVETV_SRT_HOST nor PUBLIC_URL known): no URL either
  return { host: a.host, port, streamId, passphrase, url: a.host ? `srt://${a.host}:${port}?streamid=${streamId}&passphrase=${passphrase}&pbkeylen=32&mode=caller&latency=200000` : null };
}

// ---- Task 22: audit samples of `user.rights` (backend userRights.ts: `{ from, to, layer?, stored?, note? }`) and a role.delete with its label ----
/**
 * newest first; `user` is the person the entries are about, `actor` the admin. As the backend writes them (rights.ts diffRights): a changed value
 * has no `layer`; `layer` appears only when the value stayed and the deciding layer moved (sample 9002).
 */
/** the groups in the backend's list order: unreleased first, then by position */
const ltvSorted = (a: LivetvAreaMock) => [...a.groups].sort((x, y) => Number(x.released) - Number(y.released) || x.position - y.position || x.name.localeCompare(y.name));
/** a person's exceptions as the backend's `userGroups` answers them (id + name, in group order) */
function ltvExceptionsOf(a: LivetvAreaMock, userId: string) {
  const e = a.exceptions[userId] ?? { allow: [], deny: [] };
  const ref = (ids: string[]) => ltvSorted(a).filter((g) => ids.includes(g.id)).map((g) => ({ id: g.id, name: g.name }));
  return { allow: ref(e.allow), deny: ref(e.deny) };
}
/**
 * The channel groups routes (backend livetv/adminRoutes.ts, groups.ts; Task 18). Every write is recorded in `area.calls`; refusals as the
 * backend has them: 400 { error: 'invalid', field }, 404 not_found, 409 name_taken. A role that is not stored (an env-only one) and an
 * unknown one are `400 invalid roles`.
 */
function ltvGroupsRoute(st: AdminState, m: string, p: string, body: any, J: Reply): Promise<void> | null {
  const a = st.livetv.area;
  if (m !== 'GET') a.calls.push({ m, p, body });
  const catalogue = st.matrix.roles.map((r) => r.key);
  const view = (g: LtvGroupMock) => ({ ...g, roles: catalogue.filter((k) => g.roles.includes(k)) });
  const bad = (field: string) => J({ error: 'invalid', field }, 400);
  const rolesOk = (rs: unknown): rs is string[] => Array.isArray(rs) && rs.every((k) => st.matrix.roles.some((r) => r.key === k && r.stored));
  const nameOk = (n: unknown): n is string => typeof n === 'string' && n.trim().length >= 1 && n.trim().length <= 40;
  const taken = (n: string, except?: string) => a.groups.some((g) => g.id !== except && g.name.toLowerCase() === n.trim().toLowerCase());
  const known = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.every((i) => typeof i === 'string' && a.groups.some((g) => g.id === i));
  const strict = (b: any, keys: string[]) => typeof b === 'object' && b !== null && Object.keys(b).every((k) => keys.includes(k));
  let mm: RegExpMatchArray | null;

  if (p === '/api/admin/livetv/groups' && m === 'GET') return J({ groups: ltvSorted(a).map(view), pending: a.groups.filter((g) => !g.released).length });
  if (p === '/api/admin/livetv/groups' && m === 'POST') {
    if (!strict(body, ['name', 'kidFriendly', 'roles', 'released']) || !nameOk(body?.name)) return bad('name');
    if (body.roles !== undefined && !rolesOk(body.roles)) return bad('roles');
    if (taken(body.name)) return J({ error: 'name_taken' }, 409);
    const g = ltvGroup({ id: `g-new-${++a.seq}`, name: body.name.trim(), kidFriendly: body.kidFriendly === true, roles: [...new Set<string>(body.roles ?? [])], released: body.released ?? true, position: Math.max(-1, ...a.groups.map((x) => x.position)) + 1, channels: 0 });
    a.groups.push(g);
    return J(view(g), 201);
  }
  if (p === '/api/admin/livetv/groups/release' && m === 'POST') {
    if (!strict(body, ['ids', 'roles', 'kidFriendly']) || !Array.isArray(body?.ids) || !body.ids.length || typeof body.kidFriendly !== 'boolean') return bad('body');
    if (!rolesOk(body.roles)) return bad('roles');
    const hit = a.groups.filter((g) => body.ids.includes(g.id));
    for (const g of hit) Object.assign(g, { released: true, kidFriendly: body.kidFriendly, roles: [...new Set<string>(body.roles)] });
    return J({ released: hit.length });
  }
  if (p === '/api/admin/livetv/groups/order' && m === 'PUT') {
    if (!strict(body, ['ids']) || !Array.isArray(body?.ids)) return bad('ids');
    const rest = ltvSorted(a).filter((g) => !body.ids.includes(g.id)).map((g) => g.id);
    [...body.ids, ...rest].forEach((id: string, i: number) => { const g = a.groups.find((x) => x.id === id); if (g) g.position = i; });
    return J({ ok: true });
  }
  if (p === '/api/admin/livetv/groups/merge' && m === 'POST') {
    if (!strict(body, ['ids', 'into']) || !Array.isArray(body?.ids) || !body.ids.length || typeof body.into !== 'string') return bad('body');
    const into = a.groups.find((g) => g.id === body.into);
    const ids: string[] = body.ids.filter((i: string) => i !== body.into);
    if (!ids.length || !known(ids)) return bad('ids');
    if (!into) return J({ error: 'not_found' }, 404);
    for (const g of a.groups.filter((x) => ids.includes(x.id))) { into.providerGroups = [...new Set([...into.providerGroups, ...g.providerGroups])].sort(); into.channels += g.channels; }
    a.groups = a.groups.filter((g) => !ids.includes(g.id));
    for (const e of Object.values(a.exceptions)) { e.allow = e.allow.filter((i) => !ids.includes(i)); e.deny = e.deny.filter((i) => !ids.includes(i)); }
    return J(view(into));
  }
  if ((mm = p.match(/^\/api\/admin\/livetv\/groups\/([^/]+)$/))) {
    const g = a.groups.find((x) => x.id === mm![1]);
    if (m === 'GET') return g ? J(view(g)) : J({ error: 'not_found' }, 404);
    if (!g) return J({ error: 'not_found' }, 404);
    if (m === 'DELETE') {
      a.groups = a.groups.filter((x) => x.id !== g.id);
      for (const e of Object.values(a.exceptions)) { e.allow = e.allow.filter((i) => i !== g.id); e.deny = e.deny.filter((i) => i !== g.id); }
      return J({ ok: true });
    }
    if (m === 'PATCH') {
      if (!strict(body, ['name', 'kidFriendly', 'roles', 'released'])) return bad('body');
      if (body.name !== undefined && !nameOk(body.name)) return bad('name');
      if (body.roles !== undefined && !rolesOk(body.roles)) return bad('roles');
      if (body.name !== undefined && taken(body.name, g.id)) return J({ error: 'name_taken' }, 409);
      if (body.name !== undefined) g.name = body.name.trim();
      if (body.kidFriendly !== undefined) g.kidFriendly = body.kidFriendly;
      if (body.roles !== undefined) g.roles = [...new Set<string>(body.roles)];
      if (body.released !== undefined) g.released = body.released;
      return J(view(g));
    }
  }
  return null;
}
/** `livetvCheck` (backend livetv/rights.ts): every group with whether the profile sees it and why not; null when Live TV is not installed or the account lacks `liveTv` */
function ltvCheckMock(st: AdminState, u: AdminUser, p: DetailProfile) {
  const a = st.livetv.area;
  if (!st.livetv.installed || viewRows(st, u, p).find((r) => r.key === 'liveTv')?.value !== true) return null;
  const ex = a.exceptions[u.id] ?? { allow: [], deny: [] };
  const groups = ltvSorted(a).map((g) => {
    const reason = !g.released ? 'notReleased' : p.kids && !g.kidFriendly ? 'notKidFriendly' : u.role === 'admin' ? null : ex.deny.includes(g.id) ? 'denied' : g.roles.includes(u.role) || ex.allow.includes(g.id) ? null : 'notGranted';
    return { id: g.id, name: g.name, visible: reason === null, reason, channels: g.channels };
  });
  return { groups: groups.map(({ channels: _c, ...g }) => g), channels: groups.filter((g) => g.visible).reduce((n, g) => n + g.channels, 0) };
}
export function rightsAuditSamples(user: { id: string; name: string }, actor = 'Ben Muster'): AuditRow[] {
  const row = (id: number, minutes: number, action: string, meta: Record<string, unknown>): AuditRow => ({ id, at: new Date(Date.now() - minutes * 60000).toISOString(), action, target: user.id, meta, actor, target_name: user.name });
  return [
    row(9005, 0.5, 'user.rights', { from: { transcoding: true }, to: { transcoding: false } }),
    row(9004, 1, 'user.rights', { from: {}, to: {}, stored: { cast: { from: true, to: null } } }),
    row(9003, 2, 'user.rights', { from: { requestsPerMonth: 5 }, to: { requestsPerMonth: null } }),
    row(9002, 3, 'user.rights', { from: { cast: true }, to: { cast: true }, layer: { cast: { from: 'role', to: 'user' } } }),
  ];
}
export const roleDeleteSample = (key: string, label: string): AuditRow => ({ id: 9100, at: new Date(Date.now() - 5 * 60000).toISOString(), action: 'role.delete', target: key, meta: { moveTo: null, accounts: 0, invites: 0, label }, actor: 'Ben Muster', target_name: null });

export function adminSummary(st: AdminState) {
  const pendingReq = st.requests.filter((r) => r.status === PENDING).length;
  const locked = st.users.filter((u) => u.disabled).length;
  return {
    users: { total: st.users.length, active: st.users.length - locked, locked, expiring: st.users.filter((u) => u.access_until != null && Date.parse(u.access_until) >= Date.now() && Date.parse(u.access_until) <= Date.now() + WEEK).length },
    pending: { requests: st.seerrUp ? pendingReq : null, devices: st.devices.filter((d) => !d.approved).length, polls: st.polls.length, invites: st.invites.filter((i) => i.uses < i.max_uses && i.expires_at > new Date().toISOString()).length, approvals: st.approvals.length, previewsFailed: 10 },
    requests: st.seerrUp ? { pending: pendingReq, approved: st.requests.filter((r) => r.status === 'genehmigt').length, processing: 1, available: st.requests.filter((r) => r.status === 'verfügbar').length, declined: 2, total: st.requests.length + 3 } : null,
    storage: { downloadsEnabled: true, downloadsBytes: 12.4 * 1024 ** 3, downloadsMaxBytes: 50 * 1024 ** 3, previewBytes: 99e6, previewClips: 30 },
    playbackCheck: { finishedAt: ago(2), total: 20, failed: 1 },
    services: { jellyfin: true, seerr: st.seerrUp },
    live: { streams: 2, partyRooms: 1 },
    livetv: { installed: st.livetv.installed, offerHidden: st.livetv.offerHidden, failedSources: st.livetv.failedSources },
    mfaFilter: st.authentik.recovery,
    recoIndex: st.recoIndex,
  };
}


type Reply = (body: unknown, status?: number) => Promise<void>;

/**
 * Answers an /api/admin/** call; returns null when the path is not an admin endpoint (the caller then reports it as unmocked).
 * `body` is the parsed JSON request body.
 */
export function adminRoute(st: AdminState, m: string, p: string, sp: URLSearchParams, body: any, J: Reply): Promise<void> | null {
  let mm: RegExpMatchArray | null;
  const ok = () => J({ ok: true });
  const log = (action: string, target: string | null, meta: Record<string, unknown> = {}, target_name: string | null = null) =>
    st.audit.unshift({ id: (st.audit[0]?.id ?? 0) + 1, at: new Date().toISOString(), action, target, meta, actor: 'Tester', target_name });

  // R4: CTR and play rate per recommendation engine (the server's counters)
  if (p === '/api/admin/reco') return J({
    engine: 'shadow', locked: false, fallbacks: 3, since: '2026-10-18T08:00:00.000Z',
    engines: {
      v1: { impressions: 400, clicks: 40, plays: 20, dismisses: 4, ctr: 0.1, playRate: 0.05 },
      v2: { impressions: 0, clicks: 0, plays: 0, dismisses: 0, ctr: null, playRate: null },
    },
  });
  if (p.startsWith('/api/admin/livetv/groups')) return ltvGroupsRoute(st, m, p, body, J);
  if (p.startsWith('/api/admin/livetv/')) return livetvRoute(st.livetv, m, p, sp, body, J);
  if (p === '/api/admin/summary') return st.summaryFails ? J({ error: 'boom' }, 500) : J(adminSummary(st));
  if (p === '/api/admin/status') {
    const s = adminSummary(st);
    return J({ users: s.users.active, pendingDevices: s.pending.devices, openInvites: s.pending.invites, pendingPolls: s.pending.polls, activeStreams: 2, partyRooms: 1, jellyfin: true });
  }

  // ---- people ----
  // open requests have no rights or 2FA state (backend: 400 bad_request)
  if (p === '/api/admin/users' && sp.get('status') === 'pending' && (sp.has('perm') || sp.has('mfa'))) return J({ error: 'bad_request' }, 400);
  if (p === '/api/admin/users') return J(usersList(st, sp));
  // ---- user detail (Block 23) ----
  if ((mm = p.match(/^\/api\/admin\/users\/([0-9a-f-]{36}|u1)(\/.*)?$/)) && !(m === 'PATCH' && !mm[2]) && mm[2] !== '/revoke-sessions') {
    const u = st.users.find((x) => x.id === mm![1]);
    if (!u) return J({ error: 'not_found' }, 404);
    const rest = mm[2] ?? '';
    let sub: RegExpMatchArray | null;
    if (!rest && m === 'GET') return J(userDetail(st, u));
    if (rest === '/activity' && m === 'GET') {
      st.activityCalls++;
      log('user.activity_viewed', u.id, { profiles: 2 }, u.name);
      const pr = profilesOf(st, u);
      return J({ items: [
        { id: 'it1', name: 'Hearth', type: 'Movie', played: false, playedPercentage: 45.4, lastPlayedDate: ago(2), profile: { id: pr[0]!.id, name: pr[0]!.name } },
        { id: 'it2', name: 'Pilot', type: 'Episode', seriesName: 'Sundial', parentIndexNumber: 1, indexNumber: 1, played: true, lastPlayedDate: ago(30), profile: { id: pr[1]!.id, name: pr[1]!.name } },
      ], skipped: [] });
    }
    if (rest === '/audit' && m === 'GET') {
      const rows = st.audit.filter((e) => e.target === u.id);
      const { slice, total } = paged(rows, sp, 50);
      return J({ entries: slice.map((e) => ({ ...e, actor_id: e.actor ? 'u1' : null })), total });
    }
    if (rest === '/limits') {
      const cur = (st.limits[u.id] ??= { maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null });
      if (m === 'GET') return J({ limits: cur, role: DETAIL_ROLE_LIMITS });
      if (m === 'PUT') { const to = { ...cur, ...body }; log('user.limits', u.id, { from: cur, to }, u.name); st.limits[u.id] = to; return J({ limits: to }); }
    }
    // ---- Sicht prüfen (backend viewcheck.ts, adminUsers.ts): the rights of one profile, its library counts and the title check ----
    if (rest === '/livetv-groups' && m === 'PUT') {
      // backend adminUsers.ts: the body is strict, an overlap is 400 invalid deny, an admin takes none, an unknown group is 400 invalid
      const a = st.livetv.area, ids = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
      if (typeof body !== 'object' || body === null || Object.keys(body).some((k) => k !== 'allow' && k !== 'deny') || !ids(body.allow) || !ids(body.deny)) return J({ error: 'invalid', field: 'body' }, 400);
      a.calls.push({ m, p, body });
      if (body.allow.some((g: string) => body.deny.includes(g))) return J({ error: 'invalid', field: 'deny' }, 400);
      if (u.role === 'admin' && (body.allow.length || body.deny.length)) return J({ error: 'admin_groups_locked' }, 400);
      for (const k of ['allow', 'deny'] as const) if (body[k].some((g: string) => !a.groups.some((x) => x.id === g))) return J({ error: 'invalid', field: k }, 400);
      log('user.livetv_groups', u.id, { allow: body.allow, deny: body.deny }, u.name);
      a.exceptions[u.id] = { allow: [...new Set<string>(body.allow)], deny: [...new Set<string>(body.deny)] };
      return J({ livetvGroups: ltvExceptionsOf(a, u.id) });
    }
    if (rest === '/rights' && m === 'GET' && sp.has('profile')) return viewRights(st, u, sp.get('profile')!, J);
    if (rest === '/check' && (m === 'GET' || m === 'POST')) return viewCheck(st, u, m, m === 'GET' ? { profileId: sp.get('profile') } : body, J, log);
    // every matrix row of the account (backend userRights.ts rightsView): effective value, the role's value, the stored override (null = none; an admin's
    // switches never show one) and the deciding layer; PUT is partial (null = back to the role, a value equal to the role's is not stored)
    if (rest === '/rights') {
      const role = st.matrix.roles.find((r) => r.key === u.role);
      if (!role) return J({ error: 'unknown_role' }, 409);
      const isAdmin = u.role === 'admin';
      const rowOf = (k: string) => rightsRow(role, u, k);
      if (m === 'GET') {
        const rows = MATRIX_FIELDS_MOCK.map((f) => rowOf(f.key as string));
        const libs = rows.find((r) => r.key === 'libraries')!.value;
        const missing = Array.isArray(libs) ? libs.filter((n) => !st.matrix.libraries.some((l) => l.name.toLowerCase() === String(n).toLowerCase())) : [];
        return J({ role: u.role, note: u.note ?? null, rows, profile: null, hardKids: [], missingLibraries: missing, livetvGroups: ltvExceptionsOf(st.livetv.area, u.id) });
      }
      if (m === 'PUT') {
        const o = (body?.overrides ?? {}) as Record<string, unknown>;
        const keys = MATRIX_FIELDS_MOCK.map((f) => f.key as string);
        if (typeof body !== 'object' || Object.keys(body ?? {}).some((k) => k !== 'overrides' && k !== 'note') || Object.keys(o).some((k) => !keys.includes(k))) return J({ error: 'bad_request' }, 400);
        if (body?.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.trim().length > 200)) return J({ error: 'bad_request' }, 400);
        // the backend resolves library names first (case-insensitive, the server's spelling): 400 unknown_library; then, in the write, the admin lock
        if (Array.isArray(o.libraries)) {
          const known = o.libraries.map((n) => st.matrix.libraries.find((l) => l.name.toLowerCase() === String(n).toLowerCase())?.name);
          if (known.includes(undefined)) return J({ error: 'unknown_library' }, 400);
          o.libraries = [...new Set(known as string[])];
        }
        // the admin role's switches are always on: none can be set, a stored one may be cleared (null)
        if (isAdmin && PERM_KEYS_MOCK.some((k) => o[k] !== undefined && o[k] !== null)) return J({ error: 'admin_perms_locked' }, 400);
        const { changed } = writeRightsMock(role, u, o, body?.note, log);
        const media = changed.some((k) => MEDIA_KEYS_MOCK.includes(k));
        if (media && st.matrix.policyPartial) return J({ error: 'policy_partial', failed: st.matrix.failed, identities: 2 }, 502);
        return J({ ok: true, reapplied: { identities: media ? 2 : 0, failed: 0 } });
      }
    }
    if (rest === '/repair' && m === 'POST') {
      // identities that still fail (matrix.policyPartial): a 200 with ok:false, nothing healed
      if (st.matrix.policyPartial) { log('user.repair', u.id, { failed: st.matrix.failed }, u.name); return J({ ok: false, jellyfin: { identities: 2, failed: st.matrix.failed }, requests: { ok: true, id: 7 } }); }
      st.linkedOk = { jellyfin: st.linkedOk.jellyfin === false ? true : st.linkedOk.jellyfin, requests: true };
      log('user.repair', u.id, {}, u.name);
      return J({ ok: true, jellyfin: { identities: 2, failed: 0 }, requests: { ok: true, id: 7 } });
    }
    if (rest === '/recovery' && m === 'POST') { log('user.recovery_email', u.id, { ok: true }, u.name); return ok(); }
    if (rest === '/mfa-setup' && m === 'POST') return J({ error: 'not_supported' }, 501);
    // Block 23 self-service: cancel a scheduled deletion (ended access stays locked as expired), or let the next tick delete it
    if (rest === '/deletion/restore' && m === 'POST') {
      if (st.claimed.has(u.id)) return J({ error: 'deletion_in_progress' }, 409);
      if (!u.deletion_at || u.locked_reason !== 'deletion') return J({ error: 'not_scheduled' }, 409);
      u.deletion_at = null;
      if (accessEnded(u.access_until ?? null)) { u.locked_reason = 'expired'; log('user.deletion_restored', u.id, { lockedReason: 'expired' }, u.name); }
      else { u.disabled = false; u.locked_reason = undefined; log('user.enable', u.id, {}, u.name); log('user.deletion_restored', u.id, {}, u.name); }
      return ok();
    }
    if (rest === '/deletion/now' && m === 'POST') {
      if (u.id === 'u1') return J({ error: 'cannot_lock_yourself_out' }, 400);
      if (!u.deletion_at || u.locked_reason !== 'deletion') return J({ error: 'not_scheduled' }, 409);
      const to = new Date().toISOString();
      log('user.deletion_now', u.id, { from: u.deletion_at, to }, u.name);
      u.deletion_at = to;
      return ok();
    }
    if ((sub = rest.match(/^\/sessions\/([^/]+)\/revoke$/)) && m === 'POST') { log('user.revoke_device', u.id, { deviceId: sub[1] }, u.name); return J({ revoked: 1 }); }
    // profiles (backend/src/routes/adminUsers.ts): PATCH rename / resetPin / kids / maxRating, POST a kids profile, DELETE a kids profile.
    // Order as there: body check (400 bad_request), account (404), deletion claim (409 deletion_in_progress), then the profile's own errors.
    const own = (n: Record<string, unknown>, allowed: string[]) => typeof n === 'object' && n !== null && Object.keys(n).every((k) => allowed.includes(k));
    const nameOk = (v: unknown) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 20;
    const capOk = (v: unknown) => v === 0 || v === 6 || v === 12;
    const pub = (x: DetailProfile) => ({ id: x.id, name: x.name, avatar: x.avatar, isOwner: x.isOwner, kids: x.kids, ...(x.kids ? { maxRating: x.maxRating } : {}), hasPin: x.hasPin });
    const recount = () => { const l = profilesOf(st, u); u.profiles = l.length; u.kidsProfiles = l.filter((x) => x.kids).length; };
    const taken = (name: string, except?: DetailProfile) => profilesOf(st, u).some((x) => x !== except && x.name.toLowerCase() === name.trim().toLowerCase());
    if (rest === '/profiles' && m === 'POST') {
      if (!own(body, ['name', 'kids', 'maxRating', 'avatar']) || !nameOk(body.name) || body.kids !== true || !capOk(body.maxRating)
        || (body.avatar !== undefined && !/^[a-z0-9-]{1,20}$/.test(String(body.avatar)))) return J({ error: 'bad_request' }, 400);
      if (st.claimed.has(u.id)) return J({ error: 'deletion_in_progress' }, 409);
      const list = profilesOf(st, u);
      if (list.length >= 5) return J({ error: 'max_profiles' }, 409);
      if (taken(body.name)) return J({ error: 'name_taken' }, 409);
      const pr: DetailProfile = { id: `${u.id.slice(0, -4)}p${String(100 + ++st.profileSeq)}`, name: body.name.trim(), kids: true, maxRating: body.maxRating, avatar: body.avatar ?? 'red', lastUsed: null, isOwner: false, hasPin: false };
      list.push(pr);
      recount();
      log('profile.admin_create', u.id, { profile: pr.id, maxRating: pr.maxRating }, u.name);
      return J({ profile: pub(pr) }, 201);
    }
    if ((sub = rest.match(/^\/profiles\/([^/]+)$/)) && m === 'PATCH') {
      const keys = ['name', 'resetPin', 'kids', 'maxRating'];
      if (!own(body, keys) || !keys.some((k) => body[k] !== undefined) || (body.name !== undefined && !nameOk(body.name)) || (body.resetPin !== undefined && body.resetPin !== true)
        || (body.kids !== undefined && typeof body.kids !== 'boolean') || (body.maxRating !== undefined && !capOk(body.maxRating))) return J({ error: 'bad_request' }, 400);
      if (st.claimed.has(u.id)) return J({ error: 'deletion_in_progress' }, 409);
      const pr = profilesOf(st, u).find((x) => x.id === sub![1]);
      if (!pr) return J({ error: 'not_found' }, 404);
      if (body.kids !== undefined && pr.isOwner) return J({ error: 'owner_not_kids' }, 400);
      const kids = body.kids ?? pr.kids;
      if (body.maxRating !== undefined && !kids) return J({ error: 'not_kids' }, 400);
      if (body.name && taken(body.name, pr)) return J({ error: 'name_taken' }, 409);
      const from: Record<string, unknown> = { name: pr.name, hasPin: pr.hasPin };
      const kidsFrom = { kids: pr.kids, maxRating: pr.maxRating };
      if (body.name) pr.name = body.name.trim();
      if (body.resetPin) pr.hasPin = false;
      // the DB keeps the cap of a profile that stops being a kids one (shown as null), a new kids profile starts at 12
      if (!pr.kids && kids) pr.maxRating = body.maxRating ?? st.keptCap.get(pr.id) ?? 12;
      else if (pr.kids && !kids) { st.keptCap.set(pr.id, pr.maxRating ?? 12); pr.maxRating = null; }
      else if (kids && body.maxRating !== undefined) pr.maxRating = body.maxRating;
      pr.kids = kids;
      const to: Record<string, unknown> = { name: pr.name, hasPin: pr.hasPin };
      if (kidsFrom.kids !== pr.kids || kidsFrom.maxRating !== pr.maxRating) { Object.assign(from, kidsFrom); Object.assign(to, { kids: pr.kids, maxRating: pr.maxRating }); }
      recount();
      log('profile.admin_update', u.id, { profile: pr.id, from, to }, u.name);
      // a kids change the media server did not take: stored and audited, the answer says so (Repair re-applies it)
      if (st.profileMediaFails && (body.kids !== undefined || body.maxRating !== undefined)) return J({ error: 'jellyfin' }, 502);
      return J({ profile: pub(pr) });
    }
    if ((sub = rest.match(/^\/profiles\/([^/]+)$/)) && m === 'DELETE') {
      if (st.claimed.has(u.id)) return J({ error: 'deletion_in_progress' }, 409);
      const list = profilesOf(st, u);
      const pr = list.find((x) => x.id === sub![1]);
      if (!pr) return J({ error: 'not_found' }, 404);
      if (pr.isOwner) return J({ error: 'owner_profile' }, 400);
      if (!pr.kids) return J({ error: 'not_kids_profile' }, 400);
      st.userProfiles[u.id] = list.filter((x) => x !== pr);
      recount();
      log('profile.admin_delete', u.id, { profile: pr.id }, u.name);
      return ok();
    }
    return null;
  }
  if ((mm = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && m === 'PATCH') {
    const u = st.users.find((x) => x.id === mm![1]);
    if (!u) return J({ error: 'not_found' }, 404);
    if (u.id === 'u1' && (body.disabled || (body.role && body.role !== 'admin'))) return J({ error: 'cannot_lock_yourself_out' }, 400);
    const until = body.accessUntil !== undefined ? body.accessUntil : u.access_until ?? null;
    if (body.disabled === false && u.disabled && accessEnded(until)) return J({ error: 'access_expired' }, 409);
    if (body.role && body.role !== u.role) { log('user.role', u.id, { from: u.role, to: body.role }, u.name); u.role = body.role; }
    if (typeof body.disabled === 'boolean' && body.disabled !== u.disabled) { u.disabled = body.disabled; log(body.disabled ? 'user.disable' : 'user.enable', u.id, {}, u.name); }
    if (body.accessUntil !== undefined) {
      log('user.access', u.id, { from: u.access_until ?? null, to: body.accessUntil }, u.name); u.access_until = body.accessUntil;
      if (u.disabled && u.locked_reason === 'expired' && !accessEnded(body.accessUntil)) { u.disabled = false; u.locked_reason = undefined; log('user.enable', u.id, {}, u.name); }
    }
    return ok();
  }
  if ((mm = p.match(/^\/api\/admin\/users\/([^/]+)\/revoke-sessions$/)) && m === 'POST') return J({ revoked: 2 });
  if (p === '/api/admin/users/bulk' && m === 'POST') {
    const users = (body.ids as string[]).map((id) => st.users.find((u) => u.id === id));
    if (users.some((u) => !u)) return J({ error: 'not_found' }, 404);
    if ((body.action === 'lock' || (body.action === 'role' && body.role !== 'admin')) && body.ids.includes('u1')) return J({ error: 'cannot_lock_yourself_out' }, 400);
    if (body.action === 'unlock' && (users as AdminUser[]).some((u) => u.disabled && accessEnded(u.access_until ?? null))) return J({ error: 'access_expired' }, 409);
    // the admin role's switches are locked: refused as a whole before the first write (clearing stays possible)
    if (body.action === 'perm' && body.value !== null && (users as AdminUser[]).some((u) => u.role === 'admin')) return J({ error: 'admin_perms_locked' }, 400);
    let done = 0, failed = 0;
    for (const u of users as AdminUser[]) {
      if (body.action === 'repair') {
        if (st.repairFails.has(u.id)) { failed++; continue; }
        log('user.repair', u.id, {}, u.name);
      } else if (body.action === 'perm') {
        // the same per-account write as PUT /rights (backend adminUsers bulk → putRights): counted only when something changed
        const role = st.matrix.roles.find((r) => r.key === u.role);
        if (!role || !writeRightsMock(role, u, { [body.perm]: body.value }, undefined, log).changed.length) continue;
      } else if (body.action === 'lock' || body.action === 'unlock') {
        const d = body.action === 'lock';
        if (u.disabled === d) continue;
        u.disabled = d; log(d ? 'user.disable' : 'user.enable', u.id, {}, u.name);
      } else if (body.action === 'role') {
        if (u.role === body.role) continue;
        log('user.role', u.id, { from: u.role, to: body.role }, u.name); u.role = body.role;
      } else if (body.action === 'access') {
        log('user.access_until', u.id, { from: u.access_until ?? null, to: body.accessUntil }, u.name); u.access_until = body.accessUntil;
      }
      done++;
    }
    return J(failed ? { done, failed } : { done });
  }
  if (p === '/api/admin/approvals' && m === 'GET') return J({ requests: st.approvals });
  if ((mm = p.match(/^\/api\/admin\/approvals\/([^/]+)\/(approve|reject)$/)) && m === 'POST') {
    const a = st.approvals.find((x) => x.id === mm![1]);
    if (!a) return J({ error: 'not_found' }, 404);
    st.approvals = st.approvals.filter((x) => x !== a);
    if (mm[2] === 'reject') { log('user.rejected', a.id, { from: 'pending', to: 'rejected', name: a.name, message: body?.message ?? null }); return ok(); }
    const id = auid(500 + st.users.length);
    st.users.push({ id, name: a.name, email: a.email, role: body.role, disabled: false, jellyfin_username: a.name.split(' ')[0]!.toLowerCase(), seerr_user_id: null, created_at: new Date().toISOString(), last_seen: null, access_until: body.accessUntil ?? null });
    log('user.approved', id, { from: 'pending', to: body.role }, a.name);
    return J({ id });
  }
  if (p === '/api/admin/roles' && m === 'GET') {
    const mx = st.matrix;
    // env-only roles come after the stored ones (listRoles appends them), the rest in table order
    const rows = [...mx.roles.filter((r) => r.stored), ...mx.roles.filter((r) => !r.stored)];
    return J({
      roles: ROLES, invitable: ['friend', 'family', 'guest'],
      limits: Object.entries(ROLES).map(([role, r], i) => ({ role, label: r.label, builtinLabel: true, requestsPerMonth: i === 0 ? null : 3, isDefault: i === 2, transcoding: i !== 3, maxHeight: i === 1 ? 1080 : null, download: i < 2, maxDownloads: 5, downloadMaxHeight: 720, downloadDays: 30, maxBitrate: role === 'guest' ? 2_000_000 * 4 : 40_000_000, remoteMaxBitrate: role === 'family' ? 12_000_000 : role === 'guest' ? 4_000_000 : 8_000_000, remoteDefault: role === 'guest' ? 4_000_000 : 8_000_000, remoteIsDefault: role !== 'family' })),
      matrix: {
        fields: MATRIX_FIELDS_MOCK, features: mx.features, libraries: mx.libraries,
        roles: rows.map((r, position) => ({
          key: r.key, label: r.label, builtinLabel: r.builtinLabel, base: r.base, origin: r.origin, invitable: r.invitable, position,
          envGone: r.envGone, stored: r.stored, accounts: r.accounts, profiles: r.profiles, kidsProfiles: r.kidsProfiles, values: r.values, sources: r.sources, missingLibraries: r.missingLibraries,
          // backend roleGroupNames: the released groups the role sees (the admin: all), in group order
          livetvGroups: ltvSorted(st.livetv.area).filter((g) => g.released && (r.key === 'admin' || g.roles.includes(r.key))).sort((x, y) => x.position - y.position).map((g) => g.name),
          // the value without the role's own row (the backend's roleRights(ctx, key, null))
          defaults: Object.fromEntries(MATRIX_FIELDS_MOCK.map((f) => [f.key as string, inheritedValue(r, f.key as string)])),
        })),
      },
    });
  }
  // the order write ignores keys that are not in the roles table (env-only roles); the rest must be a permutation of the stored roles
  if (p === '/api/admin/roles/order' && m === 'PUT') {
    const stored = st.matrix.roles.filter((r) => r.stored).map((r) => r.key);
    const keys = (Array.isArray(body?.keys) ? body.keys : []).filter((k: unknown): k is string => typeof k === 'string' && stored.includes(k));
    if (new Set(keys).size !== keys.length || keys.length !== stored.length) return J({ error: 'bad_order' }, 400);
    const rest = st.matrix.roles.filter((r) => !r.stored);
    st.matrix.roles = [...keys.map((k: string) => st.matrix.roles.find((r) => r.key === k)!), ...rest];
    st.matrix.orders.push(Array.isArray(body?.keys) ? body.keys : []);
    log('role.order', null, { keys });
    return ok();
  }
  if (p === '/api/admin/roles' && m === 'POST') {
    const src = st.matrix.roles.find((r) => r.key === body?.from);
    if (!src) return J({ error: 'not_found' }, 404);
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label || label.length > 30) return J({ error: 'bad_request' }, 400);
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role';
    if (!/^[a-z]/.test(key)) key = `r-${key}`;
    const taken = new Set(st.matrix.roles.map((r) => r.key));
    for (let n = 2; taken.has(key); n++) key = `${key.replace(/-\d+$/, '')}-${n}`;
    const copy: MatrixMockRole = { ...src, key, label, builtinLabel: false, origin: 'admin', stored: true, envGone: false, accounts: 0, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...src.values }, sources: Object.fromEntries(Object.keys(src.values).map((k) => [k, 'role' as const])), missingLibraries: [] };
    const at = st.matrix.roles.findIndex((r) => !r.stored);
    st.matrix.roles.splice(at < 0 ? st.matrix.roles.length : at, 0, copy);
    log('role.create', key, { from: src.key, label });
    return J({ key }, 201);
  }
  if ((mm = p.match(/^\/api\/admin\/roles\/([^/]+)$/)) && m === 'PUT') {
    // the role API's encodings: null = back to the inherited value, 'unlimited' lifts a cap (a number otherwise)
    const capOk = (v: unknown) => v === undefined || v === null || v === 'unlimited' || typeof v === 'number';
    if (!capOk(body?.maxHeight) || !capOk(body?.requestsPerMonth) || !capOk(body?.maxParentalRating)) return J({ error: 'bad_request' }, 400);
    const role = st.matrix.roles.find((r) => r.key === decodeURIComponent(mm![1]!));
    if (!role) return J({ error: 'not_found' }, 404);
    // a ROLE_TEMPLATES key the catalogue cannot hold has no row for the name or the invitable switch
    if (!role.stored && (body?.label !== undefined || body?.invitable !== undefined)) return J({ error: 'not_in_catalogue' }, 400);
    if (role.base === 'admin' && body?.perms) return J({ error: 'admin_perms_locked' }, 400);
    st.matrix.puts.push({ role: role.key, body });
    const media = Object.keys(body ?? {}).some((k) => MEDIA_KEYS_MOCK.includes(k));
    const set = (k: string, v: unknown) => {
      if (v === undefined) return;
      if (v === null) { role.values[k] = inheritedValue(role, k); role.sources[k] = role.origin === 'env' ? 'env' : 'default'; } else { role.values[k] = v === 'unlimited' ? null : v; role.sources[k] = 'role'; }
    };
    const before = { ...role.values };
    const was = { label: role.builtinLabel ? null : role.label, invitable: role.invitable };
    for (const [k, v] of Object.entries(body ?? {})) {
      if (k === 'label') { if (v === null) { role.label = null; role.builtinLabel = role.origin === 'code'; } else { role.label = String(v); role.builtinLabel = false; } } else if (k === 'invitable') role.invitable = Boolean(v);
      else if (k === 'perms' && v && typeof v === 'object') for (const [pk, pv] of Object.entries(v)) { if (PERM_KEYS_MOCK.includes(pk)) set(pk, pv); } else set(k, v);
    }
    // as the backend audits it (roleWrite.ts): the changed effective values, then the catalogue's label / invitable, before and after
    const moved = MATRIX_FIELDS_MOCK.map((f) => f.key as string).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(role.values[k]));
    const from: Record<string, unknown> = Object.fromEntries(moved.map((k) => [k, before[k]])), to: Record<string, unknown> = Object.fromEntries(moved.map((k) => [k, role.values[k]]));
    const now = { label: role.builtinLabel ? null : role.label, invitable: role.invitable };
    if (now.label !== was.label) { from.label = was.label; to.label = now.label; }
    if (now.invitable !== was.invitable) { from.invitable = was.invitable; to.invitable = now.invitable; }
    if (Object.keys(to).length) log('role.update', role.key, { from, to });
    const identities = role.accounts + role.profiles;
    if (media && st.matrix.policyPartial) return J({ error: 'policy_partial', failed: st.matrix.failed, identities }, 502);
    return J({ ok: true, reapplied: { identities: media ? identities : 0, failed: 0 } });
  }
  if ((mm = p.match(/^\/api\/admin\/roles\/([^/]+)$/)) && m === 'DELETE') {
    const role = st.matrix.roles.find((r) => r.key === decodeURIComponent(mm![1]!));
    if (!role) return J({ error: 'not_found' }, 404);
    if (role.origin === 'code') return J({ error: 'builtin_role' }, 400);
    if (role.origin === 'env' && !role.envGone) return J({ error: 'env_role' }, 400);
    const target = body?.moveTo === undefined ? undefined : st.matrix.roles.find((r) => r.key === body.moveTo);
    if (body?.moveTo !== undefined && (!target || target === role || target.base === 'admin')) return J({ error: 'bad_target' }, 400);
    if ((role.accounts > 0 || role.invites > 0) && !target) return J({ error: 'role_in_use', accounts: role.accounts, invites: role.invites }, 409);
    if (target) { target.accounts += role.accounts; target.profiles += role.profiles; target.kidsProfiles += role.kidsProfiles; target.invites += role.invites; }
    st.matrix.roles = st.matrix.roles.filter((r) => r !== role);
    st.matrix.deletes.push({ role: role.key, moveTo: target?.key ?? null });
    log('role.delete', role.key, { moveTo: target?.key ?? null, accounts: target ? role.accounts : 0, invites: role.invites, ...(role.label ? { label: role.label } : {}) });
    return J({ ok: true, accounts: role.accounts, invites: role.invites });
  }
  if (p === '/api/admin/devices') return J(devicesList(st, sp));
  // Task 33: PATCH /api/admin/devices/:userId/:deviceId { startLive }, TV devices only (400 not_tv otherwise)
  if ((mm = p.match(/^\/api\/admin\/devices\/([^/]+)\/([^/]+)$/)) && m === 'PATCH') {
    const d = st.devices.find((x) => x.user_id === decodeURIComponent(mm![1]!) && x.device_id === decodeURIComponent(mm![2]!));
    if (!d) return J({ error: 'not_found' }, 404);
    if (!d.device_id.startsWith('tv-')) return J({ error: 'not_tv' }, 400);
    d.startLive = Boolean(body.startLive); log('device.start_live', d.user_id, { startLive: d.startLive }, d.name);
    return ok();
  }
  if (p === '/api/admin/devices/approve' && m === 'POST') {
    const d = st.devices.find((x) => x.user_id === body.userId && x.device_id === body.deviceId);
    if (!d) return J({ error: 'not_found' }, 404);
    d.approved = true; log('device.approve', d.user_id, { by: 'admin' }, d.name);
    return ok();
  }
  if ((p === '/api/admin/devices/unapprove' || p === '/api/admin/devices/remove') && m === 'POST') {
    const d = st.devices.find((x) => x.user_id === body.userId && x.device_id === body.deviceId);
    if (!d) return J({ error: 'not_found' }, 404);
    if (p.endsWith('/remove')) { st.devices = st.devices.filter((x) => x !== d); log('device.remove', d.user_id, { by: 'admin' }, d.name); } else { d.approved = false; log('device.unapprove', d.user_id, { by: 'admin' }, d.name); }
    return ok();
  }
  if (p === '/api/admin/invites' && m === 'GET') return J(invitesList(st, sp));
  if (p === '/api/admin/invites' && m === 'POST') {
    const id = auid(300 + st.invites.length);
    const maxUses = body.maxUses ?? 1;
    st.invites.unshift({ id, role: body.role, note: body.note ?? null, expires_at: fut(body.ttlHours ?? 48), used_at: null, used_by_name: null, uses: 0, max_uses: maxUses, access_days: body.accessDays ?? null });
    log('invite.create', id, { role: body.role, maxUses, accessDays: body.accessDays ?? null });
    return J({ id, link: `https://portal.example.com/invite/${'t'.repeat(32)}`, authentik: 'ok', expiresAt: fut(body.ttlHours ?? 48), uses: 0, maxUses });
  }
  if ((mm = p.match(/^\/api\/admin\/invites\/([^/]+)\/uses$/)) && m === 'GET') {
    if (!st.invites.some((i) => i.id === mm![1])) return J({ error: 'not_found' }, 404);
    return J({ uses: st.inviteUses[mm[1]!] ?? [] });
  }
  // revoke: an unused invite is deleted, a partly used one is closed (max_uses = uses), a used-up one stays
  if ((mm = p.match(/^\/api\/admin\/invites\/([^/]+)$/)) && m === 'DELETE') {
    const inv = st.invites.find((i) => i.id === mm![1]);
    if (inv && inv.uses === 0) st.invites = st.invites.filter((i) => i !== inv);
    else if (inv) inv.max_uses = inv.uses;
    log('invite.revoke', mm[1]!);
    return ok();
  }
  if (p === '/api/admin/audit') {
    // backend admin.ts: area is the literal 'people'; target 1..64 characters
    const t = sp.get('target');
    if ((sp.has('area') && sp.get('area') !== 'people') || (t !== null && (t.length < 1 || t.length > 64))) return J({ error: 'bad_request' }, 400);
    return J(auditList(st, sp));
  }
  if (p === '/api/admin/audit/filters') return J({ actors: [{ id: 'u1', name: AUDIT_ACTOR }], system: st.audit.some((e) => e.actor === null), categories: [...new Set(st.audit.map((e) => e.action.split('.')[0]!))].sort() });

  // ---- content ----
  if (p === '/api/admin/requests') {
    if (!st.seerrUp) return J({ error: 'seerr_unreachable' }, 502);
    const all = st.requests.filter(reqFilter[sp.get('filter') ?? 'pending'] ?? reqFilter.pending!);
    const skip = Number(sp.get('skip') ?? 0), take = Number(sp.get('take') ?? 50);
    return J({ requests: all.slice(skip, skip + take).map((r) => ({ ...r, statusKey: STATE_KEY[r.status] ?? 'unknown' })), total: all.length });
  }
  if ((mm = p.match(/^\/api\/admin\/requests\/(\d+)\/(approve|decline)$/)) && m === 'POST') {
    const r = st.requests.find((x) => x.id === Number(mm![1]));
    if (!r) return J({ error: 'not_found' }, 404);
    r.status = mm[2] === 'approve' ? 'genehmigt' : 'abgelehnt';
    log(`request.${mm[2]}`, String(r.id));
    return ok();
  }
  if (p === '/api/admin/polls') return J({ polls: st.polls });
  if ((mm = p.match(/^\/api\/admin\/polls\/([^/]+)\/(approve|reject)$/)) && m === 'POST') { st.polls = st.polls.filter((x) => x.id !== mm![1]); log(`poll.${mm[2]}`, mm[1]!); return ok(); }
  if (p === '/api/admin/lists') {
    const q = (sp.get('q') ?? '').toLowerCase();
    const hit = st.lists.filter((l) => (!q || l.name.toLowerCase().includes(q) || l.owner.name.toLowerCase().includes(q)) && (sp.get('featured') === null || l.featured === (sp.get('featured') === '1')));
    const off = Number(sp.get('offset') ?? 0), lim = Number(sp.get('limit') ?? 200);
    return J({ lists: hit.slice(off, off + lim), total: hit.length, featuredCount: st.lists.filter((l) => l.featured).length, max: 5 });
  }
  if ((mm = p.match(/^\/api\/admin\/lists\/([^/]+)\/featured$/)) && m === 'PUT') {
    const l = st.lists.find((x) => x.id === mm![1]);
    if (!l) return J({ error: 'not_found' }, 404);
    l.featured = Boolean(body.featured);
    return J({ ok: true, featured: l.featured });
  }
  if (p === '/api/admin/hubs' && m === 'GET') return J({ max: 8, hubs: st.hubs });
  if (p === '/api/admin/hubs' && m === 'POST') { const h = { id: 'h' + (st.hubs.length + 1), ...body }; st.hubs.push(h); return J({ hub: h }); }
  if (p === '/api/admin/hubs/order' && m === 'PUT') { st.hubs = (body.ids as string[]).map((id) => st.hubs.find((h) => h.id === id)!).filter(Boolean); return ok(); }
  if (p === '/api/admin/hubs/suggestions') return J({ suggestions: ['Action', 'Drama', 'Krimi', 'Sci-Fi', 'Aster 9', 'Wardell'].map((n, i) => ({ name: n, count: 10 + i, source: i < 4 ? 'genre' : 'studio', sourceValue: n, used: false })) });
  if ((mm = p.match(/^\/api\/admin\/hubs\/([^/]+)$/))) {
    if (m === 'DELETE') { st.hubs = st.hubs.filter((h) => h.id !== mm![1]); return ok(); }
    if (m === 'PUT') { const h = st.hubs.find((x) => x.id === mm![1]); if (h) Object.assign(h, body); return J({ hub: h }); }
  }
  if (p === '/api/admin/previews' && m === 'GET') {
    const rows = st.previews;
    const n = (x: string) => rows.filter((r) => r.status === x).length;
    const summary = { total: rows.length, ok: n('ok'), failed: n('failed'), missing: n('missing'), preparing: n('preparing'), totalBytes: rows.reduce((a, r) => a + (r.bytes ?? 0), 0) };
    const ORDER = { failed: 0, preparing: 1, missing: 2, ok: 3 };
    if (!sp.has('limit') && !sp.has('ids') && !sp.has('status') && !sp.has('q')) return J({ summary, items: [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status]) });
    let list = rows;
    if (sp.has('ids')) { const want = new Set((sp.get('ids') ?? '').split(',').filter(Boolean)); list = list.filter((r) => want.has(r.itemId)); }
    if (sp.get('status')) list = list.filter((r) => r.status === sp.get('status'));
    if (sp.get('q')) list = list.filter((r) => r.name.toLowerCase().includes(sp.get('q')!.toLowerCase()));
    const sign = sp.get('dir') === 'desc' ? -1 : 1, key = sp.get('sort') ?? 'status';
    list = [...list].sort((a, b) => key === 'name' ? sign * a.name.localeCompare(b.name, 'de', { numeric: true }) : key === 'size' ? sign * ((a.bytes ?? -1) - (b.bytes ?? -1)) : sign * (ORDER[a.status] - ORDER[b.status]) || a.name.localeCompare(b.name, 'de', { numeric: true }));
    const off = Number(sp.get('offset') ?? 0), lim = sp.has('limit') ? Number(sp.get('limit')) : undefined;
    return J({ summary, items: list.slice(off, lim === undefined ? undefined : off + lim), total: list.length });
  }
  if ((mm = p.match(/^\/api\/admin\/previews\/([0-9a-z]+)$/)) && m === 'DELETE') {
    const r = st.previews.find((x) => x.itemId === mm![1]);
    if (r) Object.assign(r, { status: 'missing', bytes: null, audioLang: null, error: null });
    return ok();
  }
  if (p === '/api/admin/previews/regenerate' && m === 'POST') {
    const r = st.previews.find((x) => x.itemId === body.itemId);
    if (r) Object.assign(r, { status: 'preparing', error: null });
    return ok();
  }
  if (p === '/api/admin/previews/regenerate-failed' && m === 'POST') {
    const failed = st.previews.filter((x) => x.status === 'failed');
    failed.forEach((x) => Object.assign(x, { status: 'preparing', error: null }));
    return J({ ok: true, count: failed.length });
  }
  if (p === '/api/admin/live' && m === 'GET') return J({ sessions: st.live });
  if (p === '/api/admin/live/stop' && m === 'POST') {
    const i = st.live.findIndex((l) => l.userId === body.userId && l.playSessionId === body.playSessionId);
    if (i < 0) return J({ error: 'not_found' }, 404);
    st.live.splice(i, 1);
    log('live.stop', body.userId);
    return ok();
  }

  // ---- operations ----
  if (p === '/api/admin/health' && m === 'GET') {
    st.healthCalls.push(sp.get('refresh') === '1' ? '?refresh=1' : '');
    if (sp.get('refresh') === '1' && st.healthRefreshed) { st.health = st.healthRefreshed; st.healthRefreshed = null; }
    return J(st.health);
  }
  if (p === '/api/admin/health/login' && m === 'GET') return J(st.loginCheck);
  if (p === '/api/admin/authentik/repair' && m === 'POST') {
    st.repairs.push(body ?? {});
    const reply = st.repairReply ?? { ok: true, steps: [{ id: 'check', state: 'ok' }, { id: 'serviceAccount', state: 'ok' }, { id: 'extraFlows', state: 'ok' }, { id: 'readback', state: 'ok' }], tokenSaved: true, check: loginCheckOk() };
    if (reply.check) st.loginCheck = reply.check;
    return J(reply);
  }
  if (p === '/api/admin/streams' && m === 'GET') return J(st.streams);
  if (p === '/api/admin/health/banner' && m === 'GET') {
    st.bannerCalls++;
    if (st.bannerFails) return J({ error: 'boom' }, 500);
    const issues = st.bannerIssues.filter((i) => st.dismissed[i.id] !== i.fp).sort((a, b) => (a.level === b.level ? a.id.localeCompare(b.id) : a.level === 'err' ? -1 : 1));
    return J({ issues, worst: issues.some((i) => i.level === 'err') ? 'err' : issues.length ? 'warn' : 'ok' });
  }
  if (p === '/api/admin/usage' && m === 'GET') {
    st.usageCalls.push(sp.toString());
    const days = Number(sp.get('days') ?? 30);
    if (![7, 30, 90].includes(days)) return J({ error: 'bad_request' }, 400);
    return J({ users: usageRows(st, days), since: st.usageSince });
  }
  if ((mm = p.match(/^\/api\/admin\/usage\/([^/]+)$/)) && m === 'GET') {
    st.usageDetailCalls.push(mm[1]!);
    if (!st.users.some((u) => u.id === mm![1])) return J({ error: 'not_found' }, 404);
    return J(usageDetail(mm[1]!, Number(sp.get('days') ?? 30)));
  }
  if (p === '/api/admin/hygiene/summary' && m === 'GET') return J(hygieneSummary(st.hygiene));
  if (p === '/api/admin/hygiene' && m === 'GET') return J(hygieneList(st.hygiene, sp));
  if (p === '/api/admin/hygiene/ignore' && (m === 'POST' || m === 'DELETE')) {
    const r = st.hygiene.items.find((x) => x.itemId === body.itemId);
    if (!r || !(body.code in HYG_CAT)) return J({ error: 'bad_request' }, 400);
    if (m === 'POST') st.hygiene.ignored.add(`${r.itemId}|${body.code}`); else st.hygiene.ignored.delete(`${r.itemId}|${body.code}`);
    log(m === 'POST' ? 'hygiene.ignore' : 'hygiene.unignore', r.itemId, { code: body.code });
    return ok();
  }
  if ((mm = p.match(/^\/api\/admin\/hygiene\/([\w-]+)\/refresh$/)) && m === 'POST') {
    if (!st.hygiene.canRefresh) return J({ error: 'unsupported' }, 501);
    st.hygiene.refreshed.push(mm[1]!);
    return ok();
  }
  if (p === '/api/admin/hygiene/scan' && m === 'POST') {
    st.hygiene.scans++;
    if (st.hygiene.running) return J({ started: false });
    st.hygiene.running = true;
    return J({ started: true });
  }
  if (p === '/api/admin/health/dismiss' && m === 'POST') {
    if (!/^[a-z]+:[a-zA-Z]+$/.test(body.id ?? '') || !/^[0-9a-f]{12}$/.test(body.fp ?? '')) return J({ error: 'bad_request' }, 400);
    st.dismissed[body.id] = body.fp;
    return ok();
  }
  if (p === '/api/admin/errors' && m === 'GET') return J(st.errors);
  if (p === '/api/admin/playback/timing' && m === 'GET') {
    // start-time measurements: remote phones load 6 s segments (the long-segment hint), the first fragment is the biggest step
    const pct = (p50: number | null, p90 = p50) => ({ p50, p90 });
    const g = (home: boolean, device: string | null, n: number, frag: number, td: number | null) => ({
      home, device, n, switches: home ? 0 : 1, total: pct(400 + 300 + frag + 200, 2 * (900 + frag)), targetDuration: td, seekP50: 800, stallsPerSession: home ? 0 : 0.5, stallMsPerSession: home ? 0 : 1200,
      phases: { info: pct(400, 900), manifest: pct(300, 600), firstFrag: pct(frag, frag * 2), firstFrame: pct(200, 400) },
    });
    const day = [g(true, null, 4, 600, 3), g(true, 'pc', 4, 600, 3), g(false, null, 3, 4200, 6), g(false, 'phone', 3, 4200, 6)];
    const row = (i: number, home: boolean, device: string, frame: number) => ({
      at: ago(i * 10), home, device, mode: 'hls', qualitySwitch: i === 2, bitrate: 8e6, targetDuration: home ? 3 : 6, infoMs: 400, manifestMs: 700, firstFragMs: frame - 200,
      firstFragBytes: 4_200_000, firstFragDlMs: frame - 1000, firstFrameMs: frame, seeks: 1, seekMedianMs: 800, seekMaxMs: 800, stalls: home ? 0 : 1, stallMs: home ? 0 : 2400, effectiveType: null,
      // A/V-sync facts: the newest row has them, the oldest is from a player before they existed
      ...(i === 1 ? { delivery: 'remux', videoCopy: true, soundMode: 'night', audioRouted: true, droppedFrames: 12, totalFrames: 14_400, trackSwitch: true, reconnects: 1, avEvents: 3 } : {}),
      ...(i === 2 ? { delivery: 'transcode', videoCopy: false, soundMode: 'off', audioRouted: false, droppedFrames: 0, totalFrames: 9000, trackSwitch: false, reconnects: 0, avEvents: 2 } : {}),
    });
    return J({ day, week: day, recent: [row(1, false, 'phone', 5600), row(2, false, 'phone', 3100), row(3, true, 'pc', 1500)] });
  }
  if (p === '/api/admin/conversions' && m === 'GET') {
    const { posts: _p, benchAnswer: _b, ...v } = st.conv;
    return J({ ...v, used: v.running.length });
  }
  if (p === '/api/admin/conversions/benchmark' && m === 'POST') {
    st.conv.posts++;
    if (st.conv.benchAnswer) return J(st.conv.benchAnswer.body, st.conv.benchAnswer.status);
    st.conv.measure = { ...st.conv.measure, running: true };
    return J({ started: true }, 202);
  }
  if (p === '/api/admin/playback-check') {
    if (m === 'POST') return ok();
    return J({ running: false, done: 6, total: 6, startedAt: ago(3), finishedAt: ago(2), results: [{ itemId: 'a'.repeat(32), name: 'Kaputter Film', type: 'Movie', ok: false, status: 500, ms: 900, bytes: 0, error: 'HTTP 500 transcoder failed' }, ...Array.from({ length: 5 }, (_, i) => ({ itemId: String(i).repeat(32), name: 'Film ' + i, type: 'Movie', ok: true, status: 200, ms: 800 + i * 90, bytes: 1, error: null }))] });
  }
  if ((mm = p.match(/^\/api\/admin\/downloads\/([^/]+)$/)) && m === 'DELETE') { st.revokedLicences.push(mm[1]!); log('download.revoke', mm[1]!); return ok(); }
  if (p === '/api/admin/downloads') return J({ enabled: true, maxBytes: 50 * 1024 ** 3, diskBytes: 12.4 * 1024 ** 3, jobCounts: { ready: 3, preparing: 1 }, jobs: [{ id: auid(400), item_id: 'abcdef0123456789abcdef0123456789', title: 'Inkwell', series_name: null, quality: 'hd', audio_lang: 'deu', status: 'preparing', seg_done: 40, seg_total: 100, bytes: 1e9, error: null, created_at: ago(2), updated_at: ago(1), licenses: 2 }], licenses: [{ id: auid(401), user_name: 'Anna', device_label: 'iPhone', item_id: 'x', title: 'Inkwell', series_name: null, quality: 'hd', status: 'fetched', created_at: ago(30), expires_at: fut(500) }] });
  if ((mm = p.match(/^\/api\/admin\/downloads\/([^/]+)$/)) && m === 'DELETE') return ok();
  if (p === '/api/admin/digest') {
    if (m === 'PUT') return J({ enabled: body.enabled, day: body.day, hour: body.hour, source: 'admin', lastRun: null });
    return J({ enabled: true, day: 5, hour: 18, source: 'admin', lastRun: { week: '2026-W40', sentAt: ago(100), count: 9 } });
  }
  if (p === '/api/admin/digest/test' && m === 'POST') return J({ sent: 1 });
  if (p === '/api/admin/sources' && m === 'GET') return J({ sources: st.sources });
  if ((mm = p.match(/^\/api\/admin\/sources\/(tmdb|omdb)(\/test)?$/))) {
    const src = st.sources.find((x) => x.name === mm![1])!;
    if (mm[2]) {
      if (m !== 'POST') return null;
      if (!body?.key && !src.set) return J({ ok: false, error: 'not_set' });
      return J(body?.key?.includes('bad') || (!body?.key && src.invalid) ? { ok: false, error: 'invalid_key' } : { ok: true });
    }
    if (m === 'GET') return J(src);
    if (src.from === 'file') return J({ error: 'from_file' }, 409);
    if (m === 'PUT' && String(body.key).includes('boom')) return J({ error: 'server' }, 500);
    if (m === 'PUT' && (String(body.key).length < 8 || /\s/.test(String(body.key)))) return J({ error: 'invalid' }, 400);
    if (m === 'PUT') { Object.assign(src, { set: true, last4: String(body.key).slice(-4), from: 'db', invalid: false }); log('source.set', null, { name: src.name }); return J(src); }
    if (m === 'DELETE') { Object.assign(src, { set: false, last4: null, from: null, invalid: false }); log('source.remove', null, { name: src.name }); return J(src); }
  }
  if (p === '/api/admin/leaving' && m === 'GET') return J({ items: [...st.leaving].sort((a, b) => a.leavesAt.localeCompare(b.leavesAt)) });
  if ((mm = p.match(/^\/api\/admin\/leaving\/([0-9a-f]{32})$/))) {
    const id = mm[1]!;
    if (m === 'DELETE') { st.leaving = st.leaving.filter((r) => r.itemId !== id); log('leaving.clear', id); return ok(); }
    if (m === 'PUT') {
      if (body.leavesAt < leaveDay(0)) return J({ error: 'date_out_of_range' }, 400);
      const days = Math.round((new Date(body.leavesAt + 'T00:00').getTime() - new Date(leaveDay(0) + 'T00:00').getTime()) / 864e5);
      st.leaving = [...st.leaving.filter((r) => r.itemId !== id), { ...leavingRow(id, days, body.note ?? null), leavesAt: body.leavesAt }];
      log('leaving.set', id, { leavesAt: body.leavesAt });
      return J({ itemId: id, leavesAt: body.leavesAt, note: body.note ?? null });
    }
  }
  if (p === '/api/admin/update') {
    const UPDATE_RELEASE = {
      updateAvailable: true,
      release: { version: '1.1.0', codename: 'Arancini', tag: 'v1.1.0', name: 'v1.1.0 Arancini', url: 'https://example.org/releases/v1.1.0', publishedAt: ago(5), notes: '### Streaming\n- **Adaptive quality** for every <kbd>connection</kbd>\n- <img src=x onerror="window.__xss=1">Night mode\n\nThanks!' },
    };
    if (m === 'POST') return J({ ok: true, mode: 'webhook' }, 202);
    return J({ ...UPDATE_RELEASE, current: { sha: 'c0be6c5deadbeef', builtAt: ago(70), version: '1.0.0', codename: 'Arancini' }, latest: { sha: 'ff00aa1deadbeef', date: ago(5), runUrl: 'https://example.org/run' }, behind: 3, portainer: { configured: true, mode: 'webhook' }, autoUpdateNote: true, commits: [{ sha: 'ff00aa1', url: 'https://example.org/c/1', message: 'feat(wishes): local request-service users', author: 'Manu', date: ago(5) }, { sha: 'ee11bb2', url: 'https://example.org/c/2', message: 'ci: signing', author: 'Manu', date: ago(9) }] });
  }
  return null;
}


// ---- Sicht prüfen: GET /rights?profile=, GET/POST /check (backend userRights.ts, viewcheck.ts; spec §4.2, §6.4) ----
const KIDS_OFF_MOCK = ['requests', 'party', 'partySchedule', 'comments', 'liveRecord'];
/** the library totals of the mocked media server and what a profile sees of them under each age cap (null = no cap) */
const VIEW_TOTALS: Record<string, { total: number; seen: Record<string, number> }> = {
  Filme: { total: 1204, seen: { none: 1204, '12': 812, '6': 212, '0': 40 } },
  Serien: { total: 340, seen: { none: 340, '12': 301, '6': 61, '0': 9 } },
  Musik: { total: 80, seen: { none: 80, '12': 80, '6': 80, '0': 80 } },
};
/** the searchable titles: age is null for an unrated one */
const VIEW_TITLES = [
  { id: '0000000000000000000000000000d001', name: 'Dunmoor', year: 2021, type: 'Movie', rating: 'FSK-16', age: 16, library: 'Filme' },
  { id: '0000000000000000000000000000d002', name: 'Dunmoor Origins', year: 2014, type: 'Movie', rating: null, age: null, library: 'Filme' },
  { id: '0000000000000000000000000000d003', name: 'Saltwater Almanac', year: 2019, type: 'Series', rating: 'FSK-6', age: 6, library: 'Serien' },
  // ten matches for "Harbour": the answer stops at CHECK_HITS
  ...Array.from({ length: 10 }, (_, i) => ({ id: `00000000000000000000000000000e${String(i).padStart(2, '0')}`, name: `Quiet Harbour ${i + 1}`, year: 2010 + i, type: 'Movie', rating: 'FSK-0', age: 0, library: 'Filme' })),
];
/** the most hits a title check answers with (backend viewcheck.ts) */
const CHECK_HITS = 8;
/** a profile id the route's zod schema takes (a uuid; the mock's profile ids end in `p001`, so letters count as well); anything else is 400 before a lookup */
const pidOk = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/.test(v);
const profileOf = (st: AdminState, u: AdminUser, pid: string | null | undefined) => (pid ? profilesOf(st, u).find((p) => p.id === pid) : undefined);
const kidsCap = (p: DetailProfile): number | null => (p.kids ? (p.maxRating ?? 12) : null);
/** one Rechte row of the account (backend userRights.ts rightsView): effective value, the role's, the stored override and the deciding layer */
function rightsRow(role: MatrixMockRole, u: AdminUser, k: string) {
  const perm = PERM_KEYS_MOCK.includes(k);
  if (perm && u.role === 'admin') return { key: k, value: true as unknown, roleValue: true as unknown, override: null as unknown, source: 'admin' };
  const roleValue = role.values[k];
  const override = perm ? u.perms?.[k] ?? null : u.ov?.[k] ?? null;
  return { key: k, value: (override === null ? roleValue : override === 'unlimited' ? null : override) as unknown, roleValue, override: override as unknown, source: override === null ? role.sources[k] ?? 'default' : 'user' };
}
/**
 * The write of PUT /rights and of the bulk `perm` (backend userRights.writeRights): partial (null = back to the role), a value equal to the
 * role's is not stored. One `user.rights` entry `{ from, to, layer?, stored?, note? }`: `from`/`to` for every key whose effective value or
 * deciding layer changed, `layer` for the keys that only moved between layers, `stored` for a switch cleared on an admin account (it
 * decides nothing). Returns the changed keys (value or layer), as the backend's `changed`.
 */
function writeRightsMock(role: MatrixMockRole, u: AdminUser, o: Record<string, unknown>, note: string | null | undefined, log: (a: string, t: string | null, meta?: Record<string, unknown>, n?: string | null) => void): { changed: string[] } {
  const keys = MATRIX_FIELDS_MOCK.map((f) => f.key as string);
  const before = Object.fromEntries(keys.map((k) => [k, rightsRow(role, u, k)]));
  const store = (k: string, v: unknown) => {
    const perm = PERM_KEYS_MOCK.includes(k), target = perm ? (u.perms ??= {}) : (u.ov ??= {}) as Record<string, unknown>;
    const eff = v === 'unlimited' ? null : v;
    const lc = (x: unknown) => (Array.isArray(x) ? JSON.stringify([...new Set(x.map((n) => String(n).toLowerCase()))].sort()) : JSON.stringify(x));
    if (v === null || lc(eff) === lc(role.values[k])) delete target[k]; else target[k] = v;
  };
  const stored: Record<string, { from: unknown; to: unknown }> = {};
  if (u.role === 'admin') for (const k of PERM_KEYS_MOCK) if (o[k] === null && u.perms?.[k] !== undefined) stored[k] = { from: u.perms[k], to: null };
  for (const [k, v] of Object.entries(o)) if (v !== undefined) store(k, v);
  if (u.perms && !Object.keys(u.perms).length) delete u.perms;
  u.otherOverrides = Object.keys(u.ov ?? {}).length;
  const noteWas = u.note ?? null;
  if (note !== undefined) u.note = note === null || note.trim() === '' ? null : note.trim();
  const from: Record<string, unknown> = {}, to: Record<string, unknown> = {}, layer: Record<string, { from: string; to: string }> = {};
  for (const k of keys) {
    const a = before[k]!, b = rightsRow(role, u, k);
    if (JSON.stringify(a.value) !== JSON.stringify(b.value)) { from[k] = a.value; to[k] = b.value; }
    else if (a.source !== b.source) { from[k] = a.value; to[k] = b.value; layer[k] = { from: a.source, to: b.source }; }
  }
  const noteChanged = (u.note ?? null) !== noteWas;
  if (Object.keys(to).length || noteChanged || Object.keys(stored).length) {
    log('user.rights', u.id, { from, to, ...(Object.keys(layer).length ? { layer } : {}), ...(Object.keys(stored).length ? { stored } : {}), ...(noteChanged ? { note: 'changed' } : {}) }, u.name);
  }
  return { changed: Object.keys(to) };
}
/** the effective rows of the account with the kids overlay of the profile (kids cap, KIDS_OFF switched off) */
function viewRows(st: AdminState, u: AdminUser, p: DetailProfile) {
  const role = st.matrix.roles.find((r) => r.key === u.role)!;
  const kc = kidsCap(p);
  return MATRIX_FIELDS_MOCK.map((f) => {
    const k = f.key as string, perm = PERM_KEYS_MOCK.includes(k);
    const roleValue = role.values[k];
    const override = u.role === 'admin' && perm ? null : (perm ? u.perms?.[k] : u.ov?.[k]) ?? null;
    let value = override === null ? roleValue : override === 'unlimited' ? null : override, source: string = override === null ? role.sources[k] ?? 'default' : 'user';
    // backend rights.ts: the kids cap, or the account's lower one
    if (kc !== null && k === 'maxParentalRating') { const eff = value === null ? kc : Math.min(value as number, kc); if (eff !== value) { value = eff; source = 'kids'; } }
    if (kc !== null && KIDS_OFF_MOCK.includes(k)) { value = false; source = 'kids'; }
    return { key: k, value, roleValue, override, source };
  });
}
function viewRights(st: AdminState, u: AdminUser, pid: string, J: Reply): Promise<void> {
  if (!pidOk(pid)) return J({ error: 'bad_request' }, 400);
  const p = profileOf(st, u, pid);
  if (!p) return J({ error: 'not_found' }, 404);
  return J({ role: u.role, note: u.note ?? null, rows: viewRows(st, u, p), profile: { id: p.id, name: p.name, kids: p.kids, maxRating: kidsCap(p) }, hardKids: p.kids ? KIDS_OFF_MOCK : [], missingLibraries: [], livetvGroups: ltvExceptionsOf(st.livetv.area, u.id) });
}
function viewCheck(st: AdminState, u: AdminUser, m: string, body: any, J: Reply, log: (a: string, t: string | null, meta?: Record<string, unknown>, n?: string | null) => void): Promise<void> {
  // the route's rate limit runs first: 30 a minute (fastify's 429 answer)
  const now = Date.now();
  st.checkTimes = st.checkTimes.filter((t) => t > now - 60_000);
  if (st.checkTimes.length >= 30) return J({ statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' }, 429);
  st.checkTimes.push(now);
  // then the schema (a missing or malformed profile id is 400), then the lookup (404)
  const pid = m === 'GET' ? body.profileId : body?.profileId;
  if (!pidOk(pid)) return J({ error: 'bad_request' }, 400);
  const p = profileOf(st, u, pid);
  if (!p) return J({ error: 'not_found' }, 404);
  const rows = viewRows(st, u, p);
  const val = (k: string) => rows.find((r) => r.key === k)!.value;
  const shared = (lib: string) => val('libraries') === 'all' || (val('libraries') as string[]).some((n) => n.toLowerCase() === lib.toLowerCase());
  const cap = val('maxParentalRating') as number | null;
  if (m === 'GET') {
    log('user.check_viewed', u.id, { profile: p.id, libraries: st.matrix.libraries.length }, u.name);
    return J({ libraries: st.matrix.libraries.map((l) => {
      const t = VIEW_TOTALS[l.name] ?? { total: 10, seen: { none: 10, '12': 10, '6': 10, '0': 10 } }, vis = shared(l.name);
      return { id: l.id, name: l.name, visible: vis, seen: vis ? t.seen[cap === null ? 'none' : String(cap)] ?? t.total : null, total: t.total };
    }), livetv: ltvCheckMock(st, u, p) });
  }
  // exactly one of query (2-100 characters) and itemId (32 hex)
  const q = typeof body.query === 'string' ? body.query.trim() : undefined, id = body.itemId;
  if ((q === undefined) === (id === undefined) || (q !== undefined && (q.length < 2 || q.length > 100)) || (id !== undefined && !/^[0-9a-f]{32}$/.test(String(id)))) return J({ error: 'bad_request' }, 400);
  const found = VIEW_TITLES.filter((t) => (q !== undefined ? t.name.toLowerCase().includes(q.toLowerCase()) : t.id === id));
  const hits = found.slice(0, CHECK_HITS).map((t) => {
    const why = !shared(t.library) ? 'library' : t.age !== null && cap !== null && t.age > cap ? 'rating' : t.age === null && p.kids ? 'unrated_kids'
      : t.age === null && cap !== null && st.checkHidesUnrated ? 'unrated' : null;
    return { id: t.id, name: t.name, year: t.year, type: t.type, visible: why === null, why, rating: t.rating, library: t.library };
  });
  log('user.check_viewed', u.id, { profile: p.id, hits: hits.length }, u.name);
  return J({ hits });
}
