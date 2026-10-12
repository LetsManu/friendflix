import { describe, expect, it } from 'vitest';
import { clientAddress, isHomeAddress, isHomeRequest } from '../src/netaddr.js';

const HOME = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10'];
const req = (headers: Record<string, string>, peer?: string) => ({ headers, socket: { remoteAddress: peer } });

describe('isHomeAddress', () => {
  it.each(['10.1.2.3', '192.168.0.5', '127.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.2', '::ffff:c0a8:0102', '172.31.255.1'])('%s is home', (ip) => {
    expect(isHomeAddress(ip, HOME)).toBe(true);
  });
  it.each(['8.8.8.8', '2001:db8::1', '', 'unknown', '172.32.0.1', '::ffff:8.8.8.8', '999.1.1.1', 'not-an-ip'])('%s is remote', (ip) => {
    expect(isHomeAddress(ip, HOME)).toBe(false);
  });
  it('ignores broken CIDRs and an empty list', () => {
    expect(isHomeAddress('10.0.0.1', ['garbage', '10.0.0.0/99', '10.0.0.0/8'])).toBe(true);
    expect(isHomeAddress('10.0.0.1', [])).toBe(false);
  });
});

describe('clientAddress', () => {
  it('prefers x-real-ip, then the LAST x-forwarded-for entry, then the socket peer', () => {
    expect(clientAddress(req({ 'x-real-ip': '203.0.113.1', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '10.0.0.1'))).toBe('203.0.113.1');
    expect(clientAddress(req({ 'x-forwarded-for': '192.168.1.10, 203.0.113.9' }, '10.0.0.1'))).toBe('203.0.113.9');
    expect(clientAddress(req({}, '10.0.0.1'))).toBe('10.0.0.1');
    expect(clientAddress(req({}))).toBe('unknown');
  });
});

describe('isHomeRequest', () => {
  it('without a forwarding header only loopback is home (a docker bridge peer is remote)', () => {
    expect(isHomeRequest(req({}, '127.0.0.1'), HOME)).toBe(true);
    expect(isHomeRequest(req({}, '::1'), HOME)).toBe(true);
    expect(isHomeRequest(req({}, '172.18.0.5'), HOME)).toBe(false);
    expect(isHomeRequest(req({}, '192.168.1.5'), HOME)).toBe(false);
  });
  it('with a forwarding header the derived address decides', () => {
    expect(isHomeRequest(req({ 'x-real-ip': '192.168.1.10' }, '203.0.113.1'), HOME)).toBe(true);
    expect(isHomeRequest(req({ 'x-forwarded-for': '192.168.1.10, 203.0.113.9' }, '127.0.0.1'), HOME)).toBe(false);
  });
});
