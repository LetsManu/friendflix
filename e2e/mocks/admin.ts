/**
 * Admin API fixtures for the mocked FriendFlix backend (shapes follow backend/src/routes/admin.ts, seerr.ts, polls.ts,
 * hubs.ts, digest.ts). Stateful: mutations change the state, so specs can assert what the UI did.
 * Wired into installApi (mocks/api.ts); switch the session to an admin with `api.asAdmin = true` before page.goto().
 */

const NOW = Date.now();
const ago = (h: number): string => new Date(NOW - h * 3600e3).toISOString();
const fut = (h: number): string => new Date(NOW + h * 3600e3).toISOString();
/** uuid-shaped ids (the backend validates uuids for users/devices) */
export const auid = (n: number): string => `00000000-0000-4000-a000-${n.toString().padStart(12, '0')}`;

export interface AdminUser { id: string; name: string; email: string | null; role: string; disabled: boolean; jellyfin_username: string; seerr_user_id: number | null; created_at: string; last_seen: string | null }
export interface AdminDevice { user_id: string; device_id: string; label: string; approved: boolean; last_seen: string; name: string }
export interface AdminRequest { id: number; title: string; mediaType: 'movie' | 'tv'; requestedBy: string; status: string; createdAt: string }
export interface AdminInvite { id: string; role: string; note: string | null; expires_at: string; used_at: string | null; used_by_name: string | null }
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
  audit: AuditRow[];
  polls: Array<{ id: string; title: string; creator: string; winnerOptionId: string; options: Array<{ id: string; title: string }> }>;
  lists: Array<{ id: string; name: string; owner: { id: string; name: string }; itemCount: number; featured: boolean }>;
  hubs: Array<{ id: string; name: string; source: string; sourceValue: string; accent?: string | null; imageItemId?: string | null; enabled: boolean }>;
  /** Seerr reachable (summary.services.seerr, request counts) */
  seerrUp: boolean;
  /** make GET /api/admin/summary fail (500) */
  summaryFails: boolean;
}

export function adminState(): AdminState {
  const users: AdminUser[] = [
    { id: 'u1', name: 'Tester', email: 'tester@example.org', role: 'admin', disabled: false, jellyfin_username: 'tester', seerr_user_id: 1, created_at: ago(24 * 400), last_seen: ago(0.1) },
    ...NAMES.map((n, i) => ({ id: auid(i + 2), name: n, email: i % 3 === 2 ? null : `${n.split(' ')[0]!.toLowerCase()}@example.org`, role: ['friend', 'family', 'guest', 'friend'][i % 4]!, disabled: i === 4, jellyfin_username: n.split(' ')[0]!.toLowerCase(), seerr_user_id: null, created_at: ago(24 * (i + 3)), last_seen: ago(i * 7) })),
  ];
  return {
    users,
    devices: Array.from({ length: 8 }, (_, i) => ({ user_id: auid(i + 2), device_id: `dev-${i}-0123456789ab`, label: ['Chrome auf Windows', 'Safari auf iPhone', 'LG webOS TV', 'Firefox auf Linux'][i % 4]!, approved: i > 3, last_seen: ago(i * 11 + 1), name: NAMES[i]! })),
    requests: [
      { id: 101, title: 'Dune: Part Two', mediaType: 'movie', requestedBy: 'Anna Beispiel', status: 'angefragt', createdAt: ago(3) },
      { id: 102, title: 'Severance', mediaType: 'tv', requestedBy: 'Ben Test', status: 'angefragt', createdAt: ago(9) },
      { id: 103, title: 'Past Lives', mediaType: 'movie', requestedBy: 'Clara Fischer', status: 'angefragt', createdAt: ago(20) },
      { id: 104, title: 'Shōgun', mediaType: 'tv', requestedBy: 'David Müller', status: 'angefragt', createdAt: ago(30) },
      { id: 105, title: 'The Bear', mediaType: 'tv', requestedBy: 'Clara Fischer', status: 'genehmigt', createdAt: ago(50) },
      { id: 106, title: 'Perfect Days', mediaType: 'movie', requestedBy: 'Emma Schneider', status: 'verfügbar', createdAt: ago(90) },
    ],
    invites: [
      { id: auid(201), role: 'friend', note: 'Für Annas Bruder', expires_at: fut(30), used_at: null, used_by_name: null },
      { id: auid(202), role: 'guest', note: null, expires_at: ago(5), used_at: null, used_by_name: null },
      { id: auid(203), role: 'family', note: 'Oma', expires_at: fut(2), used_at: ago(1), used_by_name: 'Oma Inge' },
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
    polls: [{ id: 'p1', title: 'Filmabend Freitag', creator: 'Anna Beispiel', winnerOptionId: 'o2', options: [{ id: 'o1', title: 'Heat' }, { id: 'o2', title: 'Dune: Part Two' }] }],
    lists: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Filmabend', owner: { id: auid(2), name: 'Anna' }, itemCount: 12, featured: true },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Annas Klassiker', owner: { id: auid(3), name: 'Ben' }, itemCount: 4, featured: false },
    ],
    hubs: [
      { id: 'h1', name: 'Marvel', source: 'studio', sourceValue: 'Marvel Studios', enabled: true },
      { id: 'h2', name: 'Pixar', source: 'studio', sourceValue: 'Pixar', accent: '#3a7bd5', enabled: false },
    ],
    seerrUp: true,
    summaryFails: false,
  };
}

