// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Regenerates test-vectors/brand-colors.json from the backend's derivation (backend/src/brand/colors.ts): the targets from its
 * constants, and for each accent already in the file (plus any given on the command line) its tokens and `adjusted`. The notes are kept.
 * Run after a change of the derivation, then run both ports' tests (backend brand-colors.test.ts, web brand.test.ts):
 *   npx tsx scripts/brand-colors-vectors.ts [#rrggbb "note"]…
 *   npx tsx scripts/brand-colors-vectors.ts --check   (exits 1 when the file is not what the derivation gives)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACC_FILL_ON, ACC_LIGHT_ON, ACC_LINE_ON, ACC_TEXT_ON, deriveTokens } from '../backend/src/brand/colors.ts';

const file = fileURLToPath(new URL('../test-vectors/brand-colors.json', import.meta.url));
const old = JSON.parse(readFileSync(file, 'utf8')) as { vectors: Array<{ accent: string; note?: string }> };
const args = process.argv.slice(2);
const check = args[0] === '--check';
const extra: Array<{ accent: string; note?: string }> = [];
for (let i = check ? 1 : 0; i < args.length; i++) {
  const accent = args[i]!.toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(accent)) throw new Error(`not a #rrggbb colour: ${args[i]}`);
  const note = args[i + 1] && !args[i + 1]!.startsWith('#') ? args[++i] : undefined;
  if (!old.vectors.some((v) => v.accent === accent)) extra.push({ accent, ...(note ? { note } : {}) });
}

const line = (v: { accent: string; note?: string }) => {
  const { adjusted, ...tokens } = deriveTokens(v.accent);
  return `    ${JSON.stringify({ accent: v.accent, ...(v.note ? { note: v.note } : {}), adjusted, tokens }).replace(/([:,])(?=[{"\w#])/g, '$1 ').replace(/\{"/g, '{ "').replace(/"\}/g, '" }').replace(/\}\}/g, '} }').replace(/(true|false)\}/g, '$1 }')}`;
};
const target = (on: string | readonly string[], min: number) => `{ "on": ${Array.isArray(on) ? `[${on.map((x) => `"${x}"`).join(', ')}]` : `"${on}"`}, "min": ${min} }`;
const out = `{
  "targets": {
    "accText": ${target(ACC_TEXT_ON, 4.5)},
    "accFill": ${target(ACC_FILL_ON, 4.5)},
    "accLight": ${target(ACC_LIGHT_ON, 4.5)},
    "accLine": ${target(ACC_LINE_ON, 3)}
  },
  "vectors": [
${[...old.vectors, ...extra].map(line).join(',\n')}
  ]
}
`;
JSON.parse(out); // well-formed
if (check) {
  if (readFileSync(file, 'utf8') !== out) { console.error('test-vectors/brand-colors.json is not what the derivation gives: run npx tsx scripts/brand-colors-vectors.ts'); process.exit(1); }
} else writeFileSync(file, out);
