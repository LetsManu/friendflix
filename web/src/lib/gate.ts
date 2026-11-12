// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Profile gate ("Wer ist heute dabei?") and the early-render hint of the app shell.
 *
 * Accounts with more than one profile see the gate once per browser session (new tab/window = new session),
 * like the big streaming apps. The pick is remembered in sessionStorage by /profiles.
 */
import { deniedKeys, permsFrom, type PermKey, type Perms } from './perms';

/** the switched-off rights of an /api/me `perms` object */
const deniedOf = (raw: unknown): PermKey[] => deniedKeys(permsFrom(raw));
/** the same from a stored list (unknown names are dropped) */
export const deniedFromList = (list: unknown): PermKey[] => deniedOf(Array.isArray(list) ? Object.fromEntries(list.map((k) => [k, false])) : undefined);

export const PICKED_KEY = 'ff-profile-picked';
/** localStorage: flags of the last /api/me answer (no names), lets the layout render the page before /api/me returns */
export const HINT_KEY = 'ff-boot-hint';
/** sessionStorage: profile id this tab runs with (sent as x-ff-profile by early requests) */
export const ACTIVE_KEY = 'ff-active-profile';
/** sessionStorage flag lib/api.ts sets before reloading after a profile switch in another tab */
const RELOAD_KEY = 'ff_profile_reload';

export interface GateMe { profileRequired?: boolean; profileCount?: number; profileChosen?: boolean; tv?: boolean; kids?: boolean; onboarded?: boolean }
export interface BootHint {
  approved: boolean; multi: boolean; tv: boolean;
  /** single-profile accounts only: that profile never changes */ profile?: string;
  /** UI language of the last answer: an early-rendered page waits until it is active */ lang?: string;
  /** the last answer was a kids profile: only kids routes may render early */ kids?: boolean;
  /** the last answer still owed the /welcome onboarding: nothing renders early */ welcome?: boolean;
  /** the last answer had no request service (features.requests false; a person's own requests right is in noPerms): request links stay hidden until /api/me answers */ noRequests?: boolean;
  /** the rights switched off per profile id (`NO_PROFILE` = no active profile), from the last answers: their entries stay hidden until /api/me answers, so nothing jumps in later */ noPerms?: Record<string, PermKey[]>;
}

// ---- kids profiles: only a small set of routes; everything else goes to the kids home ----
/** routes a kids profile may open (the server also answers 403 kids_profile on every social API); /new shows what its endpoints return for a kids profile */
const KIDS_ALLOWED = /^\/(kids|item|watch|profiles|offline|welcome)(\/|$)|^\/(search|settings|new)\/?$/;
export const kidsAllowed = (path: string): boolean => KIDS_ALLOWED.test(path);
/** where the layout sends a kids profile instead of `path`, or null when the route is fine */
export const kidsRedirect = (me: Pick<GateMe, 'kids'> | null | undefined, path: string): string | null => (me?.kids && !kidsAllowed(path) ? '/kids' : null);

// ---- onboarding (/welcome): new profiles go through it once, after the profile and language gates ----
/** pages that never send to /welcome (the onboarding itself, the picker, public and remote pages, the setup wizard's extras) */
const NO_WELCOME = /^\/(welcome|profiles|offline|invite|tv|remote|setup)(\/|$)/;
/** true when the layout must send the profile to /welcome first (`onboarded` absent = older server = onboarded) */
export const needsWelcome = (me: Pick<GateMe, 'onboarded' | 'tv'> | null | undefined, path: string): boolean =>
  me?.onboarded === false && !me.tv && !NO_WELCOME.test(path);
/** `/welcome?next=…`; a kids profile continues on its own home */
export const welcomeHref = (pathAndSearch: string, kids = false) => `/welcome?next=${encodeURIComponent(kids && !kidsAllowed(pathAndSearch.split(/[?#]/)[0]!) ? '/kids' : pathAndSearch)}`;
/** a same-origin path from `?next=` (anything else: the fallback) */
export const safeNext = (raw: string | null | undefined, fallback = '/'): string =>
  raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : fallback;

/** paths that never show the per-session gate (the profile page itself, the phone remote control) */
const NO_SESSION_GATE = /^\/(profiles|remote)(\/|$)/;

/** true when the layout must send the user to /profiles before showing `path` */
export function needsProfileGate(me: GateMe, path: string, sessionPicked: boolean): boolean {
  if (path === '/profiles') return false;
  const multi = (me.profileCount ?? 0) > 1;
  if (me.profileRequired || (multi && !me.profileChosen)) return true; // server: no profile chosen for this login yet
  // once per browser session; televisions (paired, shared screen) and the remote control keep their profile
  return multi && !sessionPicked && !me.tv && !NO_SESSION_GATE.test(path);
}

/** `/profiles?next=…` for the current location (deep links continue after the pick) */
export const gateHref = (pathAndSearch: string) => `/profiles?next=${encodeURIComponent(pathAndSearch)}`;