const PENDING = 'angefragt';
const reqFilter: Record<string, (r: AdminRequest) => boolean> = {
  pending: (r) => r.status === PENDING, approved: (r) => r.status === 'genehmigt', processing: (r) => r.status === 'in Arbeit', available: (r) => r.status === 'verfügbar', all: () => true,
};

export function adminSummary(st: AdminState) {
  const pendingReq = st.requests.filter((r) => r.status === PENDING).length;
  const locked = st.users.filter((u) => u.disabled).length;
  return {
    users: { total: st.users.length, active: st.users.length - locked, locked },
    pending: { requests: st.seerrUp ? pendingReq : null, devices: st.devices.filter((d) => !d.approved).length, polls: st.polls.length, invites: st.invites.filter((i) => !i.used_at && i.expires_at > new Date().toISOString()).length, previewsFailed: 10 },
    requests: st.seerrUp ? { pending: pendingReq, approved: st.requests.filter((r) => r.status === 'genehmigt').length, processing: 1, available: st.requests.filter((r) => r.status === 'verfügbar').length, declined: 2, total: st.requests.length + 3 } : null,
    storage: { downloadsEnabled: true, downloadsBytes: 12.4 * 1024 ** 3, downloadsMaxBytes: 50 * 1024 ** 3, previewBytes: 99e6, previewClips: 30 },
    playbackCheck: { finishedAt: ago(2), total: 20, failed: 1 },
    services: { jellyfin: true, seerr: st.seerrUp },
    live: { streams: 2, partyRooms: 1 },
  };
}

