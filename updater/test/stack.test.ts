// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { classifyStack, configDrift, renderedNetworks, renderedPorts, runningNetworks, runningPorts } from '../src/stack.js';

const DIR = '/srv/friendflix';
const L = (over: Record<string, string> = {}) => ({
  'com.docker.compose.project': 'friendflix', 'com.docker.compose.project.working_dir': DIR,
  'com.docker.compose.project.config_files': `${DIR}/compose.prod.yaml`, ...over,
});

describe('classifyStack: whose stack is this', () => {
  it('own: the backend container was created from the updater\'s project directory (a trailing slash is the same directory)', () => {
    expect(classifyStack(L(), DIR)).toEqual({ stack: 'own', manager: null, reason: 'own', workingDir: DIR });
    expect(classifyStack(L({ 'com.docker.compose.project.working_dir': `${DIR}/` }), DIR).stack).toBe('own');
  });

  it('a different working directory alone makes it foreign', () => {
    expect(classifyStack(L({ 'com.docker.compose.project.working_dir': '/opt/other' }), DIR)).toEqual({ stack: 'foreign', manager: null, reason: 'working_dir', workingDir: '/opt/other' });
    // the path is reported only in a plain form (it reaches the admin page)
    expect(classifyStack(L({ 'com.docker.compose.project.working_dir': '/opt/<b>' }), DIR)).toMatchObject({ reason: 'working_dir', workingDir: null });
    expect(classifyStack(L({ 'com.docker.compose.project.working_dir': `${DIR}/sub` }), DIR).stack).toBe('foreign');
    expect(classifyStack(L({ 'com.docker.compose.project.working_dir': '/srv/friendflix2' }), DIR).stack).toBe('foreign');
  });

  it('Portainer: its compose directory (/data/compose/<id>), or Portainer / swarm stack labels, even with a matching directory', () => {
    expect(classifyStack(L({ 'com.docker.compose.project.working_dir': '/data/compose/12', 'com.docker.compose.project.config_files': '/data/compose/12/docker-compose.yml' }), DIR))
      .toEqual({ stack: 'foreign', manager: 'portainer', reason: 'portainer', workingDir: '/data/compose/12' });
    expect(classifyStack(L({ 'io.portainer.accesscontrol.teams': 'x' }), DIR)).toMatchObject({ stack: 'foreign', manager: 'portainer', reason: 'portainer' });
    expect(classifyStack(L({ 'com.docker.stack.namespace': 'friendflix' }), DIR)).toMatchObject({ stack: 'foreign', reason: 'portainer' });
    // the /data/compose marker only matters for a directory other than the updater's own (an install that really lives there is own)
    expect(classifyStack(L({ 'com.docker.compose.project.working_dir': '/data/compose/3' }), '/data/compose/3')).toMatchObject({ stack: 'own', reason: 'own' });
  });

  it('missing or unreadable labels: foreign', () => {
    for (const bad of [null, undefined, 'x', [], {}, { 'com.docker.compose.project': 'friendflix' }, L({ 'com.docker.compose.project.working_dir': '' })]) {
      expect(classifyStack(bad, DIR), JSON.stringify(bad)).toMatchObject({ stack: 'foreign', reason: 'no_labels' });
    }
    // a non-string working dir
    expect(classifyStack({ ...L(), 'com.docker.compose.project.working_dir': 3 }, DIR).stack).toBe('foreign');
  });
});

