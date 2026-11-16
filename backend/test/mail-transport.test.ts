// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { isMailAddress, mailSubkey, maskAddress, recipientKey } from '../src/mail/address.js';
import { parseSettingValue, settingDef } from '../src/settings/registry.js';
import { classifyMailError, createMailTransport, MailError, mailConfigured, probeMail, setMailTestCa, transportOptions } from '../src/mail/transport.js';
import { cfg, ENC_KEY } from './helpers.js';
import { SMTP_CERT, startSmtp, type SmtpFake } from './smtpfake.js';

// The SMTP transport (mail stage A, Task 1): options that never log and always verify, the connection probe and the error classes,
// against a real SMTP server (smtp-server) on 127.0.0.1 with a test-only certificate.
const ANNA = 'anna@friend.example.com';
const FROM = 'kino@friend.example.com';
const mailCfg = (port: number, patch: Partial<Config> = {}): Config => ({
  ...cfg, MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: port, MAIL_SMTP_TLS: 'starttls', MAIL_SMTP_USER: 'anna', MAIL_SMTP_PASSWORD: 'pw-1', MAIL_FROM: FROM, ...patch,
});
const message = { from: FROM, to: ANNA, subject: 'Test', text: 'Hallo Anna' };

let fake: SmtpFake | undefined;
const start = async (o: Parameters<typeof startSmtp>[0]) => (fake = await startSmtp(o));

beforeAll(() => setMailTestCa(SMTP_CERT));
afterAll(() => setMailTestCa(null));
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  vi.restoreAllMocks();
});

describe('transport options', () => {
  it('options never log and always verify', () => {
    const o = transportOptions(mailCfg(587)) as Record<string, any>;
    expect(o).toMatchObject({ logger: false, debug: false, requireTLS: true, name: 'portal.example.com', pool: true, maxConnections: 1, maxMessages: 50 });
    expect(o.secure).toBeFalsy();
    expect(o).not.toHaveProperty('rejectUnauthorized');
    expect(o.tls).not.toHaveProperty('rejectUnauthorized');
    expect(o.tls.minVersion).toBe('TLSv1.2');
    expect([o.connectionTimeout, o.greetingTimeout, o.socketTimeout]).toEqual([10_000, 10_000, 30_000]);
    expect(o.auth).toEqual({ user: 'anna', pass: 'pw-1' });
    // implicit TLS; the probe's 5 s (or the caller's smaller limit); no PUBLIC_URL: a reserved EHLO name
    expect(transportOptions(mailCfg(465, { MAIL_SMTP_TLS: 'tls' }))).toMatchObject({ secure: true });
    expect(transportOptions(mailCfg(465, { MAIL_SMTP_TLS: 'tls' })).requireTLS).toBeFalsy();
    const probe = transportOptions(mailCfg(587), { probe: true }) as Record<string, any>;
    expect([probe.connectionTimeout, probe.greetingTimeout, probe.socketTimeout]).toEqual([5_000, 5_000, 5_000]);
    const quick = transportOptions(mailCfg(587), { probe: true, timeoutMs: 1_200 }) as Record<string, any>;
    expect([quick.connectionTimeout, quick.greetingTimeout, quick.socketTimeout]).toEqual([1_200, 1_200, 1_200]);
    expect(transportOptions(mailCfg(587, { PUBLIC_URL: '' })).name).toBe('friendflix.invalid');
    // a relay without login: no auth at all
    expect(transportOptions(mailCfg(25, { MAIL_SMTP_TLS: 'none', MAIL_SMTP_USER: undefined, MAIL_SMTP_PASSWORD: undefined }))).not.toHaveProperty('auth');
    expect(createMailTransport(mailCfg(587)).options).toMatchObject({ logger: false, debug: false });
  });

  it('configured means host and sender; not configured is refused', async () => {
    expect(mailConfigured(cfg)).toBe(false);
    expect(mailConfigured(mailCfg(587))).toBe(true);
    expect(mailConfigured(mailCfg(587, { MAIL_FROM: undefined }))).toBe(false);
    expect(mailConfigured(mailCfg(587, { MAIL_SMTP_HOST: undefined }))).toBe(false);
    expect(() => transportOptions(cfg)).toThrow(MailError);
    try {
      transportOptions(cfg);
    } catch (e) {
      expect((e as MailError).failure).toEqual({ code: 'not_configured', smtp: null, scope: 'transport', permanent: false });
      expect((e as MailError).message).toBe('not_configured');
    }
    expect(await probeMail(cfg)).toEqual({ ok: false, code: 'invalid', detail: 'not_set' });
  });

  it('none with credentials is refused', async () => {
    const plain = mailCfg(25, { MAIL_SMTP_TLS: 'none', MAIL_SMTP_USER: 'anna' });
    let err: unknown;
    try {
      transportOptions(plain);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).failure.code).toBe('insecure_auth');
    expect(classifyMailError(err)).toEqual((err as MailError).failure);
    expect(await probeMail(plain)).toEqual({ ok: false, code: 'invalid', detail: 'insecure_auth' });
    // a password alone is a credential too
    expect(() => transportOptions(mailCfg(25, { MAIL_SMTP_TLS: 'none', MAIL_SMTP_USER: undefined }))).toThrow('insecure_auth');
  });

  it('a password without a user is not silently dropped', async () => {
    for (const mode of ['starttls', 'tls'] as const) {
      const noUser = mailCfg(587, { MAIL_SMTP_TLS: mode, MAIL_SMTP_USER: undefined });
      expect(() => transportOptions(noUser), mode).toThrow('no_user');
      expect(await probeMail(noUser), mode).toEqual({ ok: false, code: 'invalid', detail: 'no_user' });
    }
  });

  it('an IPv6 host is passed to nodemailer without brackets', () => {
    // the setting stores an IPv6 literal bracketed (hostSchema); nodemailer would look `[2001:db8::1]` up in DNS
    const stored = parseSettingValue(settingDef('MAIL_SMTP_HOST')!, '2001:db8::1');
    expect(stored).toEqual({ ok: true, value: '[2001:db8::1]' });
    expect(transportOptions(mailCfg(587, { MAIL_SMTP_HOST: '[2001:db8::1]' })).host).toBe('2001:db8::1');
    expect(transportOptions(mailCfg(587, { MAIL_SMTP_HOST: '[::ffff:192.0.2.10]' })).host).toBe('::ffff:192.0.2.10');
    expect(transportOptions(mailCfg(587, { MAIL_SMTP_HOST: 'mail.example.com' })).host).toBe('mail.example.com');
    expect(transportOptions(mailCfg(587, { MAIL_SMTP_HOST: '192.0.2.10' })).host).toBe('192.0.2.10');
  });
});

