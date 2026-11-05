#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks webos/app/appinfo.json and webos/probe/appinfo.json: id, title, version format, exact key set, fixed values and
// icon/splash pixel sizes. Exit 1 with the list of problems.
import { existsSync, readFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** the exact key set of an appinfo.json */
export const ALLOWED_KEYS = [
  'id', 'version', 'vendor', 'type', 'main', 'title', 'icon', 'largeIcon', 'splashBackground', 'bgColor', 'resolution',
  'disableBackHistoryAPI', 'uiRevision',
];

const FIXED = {
  vendor: 'FriendFlix', type: 'web', main: 'index.html', icon: 'icon.png', largeIcon: 'largeIcon.png', splashBackground: 'splash.png',
  bgColor: '#0b0b10', resolution: '1920x1080', disableBackHistoryAPI: true, uiRevision: 2,
};

export const APPS = {
  app: { id: 'com.friendflix.tv', title: 'FriendFlix', extra: [['icon-400.png', 400, 400]] },
  probe: { id: 'com.friendflix.tv.probe', title: 'FriendFlix Test', extra: [] },
};

/** [file key, expected width, expected height] */
const IMAGES = [['icon', 80, 80], ['largeIcon', 130, 130], ['splashBackground', 1920, 1080]];

/** a PNG file's width and height from its IHDR chunk, or null */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function checkImage(dir, file, width, height, problems) {
  const path = join(dir, file);
  const size = existsSync(path) ? pngSize(readFileSync(path)) : null;
  if (!size) problems.push(`${file} missing or not a PNG`);
  else if (size.width !== width || size.height !== height) problems.push(`${file} is ${size.width}x${size.height}, expected ${width}x${height}`);
}

/** problems found in one parsed appinfo.json (empty = fine); `dir` is the folder holding it and its images */
export function checkAppinfo(json, dir) {
  const problems = [];
  const app = APPS[basename(dir)] ?? APPS.app;
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return ['appinfo.json is not an object'];
  for (const k of Object.keys(json)) if (!ALLOWED_KEYS.includes(k)) problems.push(`unknown key "${k}"`);
  for (const k of ALLOWED_KEYS) if (!(k in json)) problems.push(`key "${k}" missing`);
  if (json.id !== app.id) problems.push(`id is "${json.id}", expected "${app.id}"`);
  if (json.title !== app.title) problems.push(`title is "${json.title}", expected "${app.title}"`);
  if (typeof json.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(json.version)) problems.push('version must be X.Y.Z');
  for (const [k, v] of Object.entries(FIXED)) if (k in json && json[k] !== v) problems.push(`${k} must be ${JSON.stringify(v)}`);
  for (const [key, w, h] of IMAGES) if (typeof json[key] === 'string') checkImage(dir, json[key], w, h, problems);
  for (const [file, w, h] of app.extra) checkImage(dir, file, w, h, problems);
  if (!existsSync(join(dir, 'index.html'))) problems.push('index.html missing');
  return problems;
}

export function run(root = dirname(fileURLToPath(import.meta.url))) {
  const problems = [];
  for (const name of Object.keys(APPS)) {
    const dir = join(root, name);
    const file = join(dir, 'appinfo.json');
    if (!existsSync(file)) { problems.push(`${name}: appinfo.json missing`); continue; }
    let json;
    try { json = JSON.parse(readFileSync(file, 'utf8')); } catch { problems.push(`${name}: appinfo.json is not valid JSON`); continue; }
    for (const p of checkAppinfo(json, dir)) problems.push(`${name}: ${p}`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = run();
  if (problems.length) {
    for (const p of problems) console.error('webos config: ' + p);
    process.exit(1);
  }
  console.log('webos config: ok');
}
