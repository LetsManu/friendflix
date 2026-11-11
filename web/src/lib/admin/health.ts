// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Status (Block 22): mirror of the backend health snapshot (`backend/src/health.ts`), the active streams view
 * (`playstats.ts`) and the aggregated error log (`errorlog.ts`), plus the pure helpers the page and the overview use.
 */
import { api } from '#lib/api';
import { fmtNumber, fmtTime, hasKey, tr, trDynamic, type TKey } from '#lib/i18n';
import type { Tone } from '#lib/ui/StatusPill.svelte';

export type Level = 'ok' | 'warn' | 'err' | 'off';
export const SERVICE_IDS = ['media', 'postgres', 'redis', 'gateway', 'oidc', 'requests', 'tmdb', 'omdb', 'playbackCheck', 'encoder'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];
/** the encoder row's advice codes (backend health.ts encoderAdvice), most important first */
export const ENCODER_ADVICE = ['no_hw_accel', 'no_tonemap', 'no_throttle', 'no_keyframes', 'hevc_server_off', 'hevc_no_hw', 'hevc_failed', 'hevc_slow', 'hevc_limited', 'downmix_plain'] as const;
export type EncoderAdvice = (typeof ENCODER_ADVICE)[number];
export const REASONS = [
  'slow', 'down', 'issuer_mismatch', 'invalid_key', 'paused', 'budget', 'not_set', 'failed_titles', 'unavailable',
  'full', 'low_free', 'cap', 'large', 'server_errors', 'client_errors', 'failed_playbacks', 'empty_media', 'pending_approvals', 'removed_env',
  ...ENCODER_ADVICE,
] as const;
export type Reason = (typeof REASONS)[number];
export interface Detail { n?: number; pct?: number }
/** the server's HEVC conversion (backend hevcenc.ts HevcState); `off` is never sent */
export const HEVC_STATES = ['server_off', 'no_hw', 'unproven', 'failed', 'slow', 'runtime_failed', 'ready'] as const;
export type HevcState = (typeof HEVC_STATES)[number];
export interface HevcLine { state: HevcState; speed?: number; at?: string }
export interface ServiceHealth { id: ServiceId; level: Level; reason?: Reason; ms?: number; detail?: Detail; advice?: EncoderAdvice[]; hevc?: HevcLine }
/** "HEVC conversion: ready · 2.4× real time · checked 03:10" (state always, speed and time only when a probe is known) */
export function hevcLineText(h: HevcLine): string {
  if (!(HEVC_STATES as readonly string[]).includes(h.state)) return '';
  return [
    tr('adminContent.health.hevc.line', { state: tr(`adminContent.health.hevc.state.${h.state}` as TKey) }),
    ...(typeof h.speed === 'number' ? [tr('adminContent.health.hevc.speed', { n: fmtNumber(h.speed, { maximumFractionDigits: 1 }) })] : []),
    ...(h.at ? [tr('adminContent.health.hevc.checked', { time: fmtTime(h.at) })] : []),
  ].join(' · ');
}
/** "Check HEVC now": starts the timed probe in the background (202); 409 `busy` while someone watches, `already_running` while one runs */
export const checkHevc = (): Promise<{ started: boolean }> => api<{ started: boolean }>('/api/admin/hevc-check', { method: 'POST' });
/** the probe's progress: `running` until it has stored its result */
export const loadHevcCheck = (): Promise<{ running: boolean }> => api<{ running: boolean }>('/api/admin/hevc-check');
/** polling: every 2 s, give up after 3 minutes */
export const HEVC_POLL_MS = 2000;
export const HEVC_POLL_MAX_MS = 180_000;
/** the advice lines of a row (only known codes) */
export const adviceKeys = (s: Pick<ServiceHealth, 'advice'>): TKey[] => (s.advice ?? []).filter((a) => (ENCODER_ADVICE as readonly string[]).includes(a)).map((a) => `adminContent.health.advice.${a}` as TKey);
export type DiskId = 'downloads' | 'previews' | 'database';
export interface DiskHealth {
  id: DiskId; level: Level; reason?: Reason; totalBytes?: number; freeBytes?: number; usedPct?: number; ownBytes: number; capBytes?: number;
  /** both volumes on one filesystem: this entry stands for both, `sharedBytes` is the other volume's own share */
  sharedWith?: 'downloads' | 'previews'; sharedBytes?: number;
}
export interface ErrorHealth { level: Level; reason?: Reason; server15: number; client15: number; playback60: number }
export interface HealthIssue { id: string; level: 'warn' | 'err'; reason: Reason; fp: string; detail?: Detail }
export interface HealthSnapshot { at: string; services: ServiceHealth[]; disks: DiskHealth[]; errors: ErrorHealth; issues: HealthIssue[]; worst: Level }

