#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders web/static/logo-icon.svg on the shells' dark background into the webOS icon and splash PNGs with the
// pre-installed Playwright Chromium. Run once by hand; the PNGs are committed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import console from 'node:console';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const svg = readFileSync(root + 'web/static/logo-icon.svg', 'utf8');
const BG = '#0b0b10';

/** [file, width, height, logo size as a share of the shorter side] */
const TARGETS = [
  ['icon.png', 80, 80, 0.8],
  ['largeIcon.png', 130, 130, 0.8],
  ['icon-400.png', 400, 400, 0.8],
  ['splash.png', 1920, 1080, 0.36],
];
/** the probe declares the same icons except icon-400.png */
const DIRS = ['app', 'probe'];

const browser = await chromium.launch();
try {
  for (const [file, width, height, share] of TARGETS) {
    const size = Math.round(Math.min(width, height) * share);
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(`<!doctype html><style>html,body{margin:0;width:${width}px;height:${height}px;background:${BG};display:flex;align-items:center;justify-content:center}
svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
    const png = await page.screenshot({ type: 'png' });
    await page.close();
    for (const dir of DIRS) {
      if (dir === 'probe' && file === 'icon-400.png') continue;
      writeFileSync(`${root}webos/${dir}/${file}`, png);
    }
    console.log(`${file} ${width}x${height}`);
  }
} finally {
  await browser.close();
}
