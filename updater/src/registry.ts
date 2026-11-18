// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a tag points at in the registry, without pulling: the manifest digest of ghcr.io/<owner>/<repo>-<image>:<tag>. The update
 * compares it with what each service runs, so only the images that changed are pulled and only their containers recreated.
 * Anonymous pull token (the images are public), fixed host, fixed paths; a failure is StepError('registry_failed') and nothing
 * else: never the token, a response body or a URL reaches an error or a log.
 */
import { StepError } from './docker.js';
import { IMAGE_OF, expectedImage, imageRepo, isDigest, isTag } from './policy.js';

const REGISTRY = 'ghcr.io';
/** an index (multi-arch) first, then a single manifest; the digest is the one `docker pull <image>:<tag>` records */
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const TIMEOUT_MS = 15_000;
/** a bearer token as a header value can carry it (anything else is refused, never sent) */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{1,8192}$/;

/** <owner>/<repo>-<image> (lowercase) of the service's image; throws on a service that is not one of ours */
function repository(repo: string, service: string): string {
  if (!Object.hasOwn(IMAGE_OF, service)) throw new Error('invalid service');
  return imageRepo(expectedImage(repo, service, 'latest')).slice(REGISTRY.length + 1);
}

/** the registry digest of this repository's image of `service` with `tag`; StepError('registry_failed') on any failure */
export async function registryDigest(repo: string, service: string, tag: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!isTag(tag)) throw new Error('invalid tag');
  const path = repository(repo, service);
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const t = await fetchImpl(`https://${REGISTRY}/token?scope=repository:${path}:pull&service=${REGISTRY}`, { redirect: 'error', signal });
    if (!t.ok) { await t.body?.cancel().catch(() => undefined); throw new Error(); }
    const token = ((await t.json()) as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new Error();
    const r = await fetchImpl(`https://${REGISTRY}/v2/${path}/manifests/${tag}`, {
      method: 'HEAD', headers: { authorization: `Bearer ${token}`, accept: ACCEPT }, redirect: 'error', signal,
    });
    if (!r.ok) await r.body?.cancel().catch(() => undefined);
    const digest = r.ok ? r.headers.get('docker-content-digest') : null;
    if (isDigest(digest)) return digest;
  } catch { /* the cause may carry the token or a body: dropped */ }
  throw new StepError('registry_failed');
}

/**
 * a cached registry lookup; `size()` is how many entries the cache holds (expired ones are dropped on the next miss); `set` primes
 * an entry with a digest the update job resolved itself (fresh for the full TTL), `drop` forgets one (the job's lookup failed)
 */
export type CachedRegistry = ((service: string, tag: string) => Promise<string | null>) & {
  size(): number;
  set(service: string, tag: string, digest: string): void;
  drop(service: string, tag: string): void;
};

/**
 * registryDigest for the status page: one lookup per image and tag every `ttlMs`, a failure (null) asked again after `errTtlMs`;
 * callers asking at the same time share one lookup. A bad service or tag is null without a request. Every miss first drops the
 * expired entries, so the cache holds only what was asked within the last `ttlMs`.
 */
export function cachedRegistry(repo: string, ttlMs = 600_000, errTtlMs = 60_000, now: () => number = Date.now, fetchImpl?: typeof fetch): CachedRegistry {
  type Entry = { at: number; ok: boolean | null; value: Promise<string | null> };
  const cache = new Map<string, Entry>();
  const fresh = (e: Entry, t: number) => e.ok === null || t - e.at < (e.ok ? ttlMs : errTtlMs);
  const keyOf = (service: string, tag: string): string | null => (Object.hasOwn(IMAGE_OF, service) && isTag(tag) ? `${IMAGE_OF[service]}:${tag}` : null);
  const lookup = (service: string, tag: string): Promise<string | null> => {
    const key = keyOf(service, tag);
    if (!key) return Promise.resolve(null);
    const t = now();
    const hit = cache.get(key);
    if (hit && fresh(hit, t)) return hit.value;
    for (const [k, e] of cache) if (!fresh(e, t)) cache.delete(k);
    const entry: Entry = { at: t, ok: null, value: Promise.resolve(null) };
    entry.value = registryDigest(repo, service, tag, fetchImpl).then((d) => { entry.ok = true; return d; }, () => { entry.ok = false; return null; });
    cache.set(key, entry);
    return entry.value;
  };
  const set = (service: string, tag: string, digest: string): void => {
    const key = keyOf(service, tag);
    if (key && isDigest(digest)) cache.set(key, { at: now(), ok: true, value: Promise.resolve(digest) });
  };
  const drop = (service: string, tag: string): void => {
    const key = keyOf(service, tag);
    if (key) cache.delete(key);
  };
  return Object.assign(lookup, { size: () => cache.size, set, drop });
}
