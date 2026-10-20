// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two guards before anything is pulled or recreated (docs/operations.md "Updater"):
 *
 * - whose stack it is: the updater only recreates a stack that was started from its own project directory. A stack another
 *   tool started (Portainer: working_dir /data/compose/<id>, its variables in Portainer's database, not in the project's .env)
 *   would be recreated without those variables (BIND_ADDR, ports, ...), so it is "foreign" and never touched.
 * - whether the rendered config still matches the running containers: published ports and networks per service. A difference
 *   means the compose files plus .env the updater sees are not what the stack was started with; recreating would change them.
 *
 * Pure functions over what Docker / compose print (labels, PortBindings, Networks, `compose config --format json`).
 */

export type StackKind = 'own' | 'foreign';
export interface StackOrigin {
  stack: StackKind;
  /** the tool that manages a foreign stack, when it can be told */
  manager: 'portainer' | null;
  /** fixed reason (job log only): own, no_labels, working_dir, portainer */
  reason: 'own' | 'no_labels' | 'working_dir' | 'portainer';
}

const WD = 'com.docker.compose.project.working_dir';
const stripSlash = (p: string) => p.replace(/(.)\/+$/, '$1');

/**
 * Portainer runs compose stacks from /data/compose/<id> (its data volume); swarm stacks carry com.docker.stack.namespace and
 * some Portainer setups add io.portainer.* labels. Any of these, or a working directory other than projectDir, or no compose
 * labels at all: foreign.
 */
export function classifyStack(labels: unknown, projectDir: string): StackOrigin {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return { stack: 'foreign', manager: null, reason: 'no_labels' };
  const l = labels as Record<string, unknown>;
  const wd = typeof l[WD] === 'string' ? stripSlash(l[WD] as string) : '';
  const portainer = /^\/data\/compose\/[^/]+/.test(wd) || Object.keys(l).some((k) => k.startsWith('io.portainer.') || k === 'com.docker.stack.namespace');
  if (portainer) return { stack: 'foreign', manager: 'portainer', reason: 'portainer' };
  if (!wd) return { stack: 'foreign', manager: null, reason: 'no_labels' };
  if (wd !== stripSlash(projectDir)) return { stack: 'foreign', manager: null, reason: 'working_dir' };
  return { stack: 'own', manager: null, reason: 'own' };
}

/** "" and 0.0.0.0 both mean every IPv4 address to Docker; IPv6 may come with brackets */
const normIp = (ip: unknown) => { const s = typeof ip === 'string' ? ip.trim().replace(/^\[(.*)\]$/, '$1') : ''; return s === '0.0.0.0' ? '' : s.toLowerCase(); };
const portKey = (ip: unknown, published: unknown, target: unknown, proto: unknown) =>
  `${normIp(ip)}:${published === undefined || published === null ? '' : String(published).trim()}:${String(target).trim()}/${typeof proto === 'string' && proto ? proto.toLowerCase() : 'tcp'}`;

/** published ports of a rendered service (long syntax, as `compose config --format json` prints them), sorted; null = unreadable */
export function renderedPorts(svc: unknown): string[] | null {
  const ports = (svc as { ports?: unknown } | null)?.ports;
  if (ports === undefined || ports === null) return [];
  if (!Array.isArray(ports)) return null;
  const out: string[] = [];
  for (const p of ports) {
    if (!p || typeof p !== 'object') return null;
    const x = p as Record<string, unknown>;
    if (x.target === undefined || x.target === null || x.target === '') return null;
    out.push(portKey(x.host_ip, x.published, x.target, x.protocol));
  }
  return out.sort();
}

/** HostConfig.PortBindings of a container ({"3000/tcp": [{HostIp, HostPort}]}), sorted; null = unreadable */
export function runningPorts(bindings: unknown): string[] | null {
  if (bindings === null || bindings === undefined) return [];
  if (typeof bindings !== 'object' || Array.isArray(bindings)) return null;
  const out: string[] = [];
  for (const [k, v] of Object.entries(bindings as Record<string, unknown>)) {
    const m = /^([0-9]{1,5}(?:-[0-9]{1,5})?)(?:\/([a-z]+))?$/i.exec(k);
    if (!m) return null;
    if (v === null || v === undefined) continue;
    if (!Array.isArray(v)) return null;
    for (const b of v) {
      const x = (b ?? {}) as Record<string, unknown>;
      out.push(portKey(x.HostIp, x.HostPort, m[1], m[2]));
    }
  }
  return out.sort();
}

/**
 * The Docker network names a rendered service joins, sorted: the service's keys resolved through the top-level `networks`
 * (compose prints each with its full name: <project>_<key>, or the external name), `<project>_default` without any,
 * network_mode none/host/bridge as such. null = not comparable (network_mode service:/container:, unknown project name).
 */
export function renderedNetworks(svc: unknown, top: unknown, project: string | null): string[] | null {
  const s = (svc ?? {}) as { networks?: unknown; network_mode?: unknown };
  if (typeof s.network_mode === 'string' && s.network_mode) {
    return ['none', 'host', 'bridge'].includes(s.network_mode) ? [s.network_mode] : null;
  }
  const keys = Array.isArray(s.networks) ? s.networks.filter((k): k is string => typeof k === 'string')
    : s.networks && typeof s.networks === 'object' ? Object.keys(s.networks) : ['default'];
  const t = (top && typeof top === 'object' ? top : {}) as Record<string, { name?: unknown } | null>;
  const names: string[] = [];
  for (const k of keys.length ? keys : ['default']) {
    const n = t[k]?.name;
    if (typeof n === 'string' && n) names.push(n);
    else if (project) names.push(`${project}_${k}`);
    else return null;
  }
  return [...new Set(names)].sort();
}

/** NetworkSettings.Networks of a container: its network names, sorted; null = unreadable */
export function runningNetworks(networks: unknown): string[] | null {
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)) return null;
  return Object.keys(networks).sort();
}

export interface RunningConfig { ports: unknown; networks: unknown; project: string | null }

/**
 * Does recreating `service` from this rendered config change its published ports or its networks? 'ports' / 'networks' when
 * it would, null when it would not or a side cannot be read (that side is then not compared).
 */
export function configDrift(cfg: unknown, service: string, running: RunningConfig): 'ports' | 'networks' | null {
  const c = (cfg ?? {}) as { name?: unknown; networks?: unknown; services?: Record<string, unknown> };
  const svc = c.services?.[service];
  if (!svc) return null;
  const rp = renderedPorts(svc), xp = runningPorts(running.ports);
  if (rp && xp && rp.join(',') !== xp.join(',')) return 'ports';
  const project = typeof c.name === 'string' && c.name ? c.name : running.project;
  const rn = renderedNetworks(svc, c.networks, project), xn = runningNetworks(running.networks);
  if (rn && xn && rn.join(',') !== xn.join(',')) return 'networks';
  return null;
}