export const TC_REASONS = ['network', 'remoteCap', 'uploadCap', 'roleCap', 'container', 'videoCodec', 'audioCodec', 'audioTrack', 'subtitles', 'height', 'manual', 'other'] as const;
export type TranscodeReason = (typeof TC_REASONS)[number];
export type StreamMethod = 'direct' | 'remux' | 'transcode';
export interface StreamRow {
  userId: string | null; userName: string | null; profileName: string | null; device: string | null; title: string; seriesName: string | null;
  source: 'portal' | 'app'; method: StreamMethod | null; reason: TranscodeReason | null;
  videoCodec: string | null; audioCodec: string | null; hardware: boolean | null; paused: boolean;
}
export interface FailedPlayback { itemId: string; title: string | null; count: number; lastAt: string; code: string }
export interface StreamsView { streams: StreamRow[]; totals: Record<StreamMethod, number>; details: boolean; failed: FailedPlayback[] }

export type ErrorSource = 'server' | 'client' | 'playback' | 'job';
export interface ErrorEntry { source: ErrorSource; code: string; count: number; firstAt: string; lastAt: string; release?: string; sample?: string; itemId?: string }
export interface ErrorList { entries: ErrorEntry[]; overflow: number }

export const loadHealth = (refresh = false): Promise<HealthSnapshot> => api<HealthSnapshot>(`/api/admin/health${refresh ? '?refresh=1' : ''}`);
export const loadStreams = (): Promise<StreamsView> => api<StreamsView>('/api/admin/streams');
export const loadErrors = (hours = 24): Promise<ErrorList> => api<ErrorList>(`/api/admin/errors?hours=${hours}`);

const TONE: Record<Level, Tone> = { ok: 'ok', warn: 'warn', err: 'err', off: 'muted' };
export const levelTone = (l: Level): Tone => TONE[l];
/** icon of a level pill (never colour alone) */
export const levelIcon = (l: Level): string => ({ ok: 'check', warn: 'clock', err: 'alert', off: 'x' })[l];

const RANK: Record<Level, number> = { err: 0, warn: 1, ok: 2, off: 3 };
/** worst first: err, warn, ok, off (stable inside a level) */
export function sortServices<T extends { level: Level }>(s: readonly T[]): T[] {
  return s.map((x, i) => [x, i] as const).sort((a, b) => RANK[a[0].level] - RANK[b[0].level] || a[1] - b[1]).map(([x]) => x);
}

/** text key of a reason; a few reasons read differently for disks ("Nicht lesbar") than for services */
export function reasonKey(id: string, reason: Reason): TKey {
  if (id.startsWith('disk:') && reason === 'unavailable') return 'adminContent.health.disks.unreadable';
  return `adminContent.health.reason.${reason}` as TKey;
}

/** pill text of a service: the reason (with its numbers) or the plain level */
export function serviceText(s: Pick<ServiceHealth, 'id' | 'level' | 'reason' | 'detail'>): string {
  if (s.reason) return tr(reasonKey(`svc:${s.id}`, s.reason), { n: s.detail?.n ?? 0, pct: s.detail?.pct ?? 0 });
  if (s.id === 'playbackCheck' && s.level === 'off') return tr('adminContent.health.playbackNever');
  return tr(`adminContent.health.level.${s.level}` as TKey);
}

export const diskLabelKey = (d: DiskHealth): TKey => (d.sharedWith ? 'adminContent.health.disks.shared' : (`adminContent.health.disks.${d.id}` as TKey));

/** error codes are scrubbed by the server; addresses are cut here as well (a resource error names its URL) */
export const cleanCode = (code: string): string => code.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '…').trim();

/** short chip text of a transcode reason ("Videoformat"); `other` is stored as `misc` (an `other` key would read as a plural form) */
export const tcKey = (r: TranscodeReason): TKey => `adminContent.health.tc.${r === 'other' ? 'misc' : r}` as TKey;

/**
 * A playback-check / download error that means the media server answered with empty video (a hung hardware encoder returns
 * HTTP 200 with no bytes): the probe's "HTTP 200 empty body" / "empty playlist", the preparer's "empty segment from media server".
 */
export const isEmptyMediaError = (error: string | null | undefined): boolean =>
  Boolean(error && /HTTP 200 empty body|empty playlist|empty segment from media server/i.test(error));

