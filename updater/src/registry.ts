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
    if (!t.ok) throw new Error();
    const token = ((await t.json()) as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new Error();
    const r = await fetchImpl(`https://${REGISTRY}/v2/${path}/manifests/${tag}`, {
      method: 'HEAD', headers: { authorization: `Bearer ${token}`, accept: ACCEPT }, redirect: 'error', signal,
    });
    const digest = r.ok ? r.headers.get('docker-content-digest') : null;
    if (isDigest(digest)) return digest;
  } catch { /* the cause may carry the token or a body: dropped */ }
  throw new StepError('registry_failed');
}

/**
 * registryDigest for the status page: one lookup per image and tag every `ttlMs`, a failure (null) asked again after `errTtlMs`;
 * callers asking at the same time share one lookup. A bad service or tag is null without a request.
 */
export function cachedRegistry(repo: string, ttlMs = 600_000, errTtlMs = 60_000, now: () => number = Date.now, fetchImpl?: typeof fetch): (service: string, tag: string) => Promise<string | null> {
  const cache = new Map<string, { at: number; ok: boolean | null; value: Promise<string | null> }>();
  return (service, tag) => {
    if (!Object.hasOwn(IMAGE_OF, service) || !isTag(tag)) return Promise.resolve(null);
    const key = `${IMAGE_OF[service]}:${tag}`;
    const t = now();
    const hit = cache.get(key);
    if (hit && (hit.ok === null || t - hit.at < (hit.ok ? ttlMs : errTtlMs))) return hit.value;
    const entry: { at: number; ok: boolean | null; value: Promise<string | null> } = { at: t, ok: null, value: Promise.resolve(null) };
    entry.value = registryDigest(repo, service, tag, fetchImpl).then((d) => { entry.ok = true; return d; }, () => { entry.ok = false; return null; });
    cache.set(key, entry);
    return entry.value;
  };
}
