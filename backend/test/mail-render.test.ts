// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveTokens } from '../src/brand/colors.js';
import { readBrand, resetBrand, saveBrand, storeImage } from '../src/brand/repo.js';
import type { Brand } from '../src/brand/schema.js';
import { msg } from '../src/i18n.js';
import { esc, layout, safeHref } from '../src/mail/html.js';
import { mailBrand } from '../src/mail/brand.js';
import { renderMail } from '../src/mail/templates.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Mail stage A, Task 2: the branded layout, the `test` template and the logo rule (inline CID only for a PNG symbol up to 200 KB).

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('mail layout and test template', () => {
  let env: TestEnv;
  let actor: string;
  beforeAll(async () => {
    env = await makeEnv();
    actor = (await env.pool.query<{ id: string }>("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-anna', 'anna@friend.example.com', 'Anna Beispiel', 'admin', $1, 'Anna', 'x') returning id", ['sub-anna'.padEnd(32, '0')])).rows[0]!.id;
  });
  afterAll(() => env.close());
  beforeEach(async () => { await resetBrand(env.ctx.db, actor, (await readBrand(env.ctx.db)).rev); });

  const setBrand = async (patch: Partial<Brand>) => { await saveBrand(env.ctx.db, actor, (await readBrand(env.ctx.db)).rev, patch); };
  /** stores an image row of `size` bytes (the signature decides the type the mail sees) and makes it the brand's symbol */
  const setSymbol = async (head: Buffer, mime: 'image/png' | 'image/webp', size: number) => {
    const bytes = Buffer.concat([head, randomBytes(size - head.length)]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await storeImage(env.ctx.db, { bytes, mime, width: 512, height: 512, hash });
    await setBrand({ symbol: hash });
  };
  const render = (lang: 'de' | 'en' | 'pl' = 'de') => renderMail(env.ctx, 'test', lang, {});

  it('default brand renders the letter tile and no attachment', async () => {
    const r = await render();
    expect(r.attachments).toHaveLength(0);
    expect(r.html).not.toContain('<img');
    expect(r.html).toMatch(/background-color:#d6325a[^>]*>\s*F\s*<\/td>|background-color:#d6325a[^>]*>F</);
    expect(r.html).toContain('>F<');
  });

  it('png symbol under 200 KB is inline', async () => {
    await setSymbol(PNG_SIG, 'image/png', 50_000);
    const r = await render();
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]).toMatchObject({ cid: 'brand-symbol', contentType: 'image/png' });
    expect(r.html).toContain('src="cid:brand-symbol"');
    expect(r.html).toMatch(/width="48" height="48"/);
    expect(r.html).not.toMatch(/<img[^>]+src="http/);
  });

  it('webp symbol falls back to the letter tile', async () => {
    await setSymbol(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), 'image/webp', 5_000);
    const r = await render();
    expect(r.attachments).toHaveLength(0);
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('>F<');
  });

  it('png symbol over 200 KB falls back to the letter tile', async () => {
    await setSymbol(PNG_SIG, 'image/png', 200 * 1024 + 1);
    const r = await render();
    expect(r.attachments).toHaveLength(0);
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('>F<');
  });

  it('brand text is escaped in html and subject', async () => {
    await setBrand({ name: '<b>Nordlicht "TV"</b>' });
    const r = await render();
    expect(r.html).toContain('&lt;b&gt;Nordlicht &quot;TV&quot;&lt;/b&gt;');
    expect(r.html).not.toContain('<b>Nordlicht');
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it('button uses the contrast-safe fill', async () => {
    await setBrand({ accent: '#f2e94e' });
    const fill = deriveTokens('#f2e94e').accFill;
    const r = await render();
    expect(r.html).toContain(`background-color:${fill}`);
    const btn = r.html.slice(r.html.indexOf('https://portal.example.com/') - 400, r.html.indexOf('https://portal.example.com/') + 200);
    expect(btn).toContain(`background-color:${fill}`);
    expect(btn).toContain('color:#ffffff');
  });

  it('text alternative carries the same content', async () => {
    const r = await render();
    expect(r.text).toContain(msg('de', 'mail.test.heading'));
    expect(r.text).toContain(msg('de', 'mail.test.body', { app: 'FriendFlix' }));
    expect(r.text).toContain('FriendFlix öffnen: https://portal.example.com/');
    expect(r.text).not.toContain('<');
    // the signature separator keeps its trailing space (RFC 3676), so mail clients can cut the signature
    expect(r.text).toContain(`\n-- \n${msg('de', 'mail.test.reason', { app: 'FriendFlix' })}`);
  });

  it('the letter tile of a name starting with an uppercase-expanding letter is the letter as is', async () => {
    await setBrand({ name: 'ßeta' });
    expect((await mailBrand(env.ctx)).letter).toBe('ß');
    await setBrand({ name: 'ábc' });
    expect((await mailBrand(env.ctx)).letter).toBe('Á');
  });

  it('renders in the requested language', async () => {
    const en = await render('en');
    expect(en.subject).toBe(msg('en', 'mail.test.subject', { app: 'FriendFlix' }));
    expect(en.html).toContain('lang="en"');
    const pl = await render('pl');
    expect(pl.subject).toBe(msg('pl', 'mail.test.subject', { app: 'FriendFlix' }));
    expect(pl.subject).not.toBe(en.subject);
  });

  it('footer shows the website only when set', async () => {
    expect((await render()).html).not.toContain('friend.example.com');
    await setBrand({ website: 'https://friend.example.com/' });
    const r = await render();
    expect(r.html).toContain('href="https://friend.example.com/"');
    expect(r.text).toContain('https://friend.example.com/');
    const b = await mailBrand(env.ctx);
    expect(b.website).toBe('https://friend.example.com/');
    expect(b.legal).toEqual({});
  });

  it('html stays under 100 KB', async () => {
    await setBrand({ name: 'N'.repeat(24), byline: 'B'.repeat(32) });
    await setSymbol(PNG_SIG, 'image/png', 150_000); // the symbol travels as an attachment, never inside the html
    const r = await render();
    expect(Buffer.byteLength(r.html)).toBeLessThan(100_000);
  });

  it('headers', async () => {
    const r = await render();
    expect(r.headers['Auto-Submitted']).toBe('auto-generated');
    expect(r.headers['Content-Language']).toBe('de');
    expect((await render('en')).headers['Content-Language']).toBe('en');
  });

  it('safeHref refuses javascript: and mailto:', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('mailto:x')).toBeNull();
    expect(safeHref('https://friend.example.com/a?b=1')).toBe('https://friend.example.com/a?b=1');
    expect(safeHref('not a url')).toBeNull();
  });

  it('esc escapes the five characters; layout gives every text cell an explicit colour', () => {
    expect(esc(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
    const { html } = layout({
      lang: 'en', heading: 'H', paragraphs: ['P'], reason: 'R', footerLinks: [{ label: 'L', url: 'javascript:x' }],
      brand: { name: 'N', byline: '', website: '', fill: '#d6325a', letter: 'N', symbol: null, legal: {} },
    });
    expect(html).not.toContain('javascript:');
    for (const td of html.match(/<td\b[^>]*>(?=[^<]*[A-Za-z])/g) ?? []) expect(td, td).toMatch(/color:#/);
  });
});
