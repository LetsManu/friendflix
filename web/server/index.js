// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Server entry of the web container (`node server` in the image; locally `node web/server` after `npm run build -w web`). It starts
 * adapter-node's own server unchanged (build/index.js: PORT, HOST, PROTOCOL_HEADER, graceful shutdown, ...) and adds the security
 * headers (headers.js) to every response: adapter-node answers static files and the prerendered /offline page without running
 * hooks.server.ts. The listener is in place before the first request: index.js only starts listening, no request is handled
 * until this module has run.
 */
import { server } from '../build/index.js';
import { installSecurityHeaders } from './headers.js';

installSecurityHeaders(server);