const previewItems = Array.from({ length: 60 }, (_, i) => ({ itemId: 'it' + i, name: 'Titel Nummer ' + i, type: i % 3 ? 'Movie' : 'Series', status: (['ok', 'ok', 'ok', 'failed', 'missing', 'preparing'] as const)[i % 6], bytes: i % 6 < 3 ? 3_400_000 + i * 1000 : null, audioLang: i % 6 < 3 ? 'deu' : null, error: i % 6 === 3 ? 'ffmpeg exited with code 1' : null, createdAt: ago(i) }));

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

  if (p === '/api/admin/summary') return st.summaryFails ? J({ error: 'boom' }, 500) : J(adminSummary(st));
  if (p === '/api/admin/status') {
    const s = adminSummary(st);
    return J({ users: s.users.active, pendingDevices: s.pending.devices, openInvites: s.pending.invites, pendingPolls: s.pending.polls, activeStreams: 2, partyRooms: 1, jellyfin: true });
  }

  // ---- people ----
  if (p === '/api/admin/users') return J({ users: st.users });
  if ((mm = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && m === 'PATCH') {
    const u = st.users.find((x) => x.id === mm![1]);
    if (!u) return J({ error: 'not_found' }, 404);
    if (u.id === 'u1' && (body.disabled || (body.role && body.role !== 'admin'))) return J({ error: 'cannot_lock_yourself_out' }, 400);
    if (body.role && body.role !== u.role) { log('user.role', u.id, { from: u.role, to: body.role }, u.name); u.role = body.role; }
    if (typeof body.disabled === 'boolean' && body.disabled !== u.disabled) { u.disabled = body.disabled; log(body.disabled ? 'user.disable' : 'user.enable', u.id, {}, u.name); }
    return ok();
  }
  if ((mm = p.match(/^\/api\/admin\/users\/([^/]+)\/revoke-sessions$/)) && m === 'POST') return J({ revoked: 2 });
  if (p === '/api/admin/roles' && m === 'GET') {
    return J({ roles: ROLES, invitable: ['friend', 'family', 'guest'], limits: Object.entries(ROLES).map(([role, r], i) => ({ role, label: r.label, builtinLabel: true, requestsPerMonth: i === 0 ? null : 3, isDefault: i === 2, transcoding: i !== 3, maxHeight: i === 1 ? 1080 : null, download: i < 2, maxDownloads: 5, downloadMaxHeight: 720, downloadDays: 30 })) });
  }
  if (/^\/api\/admin\/roles\/[^/]+$/.test(p) && m === 'PUT') return ok();
  if (p === '/api/admin/devices') return J({ devices: [...st.devices].sort((a, b) => Number(a.approved) - Number(b.approved)) });
  if (p === '/api/admin/devices/approve' && m === 'POST') {
    const d = st.devices.find((x) => x.user_id === body.userId && x.device_id === body.deviceId);
    if (!d) return J({ error: 'not_found' }, 404);
    d.approved = true; log('device.approve', d.user_id, { by: 'admin' }, d.name);
    return ok();
  }
  if (p === '/api/admin/invites' && m === 'GET') return J({ invites: st.invites });
  if (p === '/api/admin/invites' && m === 'POST') {
    const id = auid(300 + st.invites.length);
    st.invites.unshift({ id, role: body.role, note: body.note ?? null, expires_at: fut(body.ttlHours ?? 48), used_at: null, used_by_name: null });
    log('invite.create', id, { role: body.role });
    return J({ id, link: `https://portal.example.com/invite/${'t'.repeat(32)}`, authentik: 'ok', expiresAt: fut(body.ttlHours ?? 48) });
  }
  if ((mm = p.match(/^\/api\/admin\/invites\/([^/]+)$/)) && m === 'DELETE') { st.invites = st.invites.filter((i) => i.id !== mm![1] || i.used_at); log('invite.revoke', mm[1]!); return ok(); }
  if (p === '/api/admin/audit') return J({ entries: st.audit.slice(0, Number(sp.get('limit') ?? 100)) });

  // ---- content ----
  if (p === '/api/admin/requests') {
    if (!st.seerrUp) return J({ error: 'seerr_unreachable' }, 502);
    return J({ requests: st.requests.filter(reqFilter[sp.get('filter') ?? 'pending'] ?? reqFilter.pending!) });
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
  if (p === '/api/admin/lists') return J({ lists: st.lists });
  if ((mm = p.match(/^\/api\/admin\/lists\/([^/]+)\/featured$/)) && m === 'PUT') {
    const l = st.lists.find((x) => x.id === mm![1]);
    if (!l) return J({ error: 'not_found' }, 404);
    l.featured = Boolean(body.featured);
    return J({ ok: true, featured: l.featured });
  }
  if (p === '/api/admin/hubs' && m === 'GET') return J({ max: 8, hubs: st.hubs });
  if (p === '/api/admin/hubs' && m === 'POST') { const h = { id: 'h' + (st.hubs.length + 1), ...body }; st.hubs.push(h); return J({ hub: h }); }
  if (p === '/api/admin/hubs/order' && m === 'PUT') { st.hubs = (body.ids as string[]).map((id) => st.hubs.find((h) => h.id === id)!).filter(Boolean); return ok(); }
  if (p === '/api/admin/hubs/suggestions') return J({ suggestions: ['Action', 'Drama', 'Krimi', 'Sci-Fi', 'A24', 'Warner'].map((n, i) => ({ name: n, count: 10 + i, source: i < 4 ? 'genre' : 'studio', sourceValue: n, used: false })) });
  if ((mm = p.match(/^\/api\/admin\/hubs\/([^/]+)$/))) {
    if (m === 'DELETE') { st.hubs = st.hubs.filter((h) => h.id !== mm![1]); return ok(); }
    if (m === 'PUT') { const h = st.hubs.find((x) => x.id === mm![1]); if (h) Object.assign(h, body); return J({ hub: h }); }
  }
  if (p === '/api/admin/previews') return J({ summary: { total: 60, ok: 30, failed: 10, missing: 10, preparing: 10, totalBytes: 99e6 }, items: previewItems });
  if (p === '/api/admin/previews/regenerate' && m === 'POST') return ok();
  if (p === '/api/admin/previews/regenerate-failed' && m === 'POST') return J({ ok: true, count: 10 });

  // ---- operations ----
  if (p === '/api/admin/playback-check') {
    if (m === 'POST') return ok();
    return J({ running: false, done: 6, total: 6, startedAt: ago(3), finishedAt: ago(2), results: [{ itemId: 'a'.repeat(32), name: 'Kaputter Film', type: 'Movie', ok: false, status: 500, ms: 900, bytes: 0, error: 'HTTP 500 transcoder failed' }, ...Array.from({ length: 5 }, (_, i) => ({ itemId: String(i).repeat(32), name: 'Film ' + i, type: 'Movie', ok: true, status: 200, ms: 800 + i * 90, bytes: 1, error: null }))] });
  }
  if (p === '/api/admin/downloads') return J({ enabled: true, maxBytes: 50 * 1024 ** 3, diskBytes: 12.4 * 1024 ** 3, jobCounts: { ready: 3, preparing: 1 }, jobs: [{ id: auid(400), item_id: 'abcdef0123456789abcdef0123456789', quality: '720p', audio_lang: 'deu', status: 'preparing', seg_done: 40, seg_total: 100, bytes: 1e9, error: null, created_at: ago(2), updated_at: ago(1), licenses: 2 }], licenses: [{ id: auid(401), user_name: 'Anna', device_label: 'iPhone', item_id: 'x', title: 'Inception', series_name: null, quality: '720p', status: 'fetched', created_at: ago(30), expires_at: fut(500) }] });
  if ((mm = p.match(/^\/api\/admin\/downloads\/([^/]+)$/)) && m === 'DELETE') return ok();
  if (p === '/api/admin/digest') {
    if (m === 'PUT') return J({ enabled: body.enabled, day: body.day, hour: body.hour, source: 'admin', lastRun: null });
    return J({ enabled: true, day: 5, hour: 18, source: 'admin', lastRun: { week: '2026-W40', sentAt: ago(100), count: 9 } });
  }
  if (p === '/api/admin/digest/test' && m === 'POST') return J({ sent: 1 });
  if (p === '/api/admin/update') {
    if (m === 'POST') return J({ ok: true, mode: 'webhook' }, 202);
    return J({ current: { sha: 'c0be6c5deadbeef', builtAt: ago(70) }, latest: { sha: 'ff00aa1deadbeef', date: ago(5), runUrl: 'https://example.org/run' }, behind: 3, portainer: { configured: true, mode: 'webhook' }, autoUpdateNote: true, commits: [{ sha: 'ff00aa1', url: 'https://example.org/c/1', message: 'feat(wishes): local request-service users', author: 'Manu', date: ago(5) }, { sha: 'ee11bb2', url: 'https://example.org/c/2', message: 'ci: signing', author: 'Manu', date: ago(9) }] });
  }
  return null;
}
