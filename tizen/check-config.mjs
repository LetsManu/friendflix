#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks tizen/app/config.xml and tizen/probe/config.xml: ids, required version, privileges, navigation decision, icon.
// Plain string/regex checks; exit 1 with the list of problems.
import { existsSync, readFileSync, statSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIVILEGES = [
  'http://tizen.org/privilege/internet',
  'http://tizen.org/privilege/tv.inputdevice',
  'http://developer.samsung.com/privilege/avplay',
  'http://tizen.org/privilege/application.launch',
];

/** only the probe reads the TV model (webapis.productinfo) for its line */
export const PROBE_PRIVILEGES = [...PRIVILEGES, 'http://developer.samsung.com/privilege/productinfo'];

export const APPS = [
  { dir: 'app', id: 'FrFlixTV01.FriendFlix', pkg: 'FrFlixTV01', name: 'FriendFlix', privileges: PRIVILEGES },
  { dir: 'probe', id: 'FrFlixPRB1.FriendFlixProbe', pkg: 'FrFlixPRB1', name: 'FriendFlix Probe', privileges: PROBE_PRIVILEGES },
];

const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/** the text without XML comments; repeated until stable, so a comment hidden inside another can't survive */
export function stripComments(xml) {
  let out = xml, prev;
  do { prev = out; out = out.replace(/<!--[\s\S]*?-->/g, ''); } while (out !== prev);
  return out;
}

/** the privilege names a config.xml declares (comments ignored) */
export function privilegesOf(xml) {
  return new Set([...stripComments(xml).matchAll(/<tizen:privilege\s+name="([^"]*)"\s*\/>/g)].map((m) => m[1]));
}

/** problems found in one config.xml text (empty = fine) */
export function checkConfig(xml, app) {
  const problems = [];
  const body = stripComments(xml);
  const application = /<tizen:application\b[^>]*>/.exec(body)?.[0];
  if (!application) problems.push('missing <tizen:application>');
  else {
    const id = attr(application, 'id');
    const pkg = attr(application, 'package');
    if (!/^[0-9a-zA-Z]{10}\.[0-9a-zA-Z]+$/.test(id ?? '')) problems.push(`application id "${id}" is not <10 alphanumerics>.<name>`);
    if (id !== app.id) problems.push(`application id is "${id}", expected "${app.id}"`);
    if (pkg !== app.pkg || !/^[0-9a-zA-Z]{10}$/.test(pkg ?? '')) problems.push(`package is "${pkg}", expected "${app.pkg}" (10 alphanumerics)`);
    if (id && pkg && !id.startsWith(pkg + '.')) problems.push('application id does not start with the package');
    if (attr(application, 'required_version') !== '6.5') problems.push('required_version must be "6.5"');
  }
  const widget = /<widget\b[^>]*>/.exec(body)?.[0] ?? '';
  if (!/^\d+\.\d+\.\d+$/.test(attr(widget, 'version') ?? '')) problems.push('widget version must be X.Y.Z');
  if (!/<name>\s*([^<]*?)\s*<\/name>/.test(body) || /<name>\s*([^<]*?)\s*<\/name>/.exec(body)?.[1] !== app.name) problems.push(`<name> must be "${app.name}"`);
  if (!/<content\s+src="index\.html"\s*\/>/.test(body)) problems.push('<content src="index.html"/> missing');
  if (!/<icon\s+src="icon\.png"\s*\/>/.test(body)) problems.push('<icon src="icon.png"/> missing');
  const allowed = app.privileges ?? PRIVILEGES;
  const declared = privilegesOf(body);
  for (const p of allowed) if (!declared.has(p)) problems.push(`privilege missing: ${p}`);
  for (const name of declared) if (!allowed.includes(name)) problems.push(`unexpected privilege: ${name}`);
  const setting = /<tizen:setting\b[^>]*>/.exec(body)?.[0] ?? '';
  const want = { 'screen-orientation': 'landscape', 'context-menu': 'disable', 'background-support': 'disable', encryption: 'disable', 'install-location': 'auto', 'hwkey-event': 'enable' };
  for (const [k, v] of Object.entries(want)) if (attr(setting, k) !== v) problems.push(`tizen:setting ${k} must be "${v}"`);
  if (!/<access\s+origin="\*"\s+subdomains="true"\s*\/>/.test(body)) problems.push('<access origin="*" subdomains="true"/> missing');
  // documented decision: config.xml is read at install time, so the lock lives in the app code and navigation is "*"
  if (!/<tizen:allow-navigation>\s*\*\s*<\/tizen:allow-navigation>/.test(body)) problems.push('<tizen:allow-navigation>*</tizen:allow-navigation> missing (the lock is enforced in code)');
  if (!/Navigation lock/.test(xml)) problems.push('the navigation decision is not documented in a comment ("Navigation lock")');
  return problems;
}

/** a PNG file's width and height, or null */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function run(root = dirname(fileURLToPath(import.meta.url))) {
  const problems = [];
  for (const app of APPS) {
    const dir = join(root, app.dir);
    const cfg = join(dir, 'config.xml');
    if (!existsSync(cfg)) { problems.push(`${app.dir}: config.xml missing`); continue; }
    for (const p of checkConfig(readFileSync(cfg, 'utf8'), app)) problems.push(`${app.dir}: ${p}`);
    const icon = join(dir, 'icon.png');
    const size = existsSync(icon) && statSync(icon).isFile() ? pngSize(readFileSync(icon)) : null;
    if (!size) problems.push(`${app.dir}: icon.png missing or not a PNG`);
    else if (size.w !== 512 || size.h !== 512) problems.push(`${app.dir}: icon.png is ${size.w}x${size.h}, expected 512x512`);
    if (!existsSync(join(dir, 'index.html'))) problems.push(`${app.dir}: index.html missing`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = run();
  if (problems.length) {
    for (const p of problems) console.error('tizen config: ' + p);
    process.exit(1);
  }
  console.log('tizen config: ok');
}