describe('published ports', () => {
  it('rendered (compose config --format json) and running (HostConfig.PortBindings) in one normal form', () => {
    expect(renderedPorts({ ports: [{ mode: 'ingress', host_ip: '127.0.0.1', target: 3000, published: '3080', protocol: 'tcp' }] })).toEqual(['127.0.0.1:3080:3000/tcp']);
    expect(runningPorts({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3080' }] })).toEqual(['127.0.0.1:3080:3000/tcp']);
  });

  it('normalises what compose and Docker treat as the same: no host ip = 0.0.0.0, default protocol, number vs string, case, IPv6 brackets', () => {
    expect(renderedPorts({ ports: [{ target: 3000, published: 3080 }] })).toEqual(runningPorts({ '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3080' }] }));
    expect(renderedPorts({ ports: [{ host_ip: '', target: '53', published: '53', protocol: 'UDP' }] })).toEqual(runningPorts({ '53/udp': [{ HostIp: '', HostPort: '53' }] }));
    expect(renderedPorts({ ports: [{ host_ip: '[::1]', target: 80, published: '8080' }] })).toEqual(runningPorts({ '80/tcp': [{ HostIp: '::1', HostPort: '8080' }] }));
    // no published port (Docker picks one): both sides empty
    expect(renderedPorts({ ports: [{ target: 80 }] })).toEqual(runningPorts({ '80/tcp': [{ HostIp: '', HostPort: '' }] }));
    // order does not matter
    expect(renderedPorts({ ports: [{ target: 2, published: '2' }, { target: 1, published: '1' }] })).toEqual(runningPorts({ '1/tcp': [{ HostPort: '1' }], '2/tcp': [{ HostPort: '2' }] }));
  });

  it('no ports at all: empty on both sides; null bindings are none', () => {
    expect(renderedPorts({})).toEqual([]);
    expect(runningPorts(null)).toEqual([]);
    expect(runningPorts({})).toEqual([]);
    expect(runningPorts({ '80/tcp': null })).toEqual([]);
  });

  it('a form it cannot read is not comparable (null), never "equal"', () => {
    expect(renderedPorts({ ports: ['127.0.0.1:3080:3000'] })).toBeNull();
    expect(renderedPorts({ ports: 'x' })).toBeNull();
    expect(runningPorts('x')).toBeNull();
    expect(runningPorts({ 'nope': [{ HostPort: '1' }] })).toBeNull();
  });
});

describe('networks', () => {
  const top = { front: { name: 'friendflix_front' }, db: { name: 'friendflix_db', internal: true }, npm: { name: 'proxy', external: true } };
  it('service keys resolve through the top-level names (the project prefix compose adds), compared with the running full names', () => {
    expect(renderedNetworks({ networks: { front: null, db: { aliases: ['x'] } } }, top, 'friendflix')).toEqual(['friendflix_db', 'friendflix_front']);
    expect(runningNetworks({ friendflix_front: {}, friendflix_db: {} })).toEqual(['friendflix_db', 'friendflix_front']);
    // a key without a top-level name is <project>_<key>
    expect(renderedNetworks({ networks: { media: null } }, {}, 'friendflix')).toEqual(['friendflix_media']);
    expect(renderedNetworks({ networks: { media: null } }, { media: {} }, 'friendflix')).toEqual(['friendflix_media']);
    // an external network keeps its own name
    expect(renderedNetworks({ networks: { npm: null } }, top, 'friendflix')).toEqual(['proxy']);
    // list form
    expect(renderedNetworks({ networks: ['front'] }, top, 'friendflix')).toEqual(['friendflix_front']);
  });

  it('default network, network_mode none / host / bridge; service: and container: modes are not comparable', () => {
    expect(renderedNetworks({}, {}, 'friendflix')).toEqual(['friendflix_default']);
    expect(renderedNetworks({ network_mode: 'none' }, {}, 'friendflix')).toEqual(['none']);
    expect(runningNetworks({ none: {} })).toEqual(['none']);
    expect(renderedNetworks({ network_mode: 'host' }, {}, 'friendflix')).toEqual(['host']);
    expect(renderedNetworks({ network_mode: 'bridge' }, {}, 'friendflix')).toEqual(['bridge']);
    expect(renderedNetworks({ network_mode: 'service:vpn' }, {}, 'friendflix')).toBeNull();
    expect(renderedNetworks({ network_mode: 'container:abc' }, {}, 'friendflix')).toBeNull();
    expect(renderedNetworks({}, {}, null)).toBeNull(); // no project name: the default name is unknown
    expect(runningNetworks('x')).toBeNull();
    expect(runningNetworks(null)).toBeNull();
  });
});

describe('configDrift', () => {
  const cfg = (port: string, nets: Record<string, null> = { front: null }) => ({
    name: 'friendflix',
    networks: { front: { name: 'friendflix_front' }, db: { name: 'friendflix_db' } },
    services: { web: { ports: [{ mode: 'ingress', host_ip: port, target: 3000, published: '3080', protocol: 'tcp' }], networks: nets } },
  });
  const running = { ports: { '3000/tcp': [{ HostIp: '192.0.2.7', HostPort: '3080' }] } as unknown, networks: { friendflix_front: {} } as unknown, project: 'friendflix' };

  it('the incident: the files render 127.0.0.1 while the container publishes on the NAS address -> ports differ', () => {
    expect(configDrift(cfg('127.0.0.1'), 'web', running)).toBe('ports');
  });
  it('the same ports and networks: no drift', () => {
    expect(configDrift(cfg('192.0.2.7'), 'web', running)).toBeNull();
  });
  it('another network set: networks differ', () => {
    expect(configDrift(cfg('192.0.2.7', { front: null, db: null }), 'web', running)).toBe('networks');
  });
  it('another project prefix is another network (compose would attach the container elsewhere)', () => {
    expect(configDrift(cfg('192.0.2.7'), 'web', { ...running, networks: { ff_front: {} } })).toBe('networks');
  });
  it('without a name in the rendered file, the running container\'s project names the default prefix', () => {
    const c = { services: { web: { ports: [{ host_ip: '192.0.2.7', target: 3000, published: '3080' }] } } };
    expect(configDrift(c, 'web', { ...running, networks: { friendflix_default: {} } })).toBeNull();
  });
  it('a side it cannot read is skipped (nothing to compare), the readable side still counts', () => {
    expect(configDrift(cfg('127.0.0.1'), 'web', { ...running, networks: 'x' })).toBe('ports');
    expect(configDrift(cfg('192.0.2.7'), 'web', { ...running, ports: 'x' })).toBeNull();
    expect(configDrift({ services: {} }, 'web', running)).toBeNull();
  });
});
