// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { internalSecret, need, optional } from './env.js';
import { createGateway } from './gateway.js';
import { watchUntrustedHost } from './peers.js';
import { createRemoteConfig } from './remoteConfig.js';
import { bindUpstream, checkUpstreamConfig, remoteKeys, selectUpstream } from './upstream/index.js';

const upstream = selectUpstream(process.env.MEDIA_SERVER);
checkUpstreamConfig(upstream, process.env); // like the backend's config validation: refuse to start with a clear error
const backendUrl = need(process.env, 'BACKEND_URL');
const secret = internalSecret(process.env); // env, INTERNAL_SECRET_FILE or the bootstrap-gateway volume
// the media server URL: the adapter's env (JELLYFIN_URL or _FILE) wins and is used as is; otherwise the backend's live settings
// + keys (credentials such as PLEX_TOKEN the env does not pin come from the backend too) and the adapter bound to them and the secret
const remote = createRemoteConfig({ backendUrl, internalSecret: secret, envUrl: optional(process.env, upstream.urlEnv), keys: remoteKeys(upstream, process.env) });
const bound = bindUpstream(upstream, process.env, secret, remote);
const livetvUrl = optional(process.env, 'LIVETV_URL') ?? 'http://livetv:8090';
// livetv never proxies a client: its own address is no trusted proxy, whatever X-Real-IP it sends (review L2/L3)
const livetvPeer = watchUntrustedHost(URL.canParse(livetvUrl) ? new URL(livetvUrl).hostname : '');
// the first lookup finishes (bounded: a hanging resolver must not block startup) before the first request; the <= 15 s window after a livetv restart (new IP) is accepted
await Promise.race([livetvPeer.ready, new Promise<void>((r) => setTimeout(r, 3000).unref())]);
const { server } = createGateway({
  upstream: bound,
  fetchImpl: bound.wrapFetch?.(fetch), // Plex error answers reach clients opaque
  upstreamUrl: remote.url,
  onConfigRev: remote.noteRev,
  backendUrl,
  internalSecret: secret,
  downloadDir: process.env.DOWNLOAD_DIR || undefined,
  livetvUrl,
  metricsToken: process.env.METRICS_TOKEN || undefined,
});
const port = Number(process.env.PORT ?? 4000);
server.listen(port, '0.0.0.0', () => console.log(`gateway listening on :${port}`));
process.on('SIGTERM', () => {
  remote.stop();
  livetvPeer.stop();
  server.close(() => process.exit(0));
  server.closeIdleConnections(); // keep-alive sockets would otherwise hold close() open
  setTimeout(() => process.exit(0), 8000).unref(); // hard fallback for in-flight streams
});
