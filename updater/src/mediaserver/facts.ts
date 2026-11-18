// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Engine } from './engine.js';

export interface EngineFacts {
  api: string | null; logs: boolean; arch: string | null; nvidia: boolean; dockerRoot: string | null;
  project: string | null; mediaNetwork: string | null; egressNetwork: string | null; stackDir: string | null; selfImage: string | null;
  reason: null | 'engine_old' | 'no_logs' | 'no_project' | 'no_network';
}

const PROJECT = 'com.docker.compose.project';
type Obj = Record<string, unknown>;
const labelsOf = (c: Obj | null): Record<string, string> => {
  const l = (c?.Config as Obj | undefined)?.Labels;
  return l && typeof l === 'object' ? (l as Record<string, string>) : {};
};

/** what the engine and the own stack allow; `reason` is the first thing that stops the managed media server (priority engine_old, no_logs, no_project, no_network) */
export async function readFacts(engine: Engine, self: string | undefined): Promise<EngineFacts> {
  const f: EngineFacts = { api: null, logs: false, arch: null, nvidia: false, dockerRoot: null, project: null, mediaNetwork: null, egressNetwork: null, stackDir: null, selfImage: null, reason: null };
  const n = await engine.negotiate();
  f.api = n.api;
  if (!n.ok) return { ...f, reason: 'engine_old' };
  const [ver, info, logs, own] = await Promise.all([
    engine.version(), engine.info(), self ? engine.logsAllowed(self) : Promise.resolve(false), self ? engine.inspectContainer(self) : Promise.resolve(null),
  ]);
  f.arch = ver.arch || null;
  f.nvidia = info.nvidia;
  f.dockerRoot = info.dockerRoot || null;
  f.logs = logs;
  f.project = labelsOf(own)[PROJECT] ?? null;
  f.selfImage = typeof own?.Image === 'string' ? own.Image : null;
  if (!f.logs) return { ...f, reason: 'no_logs' };
  if (!f.project) return { ...f, reason: 'no_project' };

  const nets = await Promise.all((['media', 'egress'] as const).map((k) => engine.listNetworks({ [PROJECT]: f.project!, 'com.docker.compose.network': k })));
  f.mediaNetwork = nets[0]![0]?.name ?? null;
  f.egressNetwork = nets[1]![0]?.name ?? null;
  const peers = await Promise.all(['backend', 'gateway'].map(async (service) => {
    const c = (await engine.listContainers({ [PROJECT]: f.project!, 'com.docker.compose.service': service }, true))[0];
    return c ? { id: c.id, labels: c.labels } : null;
  }));
  f.stackDir = peers[0]?.labels['com.docker.compose.project.working_dir'] ?? null;
  const attached = new Set(nets[0]![0]?.containers ?? []);
  if (!f.mediaNetwork || peers.some((p) => !p || !attached.has(p.id))) return { ...f, reason: 'no_network' };
  return f;
}

