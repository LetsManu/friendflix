// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { DEFAULT_BRAND, type PublicBrand } from '#lib/brand';
import { contrast, deriveTokens } from '#lib/brandColors';
import {
  BRAND_TABS, FIELD_TAB, LIMITS, PRESETS, charCount, dirtyTabs, fieldError, glowBackground, isDirty, normalizeAccent, previewBrand, ratioRows, ratioText,
  serverFieldError, stagedDiff, uploadErrorText, validate,
} from './model';

afterEach(async () => { await setLocale('de'); });

const base = (over: Partial<PublicBrand> = {}): PublicBrand => ({ ...DEFAULT_BRAND, ...over });

describe('field limits and their messages', () => {
  it('the limits are the backend schema\'s', () => {
    expect(LIMITS).toEqual({ name: 24, byline: 32, shortName: 12, website: 200, about: 280 });
  });

  it('counts characters as a person does: an emoji is one', () => {
    expect(charCount('Kino')).toBe(4);
    expect(charCount('🎬🎬')).toBe(2);
  });

  it('name: required, 1–24 characters, something visible, no control or direction marks', () => {
    expect(fieldError('name', '')).toBe('Bitte einen Namen eingeben.');
    expect(fieldError('name', '   ')).toBe('Bitte einen Namen eingeben.');
    expect(fieldError('name', 'N'.repeat(24))).toBe('');
    expect(fieldError('name', '🎬'.repeat(24))).toBe('');
    expect(fieldError('name', 'N'.repeat(25))).toBe('Höchstens 24 Zeichen.');
    expect(fieldError('name', '⠀')).toBe('Der Name braucht mindestens einen Buchstaben, eine Ziffer oder ein Symbol.');
    expect(fieldError('name', 'Kino‮')).toBe('Enthält Zeichen, die hier nicht gehen (Steuer- oder Richtungszeichen).');
    expect(fieldError('name', 'Kino\nZwei')).toBe('Enthält Zeichen, die hier nicht gehen (Steuer- oder Richtungszeichen).');
    // trimmed like the backend: surrounding spaces do not count
    expect(fieldError('name', `  ${'N'.repeat(24)}  `)).toBe('');
  });

  it('byline ≤ 32, short name ≤ 12, about ≤ 280 (line breaks allowed there only)', () => {
    expect(fieldError('byline', '')).toBe('');
    expect(fieldError('byline', 'b'.repeat(32))).toBe('');
    expect(fieldError('byline', 'b'.repeat(33))).toBe('Höchstens 32 Zeichen.');
    expect(fieldError('shortName', 's'.repeat(12))).toBe('');
    expect(fieldError('shortName', 's'.repeat(13))).toBe('Höchstens 12 Zeichen.');
    expect(fieldError('about', 'a'.repeat(280))).toBe('');
    expect(fieldError('about', 'a'.repeat(281))).toBe('Höchstens 280 Zeichen.');
    expect(fieldError('about', 'Zeile eins\nZeile zwei')).toBe('');
    expect(fieldError('byline', 'by\nAnna')).toBe('Enthält Zeichen, die hier nicht gehen (Steuer- oder Richtungszeichen).');
  });

  it('website: empty, or http(s) without credentials, ≤ 200 characters', () => {
    const msg = 'Bitte eine Adresse mit http:// oder https:// eingeben, ohne Benutzername und Passwort.';
    expect(fieldError('website', '')).toBe('');
    expect(fieldError('website', 'https://kino.example.com')).toBe('');
    expect(fieldError('website', 'ftp://kino.example.com')).toBe(msg);
    expect(fieldError('website', 'kino')).toBe(msg);
    expect(fieldError('website', 'https://anna:geheim@kino.example.com')).toBe(msg);
    expect(fieldError('website', `https://kino.example.com/${'x'.repeat(180)}`)).toBe('Höchstens 200 Zeichen.');
  });

  it('accent: a #rrggbb colour (any case, # optional, #rgb allowed)', () => {
    expect(normalizeAccent('#4C9DFF')).toBe('#4c9dff');
    expect(normalizeAccent('4c9dff')).toBe('#4c9dff');
    expect(normalizeAccent(' #abc ')).toBe('#aabbcc');
    expect(normalizeAccent('blau')).toBeNull();
    expect(normalizeAccent('#12345')).toBeNull();
    expect(fieldError('accent', 'blau')).toBe('Bitte eine Farbe wie #4c9dff eingeben.');
    expect(fieldError('accent', '#4C9DFF')).toBe('');
  });

  it('validate collects every field error; the defaults are valid', () => {
    expect(validate(base())).toEqual({});
    expect(validate(base({ name: '', shortName: 's'.repeat(13), accent: 'x' }))).toEqual({
      name: 'Bitte einen Namen eingeben.', shortName: 'Höchstens 12 Zeichen.', accent: 'Bitte eine Farbe wie #4c9dff eingeben.',
    });
  });

  it('the messages exist in every language', async () => {
    for (const l of ['en', 'es', 'fr', 'it', 'pl', 'tr'] as const) {
      await setLocale(l);
      for (const m of [fieldError('name', ''), fieldError('byline', 'b'.repeat(33)), fieldError('website', 'x'), fieldError('accent', 'x')]) {
        expect(m, l).not.toMatch(/^admin\./);
        expect(m, l).not.toBe('');
      }
      expect(fieldError('byline', 'b'.repeat(33)), l).toContain('32');
    }
  });
});

