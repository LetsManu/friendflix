// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Docker Engine HTTP API client (to `docker-proxy`). Every call goes to `/v<negotiated>/…`; only constants, plain names / ids
 * and values from the template builders reach a path or query. No Docker message ever ends up in an error: status + fixed code.
 */
export const MIN_API = '1.45';
export const MAX_API = '1.52';

export class EngineError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`engine ${status} ${code}`);
    this.name = 'EngineError';
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_REPO_RE = /^[a-z0-9][a-z0-9./_-]{0,200}$/;
const IMAGE_REF_RE = /^[a-z0-9][a-z0-9./_:-]{0,200}(@sha256:[0-9a-f]{64})?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const VERSION_RE = /^([0-9]{1,3})\.([0-9]{1,3})$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const labelMap = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

const cmp = (a: string, b: string): number => {
  const [am, an] = a.split('.').map(Number) as [number, number];
  const [bm, bn] = b.split('.').map(Number) as [number, number];
  return am - bm || an - bn;
};

function plain(name: string): string {
  if (!NAME_RE.test(name)) throw new EngineError(0, 'invalid_name');
  return name;
}

interface Req { method: 'GET' | 'POST' | 'DELETE'; path: string; query?: Record<string, string>; body?: unknown; timeoutMs?: number; versioned?: boolean }
interface Res { status: number; bytes: Uint8Array }

export class Engine {
  private readonly base: string;
  private negotiated: Promise<{ api: string | null; ok: boolean }> | null = null;

  constructor(dockerHost: string, private readonly fetchImpl: typeof fetch = fetch) {
    const m = /^tcp:\/\/([A-Za-z0-9.-]+:[0-9]{1,5})$/.exec(dockerHost);
    if (!m) throw new EngineError(0, 'invalid_host');
    this.base = `http://${m[1]}`;
  }

