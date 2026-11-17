// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
export const KINDS = ['ferrofin', 'jellyfin'] as const;
export type Kind = (typeof KINDS)[number];
export const GPUS = ['off', 'dri', 'nvidia'] as const;
export type Gpu = (typeof GPUS)[number];

/** a chosen media folder: `rel` below the confirmed base, `target` the mount point inside the media server */
export interface Folder { rel: string; target: string }
export interface DesiredSpec { kind: Kind; folders: Folder[]; uid: number; gid: number; gpu: Gpu; mediaGid: number | null; egress: boolean; tz: string }
export type Desired = DesiredSpec & { run: boolean };

export type MediaOp =
  | { op: 'base-request'; path: string } | { op: 'base-confirm'; code: string } | { op: 'base-clear' }
  | { op: 'browse'; rel: string } | { op: 'gpu' } | { op: 'logs'; tail: number }
  | { op: 'apply'; spec: DesiredSpec; firstRun?: { password: string } } | { op: 'finish-setup' }
  | { op: 'start' | 'stop' | 'restart' | 'update' } | { op: 'hdr-test'; kind: Kind }
  | { op: 'backup'; trickplay: boolean } | { op: 'restore'; id: string } | { op: 'remove'; data: boolean };

export const MEDIA_JOB_ACTIONS = ['mediaserver-apply', 'mediaserver-finish', 'mediaserver-start', 'mediaserver-stop', 'mediaserver-restart', 'mediaserver-update', 'mediaserver-hdr-test', 'mediaserver-backup', 'mediaserver-restore', 'mediaserver-remove', 'mediaserver-recover'] as const;
export type MediaJobAction = (typeof MEDIA_JOB_ACTIONS)[number];
export const MEDIA_STEPS = ['check', 'pull', 'verify', 'snapshot', 'create', 'start', 'health', 'rollback'] as const;
export type MediaStep = (typeof MEDIA_STEPS)[number];
export const MEDIA_ERRORS = ['no_base', 'base_missing', 'folder_missing', 'folder_symlink', 'folder_nested', 'folder_unreadable', 'too_many_folders', 'gpu_missing', 'nvidia_missing', 'no_network', 'name_taken', 'pull_failed', 'image_missing', 'arch_unsupported', 'verify_failed', 'snapshot_failed', 'downgrade_refused', 'template_violation', 'uid_unsupported', 'uid_mismatch', 'library_referenced', 'engine_old', 'create_failed', 'start_failed', 'unhealthy', 'managed_tampered', 'backup_failed', 'backup_invalid', 'kind_mismatch', 'restore_failed', 'remove_failed', 'interrupted', 'pin_invalid', 'no_logs', 'no_project', 'helper_timeout', 'helper_failed'] as const;
export type MediaError = (typeof MEDIA_ERRORS)[number];

export type BackupTag = 'manual' | 'auto' | 'upload';
export interface BackupMeta { id: string; kind: Kind; upstream: string; at: string; tag: BackupTag; size: number }
export interface HdrResult { kind: Kind; at: string; opencl: 'pass' | 'fail'; qsv: 'pass' | 'fail' }
export const BACKUP_ID_RE = /^(ferrofin|jellyfin)-[0-9]{8}-[0-9]{4}-[0-9A-Za-z.+_-]{1,40}$/;