describe('staged edits', () => {
  it('the diff holds only the changed fields, trimmed, the accent lower-cased', () => {
    const saved = base();
    expect(stagedDiff(saved, base())).toEqual({});
    expect(stagedDiff(saved, base({ name: '  Nordlicht Kino ', accent: '#4C9DFF' }))).toEqual({ name: 'Nordlicht Kino', accent: '#4c9dff' });
    expect(stagedDiff(saved, base({ symbol: 'a'.repeat(64), glow: 'off' }))).toEqual({ symbol: 'a'.repeat(64), glow: 'off' });
    expect(stagedDiff(base({ logo: 'b'.repeat(64) }), base())).toEqual({ logo: null });
  });

  it('isDirty: a change that only adds spaces or changes the case of the colour is none', () => {
    const saved = base({ byline: 'by Anna Beispiel' });
    expect(isDirty(saved, base({ byline: 'by Anna Beispiel' }))).toBe(false);
    expect(isDirty(saved, base({ byline: ' by Anna Beispiel ' }))).toBe(false);
    expect(isDirty(base({ accent: '#4c9dff' }), base({ accent: '#4C9DFF' }))).toBe(false);
    expect(isDirty(saved, base({ byline: '' }))).toBe(true);
    expect(isDirty(saved, base({ byline: 'by Anna Beispiel', header: 'symbol' }))).toBe(true);
  });

  it('an invalid accent while typing is a change (the save shows the error)', () => {
    expect(isDirty(base(), base({ accent: '#4c9d' }))).toBe(true);
  });

  it('every field belongs to one of the three tabs; dirtyTabs names those with changes', () => {
    expect(BRAND_TABS).toEqual(['identity', 'logo', 'colors']);
    expect(Object.keys(FIELD_TAB).sort()).toEqual(Object.keys(DEFAULT_BRAND).sort());
    expect([...dirtyTabs({ name: 'X', glow: 'off' })].sort()).toEqual(['colors', 'identity']);
    expect([...dirtyTabs({ symbol: null })]).toEqual(['logo']);
  });
});

describe('colours', () => {
  it('six presets, coral first (today\'s default)', () => {
    expect(PRESETS.map((p) => p.hex)).toEqual(['#ff4f6d', '#a37cff', '#4c9dff', '#2fc4b2', '#f2b52c', '#5ccf6a']);
    expect(PRESETS[0]!.hex).toBe(DEFAULT_BRAND.accent);
  });

  it('the readout: the backend\'s ratios and "angepasst" when a shade was moved', () => {
    const t = deriveTokens('#f2e94e'); // too light: the text passes, the fill is darkened
    const rows = ratioRows(t);
    expect(rows.map((r) => r.id)).toEqual(['text', 'fill', 'glass']);
    expect(rows[0]!.ratio).toBeCloseTo(contrast(t.accText, '#101418'), 5);
    expect(rows[1]!.ratio).toBeCloseTo(contrast('#ffffff', t.accFill), 5);
    expect(rows[1]!.adjusted).toBe(true);
    for (const r of rows) expect(r.ratio).toBeGreaterThanOrEqual(4.5);
    const dark = ratioRows(deriveTokens('#1a1a40'));
    expect(dark[0]!.adjusted).toBe(true);
    expect(dark[1]!.adjusted).toBe(false);
  });

  it('ratios read in the person\'s language', async () => {
    expect(ratioText(4.54)).toBe('4,5:1');
    await setLocale('en');
    expect(ratioText(4.54)).toBe('4.5:1');
  });

  it('the glow of the preview mirrors app.css per mode, built from colour values only', () => {
    const t = deriveTokens('#4c9dff');
    expect(glowBackground('off', t)).toBe('#0a090d');
    expect(glowBackground('accentViolet', t)).toContain('rgba(76, 157, 255, 0.13)');
    expect(glowBackground('accentViolet', t)).toContain('rgba(78, 64, 190, 0.25)');
    expect(glowBackground('accent', t)).toContain('rgba(0, 111, 244, 0.33)');
    expect(glowBackground('neutral', t)).not.toContain('76, 157, 255');
  });
});

describe('preview brand', () => {
  it('follows the staged values; a half-typed accent keeps the last valid one', () => {
    const p = previewBrand(base({ name: ' Nordlicht Kino ', shortName: '', accent: '#4c9d' }), {}, '#4c9dff');
    expect(p.name).toBe('Nordlicht Kino');
    expect(p.shortName).toBe('Nordlicht Kino');
    expect(p.tokens.accFill).toBe('#006ff4');
    expect(previewBrand(base({ name: '' }), {}).name).toBe('FriendFlix');
    const imgs = previewBrand(base({ symbol: 'c'.repeat(64) }), { symbol: '/api/public/brand/img/x.png', logo: '/l.png' });
    expect(imgs.images).toEqual({ symbol: '/api/public/brand/img/x.png' }); // only images the staged brand refers to
  });
});

describe('server answers', () => {
  it('400 invalid on an image field: upload it again (it was swept before the save)', () => {
    expect(serverFieldError('symbol')).toEqual({ field: 'symbol', text: 'Das hochgeladene Bild ist nicht mehr da, es wurde zu lange nicht gespeichert. Bitte lade es noch einmal hoch.' });
    expect(serverFieldError('name')).toEqual({ field: 'name', text: 'Der Server hat diesen Wert abgelehnt.' });
    expect(serverFieldError('brand')).toBeNull();
  });

  it('upload errors are worded', () => {
    expect(uploadErrorText('too_large')).toBe('Das Bild ist auch verkleinert noch größer als 2 MB.');
    expect(uploadErrorText('unsupported_type')).toBe('Dieses Format geht nicht. Bitte ein PNG-, JPEG- oder WebP-Bild wählen.');
    expect(uploadErrorText('dimensions')).toBe('Die Bildgröße passt nicht.');
    expect(uploadErrorText('corrupt')).toBe('Das Bild ist beschädigt.');
    expect(uploadErrorText('whatever')).toBe('Das Bild konnte nicht hochgeladen werden.');
  });
});
