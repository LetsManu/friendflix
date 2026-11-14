// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../ctx.js';
import { isTrustedPeer } from '../../netaddr.js';
import { bad, line } from '../line.js';
import type { CheckLine } from '../types.js';

/**
 * The proxy lines the backend sees on this very request (proxy.forwardedProto, proxy.peer): computed per request and merged into the
 * answer, never cached. The other four proxy lines only the browser can measure (web: syscheckBrowser.ts). Neither the peer address nor
 * any header value leaves this file: only the verdict.
 */
export const PROXY_DOCS = 'setup.md#6-nginx-proxy-manager-portal-proxy-host';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function publicUrl(ctx: Ctx): URL | null {
  try { return new URL(ctx.cfg.PUBLIC_URL); } catch { return null; }
}

/**
 * PUBLIC_URL is https but this request reached the backend as plain http: the proxy does not pass `X-Forwarded-Proto` (or the backend
 * does not trust it), so cookies, redirects and passkeys see the wrong scheme. A local PUBLIC_URL (a test install) has no proxy to ask about.
 */
function forwardedProtoLine(req: FastifyRequest, ctx: Ctx): CheckLine {
  const id = 'proxy.forwardedProto';
  const pub = publicUrl(ctx);
  if (!pub || pub.protocol !== 'https:' || LOCAL_HOSTS.has(pub.hostname)) return line(id, 'ok');
  return req.protocol === 'https' ? line(id, 'ok') : bad(id, 'warning', 'proxy_no_proto', { docs: PROXY_DOCS });
}

/** a proxy in front (`X-Forwarded-For`) whose address the backend does not trust: every user shares its address (netaddr.ts) */
function peerLine(req: FastifyRequest): CheckLine {
  const id = 'proxy.peer';
  const forwarded = req.headers['x-forwarded-for'] !== undefined;
  return !forwarded || isTrustedPeer(req.socket.remoteAddress) ? line(id, 'ok') : bad(id, 'warning', 'proxy_untrusted_peer', { docs: PROXY_DOCS });
}

export function requestLines(req: FastifyRequest, ctx: Ctx): CheckLine[] {
  return [forwardedProtoLine(req, ctx), peerLine(req)];
}
