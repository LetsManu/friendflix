// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PERMISSIONS_POLICY, crossOriginPath, cspWithSocketHost, installSecurityHeaders, securityHeaders } from './headers.js';

describe('securityHeaders', () => {
  it('nosniff, same-origin referrer/resource/opener policy, no framing and the permissions policy; never COEP', () => {
    expect(securityHeaders('/browse?x=1')).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'permissions-policy': PERMISSIONS_POLICY,
      'cross-origin-resource-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin',
      'x-frame-options': 'DENY',
    });
  });

  it('the unsubscribe page sends no Referer at all: its address carries the token', () => {
    for (const u of ['/mail/unsubscribe', '/mail/unsubscribe?t=v1.x', '/mail/unsubscribe/']) expect(securityHeaders(u)['referrer-policy'], u).toBe('no-referrer');
    for (const u of ['/mail/unsubscribex', '/mail', '/browse?u=/mail/unsubscribe']) expect(securityHeaders(u)['referrer-policy'], u).toBe('same-origin');
  });

  it('opens only the Cast receiver and the cast test clip to other origins', () => {
    for (const u of ['/cast-receiver/', '/cast-receiver', '/cast-receiver/receiver.js', '/cast-test/clip.mp4', '/cast-test/clip.mp4?x=1']) {
      expect(crossOriginPath(u), u).toBe(true);
      expect(securityHeaders(u)['cross-origin-resource-policy']).toBe('cross-origin');
    }
    for (const u of ['/', '/offline', '/_app/immutable/entry/start.js', '/favicon.svg', '/cast-receiverx', '/x/cast-test/clip.mp4', '/browse?u=/cast-test/']) {
      expect(crossOriginPath(u), u).toBe(false);
    }
  });
});

describe('PERMISSIONS_POLICY', () => {
  const entries = Object.fromEntries(PERMISSIONS_POLICY.split(', ').map((e) => e.split('=') as [string, string]));
  it('turns off the hardware and payment features the app does not use', () => {
    for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'hid', 'midi', 'display-capture']) {
      expect(entries[f], f).toBe('()');
    }
  });
  it('keeps the features the app uses for its own origin, and delegates the trailer frame only what its allow attribute asks for', () => {
    const yt = '(self "https://www.youtube-nocookie.com")';
    expect(entries).toMatchObject({ autoplay: yt, fullscreen: yt, 'picture-in-picture': yt, 'encrypted-media': yt, 'screen-wake-lock': '(self)', 'clipboard-write': '(self)' });
    // passkeys and the share buttons keep their default (self): a () here would break them
    for (const f of ['publickey-credentials-get', 'publickey-credentials-create', 'web-share']) expect(entries).not.toHaveProperty(f);
  });
});

describe('cspWithSocketHost', () => {
  const csp = "default-src 'self'; connect-src 'self'; img-src 'self'";
  it('adds this host\'s websocket origins to connect-src (port kept), never a scheme-wide source', () => {
    expect(cspWithSocketHost(csp, new URL('https://friend.example.com/x'))).toBe("default-src 'self'; connect-src 'self' wss://friend.example.com ws://friend.example.com; img-src 'self'");
    expect(cspWithSocketHost(csp, new URL('http://127.0.0.1:4173/'))).toBe("default-src 'self'; connect-src 'self' wss://127.0.0.1:4173 ws://127.0.0.1:4173; img-src 'self'");
    expect(cspWithSocketHost("connect-src 'self'", new URL('http://[::1]:3000/'))).toBe("connect-src 'self' wss://[::1]:3000 ws://[::1]:3000");
  });
  it('leaves a policy without connect-src, and a host that is no plain host name, as it is', () => {
    expect(cspWithSocketHost("connect-src 'self'", new URL('https://friend.example.com./x'))).toBe("connect-src 'self' wss://friend.example.com ws://friend.example.com");
    expect(cspWithSocketHost("connect-src 'self'", new URL('https://friend.example.com.:8443/x'))).toBe("connect-src 'self' wss://friend.example.com:8443 ws://friend.example.com:8443");
    expect(cspWithSocketHost("connect-src 'self'", new URL('https://a..b/'))).toBe("connect-src 'self'");
    expect(cspWithSocketHost("default-src 'self'", new URL('https://p.example/'))).toBe("default-src 'self'");
    expect(cspWithSocketHost(csp, new URL("https://a;script-src'*/"))).toBe(csp);
  });
});

describe('installSecurityHeaders', () => {
  let srv: Server | null = null;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    srv = createServer(handler);
    installSecurityHeaders(srv);
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  };

  it('sets the headers on a response written with writeHead (how adapter-node serves static files), its own values winning', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/own') res.writeHead(200, { 'content-type': 'text/plain', 'x-frame-options': 'SAMEORIGIN' });
      else res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('x');
    });
    const js = await fetch(`${base}/_app/immutable/entry/start.js`);
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(js.headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
    expect(js.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect((await fetch(`${base}/own`)).headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect((await fetch(`${base}/cast-test/clip.mp4`)).headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });
});