describe('probeMail against an SMTP server', () => {
  it('probe ok on starttls with login', async () => {
    const s = await start({ mode: 'starttls', user: 'anna', pass: 'pw-1' });
    expect(await probeMail(mailCfg(s.port))).toEqual({ ok: true, code: 'ok' });
    expect(s.messages.length).toBe(0);
    expect(s.auths).toBe(1);
  });

  it('probe ok on implicit tls', async () => {
    const s = await start({ mode: 'tls', user: 'anna', pass: 'pw-1' });
    expect(await probeMail(mailCfg(s.port, { MAIL_SMTP_TLS: 'tls' }))).toEqual({ ok: true, code: 'ok' });
    expect(s.messages.length).toBe(0);
  });

  it('probe ok on a plain relay without login', async () => {
    const s = await start({ mode: 'none' });
    expect(await probeMail(mailCfg(s.port, { MAIL_SMTP_TLS: 'none', MAIL_SMTP_USER: undefined, MAIL_SMTP_PASSWORD: undefined }))).toEqual({ ok: true, code: 'ok' });
    expect(s.auths).toBe(0);
  });

  it('wrong password is auth', async () => {
    const s = await start({ mode: 'starttls', user: 'anna', pass: 'pw-1' });
    expect(await probeMail(mailCfg(s.port, { MAIL_SMTP_PASSWORD: 'wrong' }))).toEqual({ ok: false, code: 'unauthorized' });
  });

  it('starttls without STARTTLS fails with tls and never authenticates', async () => {
    const s = await start({ mode: 'starttls', user: 'anna', pass: 'pw-1', noStarttls: true });
    expect(await probeMail(mailCfg(s.port))).toEqual({ ok: false, code: 'invalid', detail: 'tls' });
    expect(s.auths).toBe(0);
  });

  it('untrusted certificate fails with tls', async () => {
    const s = await start({ mode: 'starttls', user: 'anna', pass: 'pw-1' });
    setMailTestCa(null);
    try {
      expect(await probeMail(mailCfg(s.port))).toEqual({ ok: false, code: 'invalid', detail: 'tls' });
      expect(s.auths).toBe(0);
      const t = await start({ mode: 'tls', user: 'anna', pass: 'pw-1' });
      expect(await probeMail(mailCfg(t.port, { MAIL_SMTP_TLS: 'tls' }))).toEqual({ ok: false, code: 'invalid', detail: 'tls' });
      await s.close();
    } finally {
      setMailTestCa(SMTP_CERT);
    }
  });

  it('closed port is unreachable', async () => {
    const s = await startSmtp({ mode: 'starttls' });
    const port = s.port;
    await s.close();
    expect(await probeMail(mailCfg(port))).toEqual({ ok: false, code: 'unreachable' });
  });

  it('a server that never greets times out', async () => {
    const silent: Server = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const port = (silent.address() as AddressInfo).port;
      expect(await probeMail(mailCfg(port), { timeoutMs: 300 })).toEqual({ ok: false, code: 'timeout' });
    } finally {
      silent.close();
    }
  });
});

