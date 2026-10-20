// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { FILE_RE } from './config.js';
import { FF_SERVICES, SELF_SERVICE, cosignIdentity, expectedImage, isTag, pinnedRef } from './policy.js';
import { classifyStack, configDrift, type StackKind, type StackOrigin } from './stack.js';

/** The only two programs the updater starts, never through a shell. */
export type Program = 'docker' | 'cosign';
export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (program: Program, args: readonly string[], opts: { env: Record<string, string>; timeoutMs: number }) => Promise<RunResult>;

/** execFile without a shell; the child gets only the environment passed in (never the updater's own, which holds the secret). */
export const execRunner: Runner = (program, args, opts) => new Promise((resolve) => {
  execFile(program, [...args], { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

export interface ComposeSettings {
  /** the stack's directory, mounted read-only at the same path as on the host (relative bind paths must resolve the same) */
  projectDir: string;
  /** compose files inside projectDir (plain file names, checked in config.ts); with autoFiles the fallback */
  files: readonly string[];
  /** take the files the running stack was started with (the backend container's compose labels), see refreshFiles */
  autoFiles?: boolean;
  /** optional explicit project name (else the file's `name:`) */
  projectName?: string;
  /** owner/repo whose CI signs the images */
  repo: string;
  dockerHost: string;
}

export type ServiceState = { service: string; name: string; state: string; health: string };
export type ImageInfo = { repoDigests: string[]; gitSha: string | null; version: string | null };

const MIN = 60_000;

/** The fixed command lines. Every argument is a constant, a validated tag or a value read back from Docker itself. */
export class Docker {
  private active: readonly string[];
  constructor(private readonly s: ComposeSettings, private readonly run: Runner) { this.active = s.files; }

  /** the compose files the next commands use */
  get files(): readonly string[] { return this.active; }

  /**
   * Whose stack runs here, from the backend container's compose labels (stack.ts classifyStack): own = started from projectDir,
   * else foreign (another working directory such as Portainer's /data/compose/<id>, Portainer labels, no labels, no backend
   * container in this project). Throws compose_config when compose cannot even list the containers.
   */
  async origin(): Promise<StackOrigin & { labels: Record<string, unknown> | null }> {
    const rows = await this.psRows(this.s.files); // the configured files find the same project's containers
    if (rows === null) throw new StepError('compose_config');
    const st = rows.find((p) => p.service === 'backend');
    const labels = st ? await this.labels(st.name) : null;
    return { ...classifyStack(labels, this.s.projectDir), labels };
  }

  /** own / foreign for the status (null = could not tell: compose or Docker did not answer) */
  async stackKind(): Promise<StackKind | null> {
    try { return (await this.origin()).stack; } catch { return null; }
  }

  /**
   * Refuses a foreign stack (StepError foreign_stack, before anything else runs), then settles on the compose files. Without
   * UPDATER_COMPOSE_FILES: the files the stack was last brought up with, as compose recorded them on the backend container
   * (label com.docker.compose.project.config_files). So a stack started with compose.plex.yaml, compose.secrets.yaml or any
   * other override is recreated with the same files. Every entry must be a plain file name directly in the project directory;
   * anything else (a path, more than 8 files) falls back to the configured list.
   */
  async refreshFiles(): Promise<readonly string[]> {
    const o = await this.origin();
    if (o.stack === 'foreign') throw new StepError('foreign_stack', o.reason);
    this.active = (this.s.autoFiles ? this.filesOf(o.labels) : null) ?? this.s.files;
    return this.active;
  }

  /** the compose file names a container was created with (validated, see refreshFiles); null when they do not qualify */
  async startedWith(container: string): Promise<string[] | null> {
    return this.filesOf(await this.labels(container));
  }

  /** a container's labels; null when it cannot be read */
  private async labels(container: string): Promise<Record<string, unknown> | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) return null;
    const r = await this.run('docker', ['container', 'inspect', '--format', '{{json .Config.Labels}}', container], { env: this.env(), timeoutMs: MIN });
    if (r.code !== 0) return null;
    try {
      const v = JSON.parse(r.stdout.trim()) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch { return null; }
  }

  private filesOf(labels: Record<string, unknown> | null): string[] | null {
    const dir = labels?.['com.docker.compose.project.working_dir'], files = labels?.['com.docker.compose.project.config_files'];
    if (dir !== this.s.projectDir || typeof files !== 'string') return null;
    const names = files.split(',').map((f) => f.trim()).filter(Boolean).map((f) => (f.startsWith(`${this.s.projectDir}/`) ? f.slice(this.s.projectDir.length + 1) : ''));
    if (!names.length || names.length > 8 || new Set(names).size !== names.length || !names.every((n) => FILE_RE.test(n))) return null;
    return names;
  }

  /**
   * The child environment: Docker endpoint, a writable config dir, the tag compose interpolates, PWD = the stack directory
   * (compose.prod.yaml mounts it at ${PWD}, so the updater's own definition renders the same as on the host), nothing else.
   */
  env(tag?: string): Record<string, string> {
    if (tag !== undefined && !isTag(tag)) throw new Error('invalid tag');
    return {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', PWD: this.s.projectDir, DOCKER_HOST: this.s.dockerHost, DOCKER_CONFIG: '/tmp/.docker',
      ...(tag ? { FF_TAG: tag } : {}),
    };
  }

  private compose(tag: string | undefined, args: readonly string[], timeoutMs: number, files: readonly string[] = this.active): Promise<RunResult> {
    const base = ['compose', '--project-directory', this.s.projectDir, ...files.flatMap((f) => ['-f', `${this.s.projectDir}/${f}`]),
      ...(this.s.projectName ? ['-p', this.s.projectName] : []), '--profile', 'updater', '--ansi', 'never'];
    return this.run('docker', [...base, ...args], { env: this.env(tag), timeoutMs });
  }

  /** the image each service would run with `tag`; throws unless every one is exactly ghcr.io/<owner>/<repo>-<image>:<tag> */
  async images(tag: string, services: readonly string[]): Promise<Record<string, string>> {
    await this.refreshFiles();
    const r = await this.compose(tag, ['config', '--format', 'json'], MIN);
    if (r.code !== 0) throw new StepError('compose_config');
    let cfg: { services?: Record<string, { image?: unknown; environment?: unknown }> };
    try { cfg = JSON.parse(r.stdout); } catch { throw new StepError('compose_config'); }
    const out: Record<string, string> = {};
    for (const svc of services) {
      const image = cfg.services?.[svc]?.image;
      if (typeof image !== 'string' || image !== expectedImage(this.s.repo, svc, tag)) throw new StepError('unexpected_image');
      out[svc] = image;
    }
    // A stack on Plex is only Plex through compose.plex.yaml (MEDIA_SERVER=plex). When the compose files the updater was given
    // would recreate the backend with another media server than the one its container runs now (UPDATER_COMPOSE_FILES without
    // compose.plex.yaml), nothing is pulled or restarted.
    for (const svc of services.filter((s) => s === 'backend' || s === 'gateway')) {
      const now = await this.existingMediaServer(svc);
      if (now !== null && now !== mediaServerOf(envEntries(cfg.services?.[svc]?.environment))) throw new StepError('media_server_mismatch');
    }
    // Recreating must not change what the stack publishes or where it is attached: the compose files plus .env the updater sees
    // have to render the same ports and networks as the containers run with now (they differ when the stack was started with
    // other variables, e.g. BIND_ADDR from a shell or a stack manager). Nothing is pulled or restarted otherwise.
    const ps = await this.ps();
    for (const svc of services) {
      const st = ps.find((p) => p.service === svc);
      const now = st ? await this.runningConfig(st.name) : null;
      const drift = now ? configDrift(cfg, svc, now) : null;
      if (drift) throw new StepError('config_mismatch', `${svc} ${drift}`);
    }
    return out;
  }

  /** published ports, networks and compose project of an existing container (any state; null when it cannot be read) */
  async runningConfig(container: string): Promise<{ ports: unknown; networks: unknown; project: string | null } | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) return null;
    const r = await this.run('docker', ['container', 'inspect', '--format', '{{json .HostConfig.PortBindings}}\t{{json .NetworkSettings.Networks}}\t{{json .Config.Labels}}', container],
      { env: this.env(), timeoutMs: MIN });
    if (r.code !== 0) return null;
    const [ports, networks, labels] = r.stdout.trim().split('\t');
    try {
      const l = JSON.parse(labels ?? 'null') as Record<string, unknown> | null;
      const project = l?.['com.docker.compose.project'];
      return { ports: JSON.parse(ports ?? 'null'), networks: JSON.parse(networks ?? 'null'), project: typeof project === 'string' ? project : null };
    } catch { return null; }
  }

  /** MEDIA_SERVER of the service's existing container (any state; null when there is none or it cannot be read) */
  async existingMediaServer(service: string): Promise<string | null> {
    const st = (await this.ps()).find((p) => p.service === service);
    if (!st || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(st.name)) return null;
    const r = await this.run('docker', ['container', 'inspect', '--format', '{{json .Config.Env}}', st.name], { env: this.env(), timeoutMs: MIN });
    if (r.code !== 0) return null;
    try {
      const e = JSON.parse(r.stdout.trim()) as unknown;
      if (!Array.isArray(e)) return null;
      return mediaServerOf(e.filter((x): x is string => typeof x === 'string').map((v) => [v.slice(0, Math.max(0, v.indexOf('='))), v.slice(v.indexOf('=') + 1)]));
    } catch { return null; }
  }

  async pull(tag: string, services: readonly string[]): Promise<void> {
    const r = await this.compose(tag, ['pull', '--quiet', ...services], 10 * MIN);
    if (r.code !== 0) throw new StepError('pull_failed');
  }

  /** recreates exactly these services from the images already pulled and verified (`--pull never`: no second, unverified pull) */
  async up(tag: string, services: readonly string[]): Promise<void> {
    const r = await this.compose(tag, ['up', '-d', '--no-deps', '--pull', 'never', ...services], 10 * MIN);
    if (r.code !== 0) throw new StepError('restart_failed');
  }

  /**
   * Self-update: a one-shot sibling container of the updater service (same definition, the new image) recreates the updater;
   * the running updater cannot do it itself because compose stops it halfway through.
   */
  async spawnSelfUpdate(tag: string): Promise<void> {
    await this.refreshFiles();
    const r = await this.compose(tag, ['run', '-d', '--rm', '--no-deps', '--pull', 'never', '-e', `FF_TAG=${tag}`, SELF_SERVICE, 'node', 'updater/dist/selfUpdate.js'], 2 * MIN);
    if (r.code !== 0) throw new StepError('restart_failed');
  }

  async ps(): Promise<ServiceState[]> {
    return (await this.psRows(this.active)) ?? [];
  }

  /** null when compose fails */
  private async psRows(files: readonly string[]): Promise<ServiceState[] | null> {
    const r = await this.compose(undefined, ['ps', '--all', '--format', 'json', ...FF_SERVICES, SELF_SERVICE], MIN, files);
    if (r.code !== 0) return null;
    // compose prints one JSON object per line (older versions: one array)
    const rows: Array<Record<string, unknown>> = [];
    for (const line of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      try { const v = JSON.parse(line); rows.push(...(Array.isArray(v) ? v : [v])); } catch { /* ignore */ }
    }
    return rows.map((x) => ({ service: String(x.Service ?? ''), name: String(x.Name ?? ''), state: String(x.State ?? ''), health: String(x.Health ?? '') }));
  }

  /** what an image (a tag or the id a container runs) is: its registry digests and the commit baked in (GIT_SHA, APP_VERSION) */
  async imageInfo(ref: string): Promise<ImageInfo | null> {
    if (!/^[a-z0-9][a-z0-9./:@_-]{0,250}$/.test(ref)) return null;
    const r = await this.run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}\t{{json .Config.Env}}', ref], { env: this.env(), timeoutMs: MIN });
    if (r.code !== 0) return null;
    const [digests, env] = r.stdout.trim().split('\t');
    try {
      const d = JSON.parse(digests ?? '[]') as unknown, e = JSON.parse(env ?? '[]') as unknown;
      const vars = Array.isArray(e) ? e.filter((x): x is string => typeof x === 'string') : [];
      const get = (k: string) => vars.find((v) => v.startsWith(`${k}=`))?.slice(k.length + 1) || null;
      return { repoDigests: Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [], gitSha: get('GIT_SHA'), version: get('APP_VERSION') };
    } catch { return null; }
  }

  /** the image id a container runs */
  async containerImage(container: string): Promise<string | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) return null;
    const r = await this.run('docker', ['container', 'inspect', '--format', '{{.Image}}', container], { env: this.env(), timeoutMs: MIN });
    const id = r.stdout.trim();
    return r.code === 0 && /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
  }

  /** what a service runs now (image digests + GIT_SHA of its container's image) */
  async running(service: string): Promise<ImageInfo | null> {
    const st = (await this.ps()).find((p) => p.service === service && p.state === 'running');
    const id = st ? await this.containerImage(st.name) : null;
    return id ? this.imageInfo(id) : null;
  }

  /** cosign keyless verification of image@digest against this repository's publish workflow; false on any failure */
  async verify(image: string): Promise<boolean> {
    const info = await this.imageInfo(image);
    const ref = info ? pinnedRef(image, info.repoDigests) : null;
    if (!ref) return false;
    const id = cosignIdentity(this.s.repo);
    const r = await this.run('cosign', ['verify', '--certificate-identity-regexp', id.identityRegexp, '--certificate-oidc-issuer', id.issuer, ref],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' }, timeoutMs: 2 * MIN });
    return r.code === 0;
  }
}

/** compose renders `environment` as a map (older versions: a list of KEY=value) */
function envEntries(env: unknown): Array<[string, string]> {
  if (Array.isArray(env)) return env.filter((x): x is string => typeof x === 'string' && x.includes('=')).map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]);
  if (env && typeof env === 'object') return Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : '']);
  return [];
}

/** the media server kind an environment selects (the backend's and gateway's rule: unset or empty = jellyfin, case and spaces ignored) */
export function mediaServerOf(entries: ReadonlyArray<readonly [string, string]>): string {
  const v = entries.find(([k]) => k === 'MEDIA_SERVER')?.[1]?.trim().toLowerCase();
  return v || 'jellyfin';
}

/** a step failure with a fixed code (the only thing that reaches the log, the state file and the backend) */
export class StepError extends Error {
  /** `detail`: a fixed hint for the job log (a service name and a constant word, never command output) */
  constructor(readonly code: string, readonly detail?: string) { super(code); }
}