/** key of the denied-rights list when no profile is active */
export const NO_PROFILE = '_';
/** the denied-rights lists of a hint with `perms` of profile `id` set (an empty list drops the entry) */
function permsMap(prev: BootHint['noPerms'], id: string | null | undefined, raw: unknown): BootHint['noPerms'] {
  const m = { ...(prev ?? {}) }, d = deniedOf(raw);
  if (d.length) m[id || NO_PROFILE] = d; else delete m[id || NO_PROFILE];
  return Object.keys(m).length ? m : undefined;
}
/** the rights the hint expects of profile `id` (all allowed when it knows nothing) */
export const hintPerms = (h: BootHint | null, id: string | null | undefined): Perms =>
  permsFrom(Object.fromEntries((h?.noPerms?.[id || NO_PROFILE] ?? []).map((k) => [k, false])));

/** `prev`: the hint written so far, so the other profiles' rights lists stay */
export function hintOf(me: GateMe & { deviceApproved?: boolean; profile?: { id: string } | null; language?: string; features?: { requests?: boolean }; perms?: unknown }, prev?: BootHint | null): BootHint {
  const multi = (me.profileCount ?? 0) > 1;
  return {
    approved: Boolean(me.deviceApproved), multi, tv: Boolean(me.tv), ...(!multi && me.profile?.id ? { profile: me.profile.id } : {}), ...(me.language ? { lang: me.language } : {}),
    ...(me.kids ? { kids: true } : {}), ...(me.onboarded === false ? { welcome: true } : {}), ...(me.features?.requests === false ? { noRequests: true } : {}), ...((n) => (n ? { noPerms: n } : {}))(permsMap(prev?.noPerms, me.profile?.id, me.perms)),
  };
}

/** profile id early requests of this tab use: the one this tab ran with, else the only profile of a single-profile account */
export const earlyProfile = (h: BootHint | null, tabProfile: string | null): string | null => tabProfile ?? (h && !h.multi ? h.profile ?? null : null);

function parsePermsMap(raw: unknown): BootHint['noPerms'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const m: Record<string, PermKey[]> = {};
  for (const [id, list] of Object.entries(raw)) { const d = deniedFromList(list); if (d.length) m[id] = d; }
  return Object.keys(m).length ? m : undefined;
}

export function parseHint(raw: string | null | undefined): BootHint | null {
  if (!raw) return null;
  try {
    const h = JSON.parse(raw);
    if (!(h && typeof h === 'object' && typeof h.approved === 'boolean' && typeof h.multi === 'boolean' && typeof h.tv === 'boolean')) return null;
    return {
      approved: h.approved, multi: h.multi, tv: h.tv, ...(typeof h.profile === 'string' && h.profile ? { profile: h.profile } : {}), ...(typeof h.lang === 'string' && /^[a-z]{2}$/.test(h.lang) ? { lang: h.lang } : {}),
      ...(h.kids === true ? { kids: true } : {}), ...(h.welcome === true ? { welcome: true } : {}), ...(h.noRequests === true ? { noRequests: true } : {}), ...((n) => (n ? { noPerms: n } : {}))(parsePermsMap(h.noPerms)),
    };
  } catch { return null; }
}

/**
 * The page may render (and start its own requests) while /api/me is still pending when the last answer said:
 * approved device, no TV, and no gate due in this session. Wrong guesses are corrected as soon as /api/me arrives.
 */
export const canRenderEarly = (h: BootHint | null, sessionPicked: boolean, path: string, activeProfile: string | null = 'x', reloading = false): boolean =>
  Boolean(h && h.approved && !h.tv && !(h.multi && !sessionPicked) && path !== '/profiles' && activeProfile && !reloading && !h.welcome && !(h.kids && !kidsAllowed(path)));

const ss = () => { try { return sessionStorage; } catch { return null; } };
const ls = () => { try { return localStorage; } catch { return null; } };
export function readPicked(): boolean { try { return ss()?.getItem(PICKED_KEY) === '1'; } catch { return false; } }
/** the gate was answered in this tab; `profileId` is the profile it switched to */
export function markPicked(profileId?: string): void { try { ss()?.setItem(PICKED_KEY, '1'); if (profileId) ss()?.setItem(ACTIVE_KEY, profileId); } catch { /* private mode */ } }
export function readActive(): string | null { try { return ss()?.getItem(ACTIVE_KEY) || null; } catch { return null; } }
export function writeActive(id: string | null | undefined): void { try { if (id) ss()?.setItem(ACTIVE_KEY, id); else ss()?.removeItem(ACTIVE_KEY); } catch { /* ignore */ } }
/** /api/me answered after a profile-switch reload: the reload guard has done its job (early render is allowed again) */
export function clearReloadFlag(): void { try { ss()?.removeItem(RELOAD_KEY); } catch { /* ignore */ } }
export function readReloading(): boolean { try { return ss()?.getItem(RELOAD_KEY) === '1'; } catch { return false; } }
export function readHint(): BootHint | null { try { return parseHint(ls()?.getItem(HINT_KEY)); } catch { return null; } }
export function writeHint(h: BootHint): void { try { ls()?.setItem(HINT_KEY, JSON.stringify(h)); } catch { /* ignore */ } }
export function clearHint(): void { try { ls()?.removeItem(HINT_KEY); ss()?.removeItem(PICKED_KEY); ss()?.removeItem(ACTIVE_KEY); } catch { /* ignore */ } }