describe('sending and error classes', () => {
  it('sends through the pooled transport', async () => {
    const s = await start({ mode: 'starttls', user: 'anna', pass: 'pw-1' });
    const t = createMailTransport(mailCfg(s.port));
    try {
      await t.sendMail(message);
    } finally {
      t.close();
    }
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ from: FROM, to: [ANNA] });
    expect(s.messages[0]!.raw).toContain('Hallo Anna');
  });

  it('classify 550 at RCPT is a permanent recipient refusal', async () => {
    let status = 550;
    const s = await start({ mode: 'starttls', user: 'anna', pass: 'pw-1', rcpt: () => status });
    const send = async () => {
      const t = createMailTransport(mailCfg(s.port));
      try {
        await t.sendMail(message);
        return null;
      } catch (e) {
        return e;
      } finally {
        t.close();
      }
    };
    expect(classifyMailError(await send())).toEqual({ code: 'recipient_refused', smtp: 550, scope: 'message', permanent: true });
    status = 450;
    expect(classifyMailError(await send())).toEqual({ code: 'recipient_refused', smtp: 450, scope: 'message', permanent: false });
    expect(s.messages).toHaveLength(0);
  });

  it('classifies by code and command, never by reply text', () => {
    const e = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('550 5.1.1 secret reply text for anna@friend.example.com'), { code, ...extra });
    expect(classifyMailError(e('EAUTH', { responseCode: 535, command: 'AUTH PLAIN' }))).toEqual({ code: 'auth', smtp: 535, scope: 'transport', permanent: false });
    expect(classifyMailError(e('EENVELOPE', { responseCode: 553, command: 'MAIL FROM' }))).toEqual({ code: 'sender_refused', smtp: 553, scope: 'message', permanent: true });
    expect(classifyMailError(e('EMESSAGE', { responseCode: 552, command: 'DATA' }))).toEqual({ code: 'message_refused', smtp: 552, scope: 'message', permanent: true });
    expect(classifyMailError(e('EMESSAGE', { responseCode: 451, command: 'DATA' }))).toEqual({ code: 'message_refused', smtp: 451, scope: 'message', permanent: false });
    expect(classifyMailError(e('ETIMEDOUT'))).toEqual({ code: 'timeout', smtp: null, scope: 'transport', permanent: false });
    expect(classifyMailError(e('ECONNECTION'))).toEqual({ code: 'unreachable', smtp: null, scope: 'transport', permanent: false });
    // a host name that mentions TLS or SSL in a DNS or connection error is no TLS failure
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND smtp.ssl.example.com'), { code: 'EDNS', originalCode: 'ENOTFOUND' });
    expect(classifyMailError(dns).code).toBe('unreachable');
    expect(classifyMailError(Object.assign(new Error('Connection closed by tls.example.com'), { code: 'ECONNECTION' })).code).toBe('unreachable');
    expect(classifyMailError(Object.assign(new Error('self-signed certificate'), { code: 'ESOCKET', originalCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).code).toBe('tls');
    expect(classifyMailError(Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ESOCKET', originalCode: 'ECONNRESET' })).code).toBe('tls');
    expect(classifyMailError(e('ETLS'))).toEqual({ code: 'tls', smtp: null, scope: 'transport', permanent: false });
    expect(classifyMailError('x')).toEqual({ code: 'unexpected', smtp: null, scope: 'transport', permanent: false });
    expect(classifyMailError(e('EWHAT', { responseCode: 'no' }))).toEqual({ code: 'unexpected', smtp: null, scope: 'transport', permanent: false });
  });
});

describe('nothing secret is printed', () => {
  const SECRETS = ['pw-1', Buffer.from('\0anna\0pw-1').toString('base64'), ANNA];
  function spyOutput() {
    const seen: string[] = [];
    const record = (...args: unknown[]) => void seen.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Uint8Array ? Buffer.from(a).toString('utf8') : JSON.stringify(a) ?? String(a))).join(' '));
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(record);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        record(chunk);
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    return seen;
  }
  const leaks = (seen: string[]) => seen.filter((line) => SECRETS.some((s) => line.includes(s)));

  it('the spy sees what a logging transport prints (control: nodemailer with its logger on)', async () => {
    const s = await start({ mode: 'starttls', user: 'anna', pass: 'pw-1' });
    const seen = spyOutput();
    const loud = nodemailer.createTransport({ ...transportOptions(mailCfg(s.port)), pool: false, logger: true, debug: true } as never);
    try {
      await loud.sendMail(message);
    } finally {
      loud.close();
    }
    vi.restoreAllMocks();
    expect(leaks(seen).length).toBeGreaterThan(0);
  });

  it('nothing secret is printed', async () => {
    const s = await start({ mode: 'starttls', user: 'anna', pass: 'pw-1' });
    const seen = spyOutput();
    const ok = createMailTransport(mailCfg(s.port));
    try {
      await ok.sendMail(message);
    } finally {
      ok.close();
    }
    const bad = createMailTransport(mailCfg(s.port, { MAIL_SMTP_PASSWORD: 'pw-1x' }));
    let failure: unknown;
    try {
      await bad.sendMail(message);
    } catch (e) {
      failure = e;
    } finally {
      bad.close();
    }
    const probe = await probeMail(mailCfg(s.port, { MAIL_SMTP_PASSWORD: 'pw-1x' }));
    vi.restoreAllMocks();
    expect(s.messages).toHaveLength(1);
    expect(classifyMailError(failure).code).toBe('auth');
    expect(probe).toEqual({ ok: false, code: 'unauthorized' });
    expect(leaks(seen)).toEqual([]);
    // what leaves the module is the code only
    expect(JSON.stringify(classifyMailError(failure))).not.toMatch(/pw-1|anna/);
  });
});

describe('addresses', () => {
  it('maskAddress cases', () => {
    expect(maskAddress(ANNA)).toBe('a…@friend.example.com');
    expect(maskAddress('x')).toBe('…');
    expect(maskAddress('@friend.example.com')).toBe('…');
    expect(maskAddress('anna@')).toBe('…');
  });

  it('isMailAddress', () => {
    expect(isMailAddress(ANNA)).toBe(true);
    expect(isMailAddress('kein-at')).toBe(false);
    expect(isMailAddress('anna@friend.example.com\r\nBcc: x@friend.example.com')).toBe(false);
  });

  it('recipientKey is the same for one address in any case and spacing; subkeys differ by purpose', () => {
    const key = Buffer.from(ENC_KEY, 'base64');
    const k = recipientKey(key, ANNA);
    expect(recipientKey(key, 'Anna@Friend.example.com ')).toBe(k);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(recipientKey(key, 'other@friend.example.com')).not.toBe(k);
    expect(mailSubkey(key, 'recipient')).toHaveLength(32);
    expect(mailSubkey(key, 'recipient').equals(mailSubkey(key, 'unsubscribe'))).toBe(false);
    expect(mailSubkey(key, 'recipient').equals(key)).toBe(false);
  });
});