  private async raw(r: Req, api: string | null): Promise<Res> {
    const q = r.query ? '?' + Object.entries(r.query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
    const url = `${this.base}${r.versioned === false ? '' : `/v${api}`}${r.path}${q}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), r.timeoutMs ?? 60_000);
    try {
      const res = await this.fetchImpl(url, {
        method: r.method, signal: ctl.signal,
        ...(r.body !== undefined ? { body: JSON.stringify(r.body), headers: { 'content-type': 'application/json' } } : {}),
      });
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch {
      throw new EngineError(0, ctl.signal.aborted ? 'timeout' : 'unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /version without a prefix: the daemon's API version, capped at MAX_API; ok = at least MIN_API (cached) */
  negotiate(): Promise<{ api: string | null; ok: boolean }> {
    this.negotiated ??= (async () => {
      let res: Res;
      try { res = await this.raw({ method: 'GET', path: '/version', versioned: false, timeoutMs: 10_000 }, null); } catch { this.negotiated = null; return { api: null, ok: false }; }
      const v = res.status === 200 ? str(this.json(res)?.ApiVersion) : '';
      if (!VERSION_RE.test(v)) { this.negotiated = null; return { api: null, ok: false }; }
      return { api: cmp(v, MAX_API) > 0 ? MAX_API : v, ok: cmp(v, MIN_API) >= 0 };
    })();
    return this.negotiated;
  }

  private json(res: Res): Obj | null {
    try {
      const v: unknown = JSON.parse(new TextDecoder().decode(res.bytes));
      return isObj(v) ? v : null;
    } catch { return null; }
  }

  private async call(r: Req, map: (status: number) => string | null): Promise<Res> {
    const n = await this.negotiate();
    if (!n.ok) throw new EngineError(0, n.api ? 'engine_old' : 'unreachable');
    const res = await this.raw(r, n.api);
    const code = res.status >= 200 && res.status < 300 ? null : map(res.status);
    if (code) throw new EngineError(res.status, code);
    return res;
  }

  private static generic = (s: number): string => (s === 404 ? 'not_found' : s === 403 ? 'forbidden' : s === 409 ? 'conflict' : 'engine_error');

  async version(): Promise<{ arch: string }> {
    const res = await this.call({ method: 'GET', path: '/version' }, Engine.generic);
    return { arch: str(this.json(res)?.Arch) };
  }

  async info(): Promise<{ dockerRoot: string; nvidia: boolean }> {
    const res = await this.call({ method: 'GET', path: '/info' }, Engine.generic);
    const j = this.json(res) ?? {};
    return { dockerRoot: str(j.DockerRootDir), nvidia: isObj(j.Runtimes) && 'nvidia' in j.Runtimes };
  }

  async inspectContainer(idOrName: string): Promise<Obj | null> {
    const res = await this.call({ method: 'GET', path: `/containers/${plain(idOrName)}/json` }, (s) => (s === 404 ? null : Engine.generic(s)));
    return res.status === 404 ? null : this.json(res);
  }

  async listContainers(labels: Record<string, string>, all = false): Promise<Array<{ id: string; names: string[]; state: string; labels: Record<string, string> }>> {
    const filters = JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) });
    const res = await this.call({ method: 'GET', path: '/containers/json', query: { all: all ? '1' : '0', filters } }, Engine.generic);
    return this.array(res).map((c) => ({ id: str(c.Id), names: strs(c.Names).map((n) => n.replace(/^\//, '')), state: str(c.State), labels: labelMap(c.Labels) }));
  }

  /** every container on the engine, running or stopped, with the image it was created from (the list's `Image`: a reference or an image id) */
  async allContainers(): Promise<Array<{ id: string; names: string[]; state: string; image: string; labels: Record<string, string> }>> {
    const res = await this.call({ method: 'GET', path: '/containers/json', query: { all: '1' } }, Engine.generic);
    return this.array(res).map((c) => ({ id: str(c.Id), names: strs(c.Names).map((n) => n.replace(/^\//, '')), state: str(c.State), image: str(c.Image), labels: labelMap(c.Labels) }));
  }

  private array(res: Res): Obj[] {
    try {
      const v: unknown = JSON.parse(new TextDecoder().decode(res.bytes));
      return Array.isArray(v) ? v.filter(isObj) : [];
    } catch { return []; }
  }

  /** the body goes out unchanged (the caller has run the guard); the name is in the query */
  async create(req: { name: string; body: Obj }): Promise<string> {
    const res = await this.call({ method: 'POST', path: '/containers/create', query: { name: plain(req.name) }, body: req.body },
      (s) => (s === 409 ? 'name_taken' : s === 404 ? 'image_missing' : 'create_failed'));
    return str(this.json(res)?.Id);
  }

  async start(id: string): Promise<void> {
    await this.call({ method: 'POST', path: `/containers/${plain(id)}/start` }, (s) => (s === 304 ? null : Engine.generic(s)));
  }

  async stop(id: string, seconds = 30): Promise<void> {
    const t = Math.max(0, Math.min(300, Math.trunc(seconds)));
    await this.call({ method: 'POST', path: `/containers/${plain(id)}/stop`, query: { t: String(t) }, timeoutMs: (t + 30) * 1000 }, (s) => (s === 304 ? null : Engine.generic(s)));
  }

  async rename(id: string, name: string): Promise<void> {
    await this.call({ method: 'POST', path: `/containers/${plain(id)}/rename`, query: { name: plain(name) } }, (s) => (s === 409 ? 'name_taken' : Engine.generic(s)));
  }

  async remove(id: string, o: { force?: boolean; volumes?: boolean } = {}): Promise<void> {
    const query: Record<string, string> = {};
    if (o.force) query.force = '1';
    if (o.volumes) query.v = '1';
    await this.call({ method: 'DELETE', path: `/containers/${plain(id)}`, ...(Object.keys(query).length ? { query } : {}) }, Engine.generic);
  }

  /** waits until the container is not running; resolves with its exit code */
  async wait(id: string, timeoutMs: number): Promise<number> {
    const res = await this.call({ method: 'POST', path: `/containers/${plain(id)}/wait`, query: { condition: 'not-running' }, timeoutMs }, Engine.generic);
    const code = this.json(res)?.StatusCode;
    return typeof code === 'number' ? code : -1;
  }

  /** multiplexed frames decoded; consecutive frames of one stream are joined (Docker splits entries at 16 KiB), then split on '\n' only */
  async logs(id: string, tail: number, streams: 'both' | 'stdout' = 'both'): Promise<string[]> {
    const t = Math.max(0, Math.min(10_000, Math.trunc(tail)));
    const res = await this.call({ method: 'GET', path: `/containers/${plain(id)}/logs`, query: { stdout: '1', stderr: streams === 'both' ? '1' : '0', tail: String(t) } }, Engine.generic);
    const runs: Array<{ type: number; chunks: Uint8Array[] }> = [];
    const b = res.bytes;
    for (let at = 0; at + 8 <= b.length;) {
      const type = b[at]!;
      const size = ((b[at + 4]! << 24) | (b[at + 5]! << 16) | (b[at + 6]! << 8) | b[at + 7]!) >>> 0;
      const chunk = b.subarray(at + 8, Math.min(b.length, at + 8 + size));
      at += 8 + size;
      if (type === 0 || (type === 2 && streams === 'stdout')) continue;
      const last = runs[runs.length - 1];
      if (last && last.type === type) last.chunks.push(chunk); else runs.push({ type, chunks: [chunk] });
    }
    const lines: string[] = [];
    for (const run of runs) {
      const text = new TextDecoder().decode(Buffer.concat(run.chunks));
      const parts = text.split('\n');
      if (parts[parts.length - 1] === '') parts.pop();
      lines.push(...parts);
    }
    return lines;
  }

  /** whether the proxy lets the log endpoint through (403 = not allowed) */
  async logsAllowed(self: string): Promise<boolean> {
    try {
      await this.call({ method: 'GET', path: `/containers/${plain(self)}/logs`, query: { stdout: '1', stderr: '1', tail: '0' } }, (s) => (s === 403 ? 'forbidden' : null));
      return true;
    } catch (e) {
      if (e instanceof EngineError && e.status === 403) return false;
      throw e;
    }
  }

  /** ref is repo@sha256:…; the stream is read to its end and an error line fails the pull without its message */
  async pull(ref: string): Promise<void> {
    const at = ref.lastIndexOf('@');
    const repo = at > 0 ? ref.slice(0, at) : '';
    const digest = ref.slice(at + 1);
    if (!IMAGE_REPO_RE.test(repo) || !DIGEST_RE.test(digest)) throw new EngineError(0, 'invalid_ref');
    const res = await this.call({ method: 'POST', path: '/images/create', query: { fromImage: repo, tag: digest }, timeoutMs: 15 * 60_000 }, () => 'pull_failed');
    for (const line of new TextDecoder().decode(res.bytes).split('\n')) {
      if (!line.trim()) continue;
      try {
        const j: unknown = JSON.parse(line);
        if (isObj(j) && ('error' in j || 'errorDetail' in j)) throw new EngineError(res.status, 'pull_failed');
      } catch (e) {
        if (e instanceof EngineError) throw e;
      }
    }
  }

  async inspectImage(ref: string): Promise<{ id: string; repoDigests: string[]; labels: Record<string, string>; env: string[]; entrypoint: string[] | null; cmd: string[] | null; volumes: string[]; user: string } | null> {
    if (!IMAGE_REF_RE.test(ref)) throw new EngineError(0, 'invalid_ref');
    const res = await this.call({ method: 'GET', path: `/images/${ref}/json` }, (s) => (s === 404 ? null : Engine.generic(s)));
    if (res.status === 404) return null;
    const j = this.json(res) ?? {};
    const c = isObj(j.Config) ? j.Config : {};
    return {
      id: str(j.Id), repoDigests: strs(j.RepoDigests), labels: labelMap(c.Labels), env: strs(c.Env),
      entrypoint: Array.isArray(c.Entrypoint) ? strs(c.Entrypoint) : null, cmd: Array.isArray(c.Cmd) ? strs(c.Cmd) : null,
      volumes: isObj(c.Volumes) ? Object.keys(c.Volumes) : [], user: str(c.User),
    };
  }

  async createVolume(v: { Name: string; Driver: 'local'; DriverOpts: Record<string, string>; Labels: Record<string, string> }): Promise<void> {
    plain(v.Name);
    await this.call({ method: 'POST', path: '/volumes/create', body: v }, Engine.generic);
  }

  async inspectVolume(name: string): Promise<{ labels: Record<string, string>; options: Record<string, string> } | null> {
    const res = await this.call({ method: 'GET', path: `/volumes/${plain(name)}` }, (s) => (s === 404 ? null : Engine.generic(s)));
    if (res.status === 404) return null;
    const j = this.json(res) ?? {};
    return { labels: labelMap(j.Labels), options: labelMap(j.Options) };
  }

  async removeVolume(name: string): Promise<void> {
    await this.call({ method: 'DELETE', path: `/volumes/${plain(name)}` }, Engine.generic);
  }

  async listNetworks(labels: Record<string, string>): Promise<Array<{ id: string; name: string; containers: string[] }>> {
    const filters = JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) });
    const res = await this.call({ method: 'GET', path: '/networks', query: { filters } }, Engine.generic);
    // the list answer leaves Containers empty (Docker API >= 1.28); only the network's own inspect names the attached containers
    return Promise.all(this.array(res).map(async (n) => {
      const id = str(n.Id);
      const one = await this.call({ method: 'GET', path: `/networks/${plain(id)}` }, (s) => (s === 404 ? null : Engine.generic(s)));
      const j = one.status === 404 ? null : this.json(one);
      return { id, name: str(n.Name), containers: j && isObj(j.Containers) ? Object.keys(j.Containers) : [] };
    }));
  }

  async connect(network: string, container: string): Promise<void> {
    await this.call({ method: 'POST', path: `/networks/${plain(network)}/connect`, body: { Container: plain(container) } }, Engine.generic);
  }
}
