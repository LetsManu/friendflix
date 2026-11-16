// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';

/** the test-only, self-signed certificate for localhost and 127.0.0.1 (test/fixtures/smtp/README.md) */
export const SMTP_CERT = readFileSync(new URL('./fixtures/smtp/cert.pem', import.meta.url), 'utf8');
const SMTP_KEY = readFileSync(new URL('./fixtures/smtp/key.pem', import.meta.url), 'utf8');

export interface SmtpFakeOptions {
  /** starttls: plain greeting with STARTTLS offered; tls: implicit TLS; none: plain only */
  mode: 'starttls' | 'tls' | 'none';
  /** with user + pass a login is required and checked */
  user?: string;
  pass?: string;
  /** starttls mode without offering STARTTLS (a login in clear would be accepted: the client must not try) */
  noStarttls?: boolean;
  /** an SMTP status to refuse the recipient with (e.g. 550, 450), or null to accept */
  rcpt?: (addr: string) => number | null;
}

export interface SmtpFake {
  port: number;
  messages: Array<{ from: string; to: string[]; raw: string }>;
  /** AUTH attempts the server saw (successful or not) */
  auths: number;
  /** connections the server accepted */
  connections: number;
  close(): Promise<void>;
}

const refuse = (status: number, text: string) => Object.assign(new Error(text), { responseCode: status });

/** A real SMTP server on 127.0.0.1 (a free port) for transport tests; it never logs. */
export async function startSmtp(o: SmtpFakeOptions): Promise<SmtpFake> {
  const login = Boolean(o.user);
  const plain = o.mode === 'none' || o.noStarttls === true;
  const fake: SmtpFake = { port: 0, messages: [], auths: 0, connections: 0, close: async () => undefined };
  const options: SMTPServerOptions = {
    secure: o.mode === 'tls',
    key: SMTP_KEY,
    cert: SMTP_CERT,
    logger: false,
    authOptional: !login,
    // a server without TLS takes a login in clear, so a client that wrongly tries is seen in `auths`
    allowInsecureAuth: plain,
    ...(plain ? { disabledCommands: ['STARTTLS'] } : {}),
    onConnect(_session, cb) {
      fake.connections++;
      cb();
    },
    onAuth(auth, _session, cb) {
      fake.auths++;
      if (login && auth.username === o.user && auth.password === o.pass) cb(null, { user: auth.username });
      else cb(refuse(535, 'Authentication failed'));
    },
    onRcptTo(address, _session, cb) {
      const status = o.rcpt?.(address.address) ?? null;
      if (status === null) cb();
      else cb(refuse(status, 'Recipient refused'));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
        fake.messages.push({ from, to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') });
        cb();
      });
    },
  };
  const server = new SMTPServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.on('error', () => undefined); // a client that drops the connection mid-handshake (an untrusted certificate) is no test failure
  fake.port = (server.server.address() as AddressInfo).port;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}
