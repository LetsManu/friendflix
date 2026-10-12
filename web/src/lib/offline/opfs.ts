// Origin Private File System layout: ff-dl/<downloadId>/{video.mp4, sub-<lang>.vtt, poster.jpg, backdrop.jpg}
// Writes happen in fetch-worker.ts via createSyncAccessHandle; this module covers detection, reads, deletion and quota.
import { tr } from '#lib/i18n';

export const ROOT = 'ff-dl';

export type Unsupported = 'insecure' | 'no-opfs' | 'ios-install' | 'tv';
export interface Support { ok: boolean; reason?: Unsupported }

/** hint per reason, translated on every read (getters), so `SUPPORT_HINT[reason]` follows the UI language */
export const SUPPORT_HINT: Readonly<Record<Unsupported, string>> = {
  get insecure() { return tr('account.downloads.support.insecure'); },
  get 'no-opfs'() { return tr('account.downloads.support.noOpfs'); },
  get 'ios-install'() { return tr('account.downloads.support.iosInstall'); },
  get tv() { return tr('account.downloads.support.tv'); },
};

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;

export function detectSupport(): Support {
  if (typeof window === 'undefined') return { ok: false, reason: 'no-opfs' };
  if (document.documentElement.classList.contains('tv') || sessionStorage.getItem('ff_tv') === '1') return { ok: false, reason: 'tv' };
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  const h = (globalThis as any).FileSystemFileHandle;
  if (!navigator.storage?.getDirectory || !h || !('createSyncAccessHandle' in h.prototype) || typeof Worker === 'undefined' || !('indexedDB' in window)) return { ok: false, reason: 'no-opfs' };
  if (isIos() && !isStandalone()) return { ok: false, reason: 'ios-install' }; // non-installed sites are evicted after 7 days on WebKit
  return { ok: true };
}

export async function rootDir(create = true): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create });
}
export async function dlDir(id: string, create = false): Promise<FileSystemDirectoryHandle> {
  return (await rootDir(create)).getDirectoryHandle(id, { create });
}

/** the stored file (e.g. 'video.mp4') as a File, or null */
export async function getFile(id: string, name: string): Promise<File | null> {
  try { return await (await (await dlDir(id)).getFileHandle(name)).getFile(); } catch { return null; }
}
export async function fileSize(id: string, name = 'video.mp4'): Promise<number> {
  return (await getFile(id, name))?.size ?? 0;
}

/** removes the whole download folder; succeeds when it does not exist */
export async function deleteDownloadFiles(id: string): Promise<void> {
  try { await (await rootDir(false)).removeEntry(id, { recursive: true }); } catch (e: any) { if (e?.name !== 'NotFoundError') throw e; }
}
/** removes OPFS folders that no record points to (crashed or cancelled downloads) */
export const deleteOrphans = async (keep: string[]): Promise<void> => {
  let root: FileSystemDirectoryHandle;
  try { root = await rootDir(false); } catch { return; }
  for await (const name of (root as any).keys() as AsyncIterable<string>) if (!keep.includes(name)) await root.removeEntry(name, { recursive: true }).catch(() => undefined);
};

export interface StorageInfo { usage: number; quota: number }
export async function storageEstimate(): Promise<StorageInfo> {
  try { const e = await navigator.storage.estimate(); return { usage: e.usage ?? 0, quota: e.quota ?? 0 }; } catch { return { usage: 0, quota: 0 }; }
}
/** ask the browser not to evict our data; resolves whether it is persistent now */
export async function persist(): Promise<boolean> {
  try { if (await navigator.storage.persisted()) return true; return await navigator.storage.persist(); } catch { return false; }
}