/** every checked title failed and at least one with empty video: the hint is shown once above the list instead of under each row */
export const emptyHintOnTop = (results: ReadonlyArray<{ ok: boolean; error: string | null }>): boolean =>
  results.length > 0 && results.every((r) => !r.ok) && results.some((r) => isEmptyMediaError(r.error));

// ---------------------------------------------------------------------------------------------------------------------------
// Block 23 phase 3: the sign-in card (mirror of backend/src/flowCheck.ts `LoginCheck`)

export type CheckedKind = 'login' | 'recovery' | 'enroll' | 'invalidation' | 'setup-totp' | 'setup-static' | 'setup-webauthn' | 'change-password' | 'change-email';
export interface FlowCheckRow { kind: CheckedKind; slug: string; state: 'ok' | 'missing' | 'unsupported'; stages: string[] }
export interface LoginCheck {
  mode: 'app' | 'authentik';
  flows: FlowCheckRow[];
  implicitConsent: boolean | null;
  authCodeGrant: boolean | null;
  issuerMatches: boolean;
  passkeys: 'in-app' | 'sign-in page';
  passkeysReason: string;
  /** whether the sign-in screen can offer a passkey in FriendFlix (backend flowCheck.ts PasskeySignIn); null: not checked */
  passkeySignIn?: 'ok' | 'no_stage' | 'rp_mismatch' | 'off' | 'unknown' | null;
  /** the userVerification Authentik's passkey challenge asks for (backend flowCheck.ts PasskeyUv); null: no passkey challenge / not checked */
  passkeyUv?: 'required' | 'preferred' | 'discouraged' | 'unknown' | null;
  unreachable: boolean;
  /** the service token: accepted at all, and the read permissions Authentik refused */
  serviceToken?: { token: 'ok' | 'invalid' | 'unreachable'; missing: string[] } | null;
  /** one anonymous call of the login flow's executor from the server: ok, or the error class, upstream status and endpoint path */
  executor?: { ok: true } | { ok: false; cls: string; status?: number; endpoint: string } | null;
  /** the latest Authentik failure per area (executor, api) in the last 24 h */
  lastFailures?: Array<{ area: 'executor' | 'api'; cls: string; status?: number; endpoint: string; at: string }>;
  /** codes: `unreachable`, `token:invalid`, `permission:<perm>`, `executor:<class>`, `optional:change-email`, `flow_missing:<kind>`, `flow_unsupported:<kind>`, `consent`, `auth_code_grant`, `issuer`, `passkeys:<reason>`,
   *  `permission:provider|validate_stage` (the service account lacks a read permission) */
  warnings: string[];
}
export const loadLoginCheck = (fresh = false): Promise<LoginCheck> => api<LoginCheck>(`/api/admin/health/login${fresh ? '?refresh=1' : ''}`);

/** POST /api/admin/authentik/repair: the one-time admin token goes in the body only and is never kept */
export interface RepairResult { ok: boolean; steps: Array<{ id: string; state: string; detail?: string }>; tokenSaved?: boolean; envKept?: string[]; check?: LoginCheck }
/** `passkeySignIn`: the admin's opt-in to set the passkey check on Authentik's default identification stage (for every application) */
export const repairAuthentik = (token: string, passkeySignIn = false): Promise<RepairResult> =>
  api<RepairResult>('/api/admin/authentik/repair', { method: 'POST', body: { token, passkeySignIn } });

/** an error class of the status card as text (unknown classes: the raw class, which is a fixed code word) */
export const failClassText = (cls: string): string => (hasKey(`adminContent.login.failClass.${cls}`) ? trDynamic(`adminContent.login.failClass.${cls}`) : cls);

/** The text of a check warning code (unknown codes get no text: the card shows nothing rather than a raw code). */
export function loginWarningText(code: string, flowName: (kind: string) => string): string {
  const [head, arg = ''] = code.split(':');
  if (head === 'permission' && arg.startsWith('view_')) return trDynamic('adminContent.login.warn.permission_missing', { perm: arg });
  if (head === 'executor') return trDynamic('adminContent.login.warn.executor', { cls: failClassText(arg) });
  const key = ['passkeys', 'permission', 'token', 'optional'].includes(head!) ? `adminContent.login.warn.${head}_${arg.replace(/-/g, '_')}` : `adminContent.login.warn.${head}`;
  return hasKey(key) ? trDynamic(key, { flow: flowName(arg) }) : '';
}
