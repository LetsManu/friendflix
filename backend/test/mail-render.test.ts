// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveTokens } from '../src/brand/colors.js';
import { readBrand, resetBrand, saveBrand, storeImage } from '../src/brand/repo.js';
import type { Brand } from '../src/brand/schema.js';
import { m, msg, type MsgKey } from '../src/i18n.js';
import { esc, layout, safeHref } from '../src/mail/html.js';
import { mailBrand, MAX_INLINE_SYMBOL_BYTES } from '../src/mail/brand.js';
import { renderMail, type MailKind } from '../src/mail/templates.js';
import { unsubscribeToken } from '../src/mail/unsubscribe.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

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
  afterEach(() => { env.ctx.cfg = cfg; });

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
  // Mail stage B, Task 2: a template per kind, the unsubscribe headers and links of the per-type mails.
  const ORIGIN = 'https://friend.example.com';
  const atFriend = () => { env.ctx.cfg = { ...cfg, PUBLIC_URL: ORIGIN }; };
  // download.expiring.title arrives with stage B Task 3 (the licence notice); until then a missing key renders as itself
  const licenceTitle = () => m('download.expiring.title' as MsgKey, { n: 2 });
  const INVITE = { link: `${ORIGIN}/invite/abc123`, expiresAt: '2026-11-18T10:00:00.000Z', inviter: 'Anna Beispiel' };

  it('pref kinds carry the unsubscribe headers and links', async () => {
    atFriend();
    const r = await renderMail(env.ctx, 'licence', 'de', { title: licenceTitle(), body: null, link: '/downloads' }, { userId: actor });
    const tok = unsubscribeToken(env.ctx.encKey, actor, 'licence');
    expect(r.headers['List-Unsubscribe']).toBe(`<${ORIGIN}/api/public/mail/unsubscribe?t=${tok}>`);
    expect(r.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(r.text).toContain(`Diese E-Mails abbestellen: ${ORIGIN}/mail/unsubscribe?t=${tok}`);
    expect(r.text).toContain(`E-Mail-Einstellungen: ${ORIGIN}/me/account#mail`);
    expect(r.html).toContain(`href="${ORIGIN}/mail/unsubscribe?t=${tok}"`);
    expect(r.html).toContain(`href="${ORIGIN}/me/account#mail"`);
    // the button goes to the notice's link, made absolute
    expect(r.html).toContain(`href="${ORIGIN}/downloads"`);
    expect(r.text).toContain(`${msg('de', 'mail.licence.button')}: ${ORIGIN}/downloads`);
    // no body in the notice: the kind's own paragraph and reason
    expect(r.text).toContain(msg('de', 'mail.licence.body', { app: 'FriendFlix' }));
    expect(r.text).toContain(msg('de', 'mail.licence.reason', { app: 'FriendFlix' }));
    // the settings link comes before the unsubscribe link, both after the brand's links
    expect(r.text.indexOf('E-Mail-Einstellungen:')).toBeLessThan(r.text.indexOf('Diese E-Mails abbestellen:'));
    for (const v of Object.values(r.headers)) expect(v).not.toMatch(/[\r\n]/);
    // the only token in the mail is the recipient's own, for this type
    const tokens = new Set([...`${r.html}\n${r.text}\n${JSON.stringify(r.headers)}`.matchAll(/v1\.[0-9a-f-]{36}\.[a-z]+\.[A-Za-z0-9_-]{43}/g)].map((x) => x[0]));
    expect([...tokens]).toEqual([tok]);
  });

  it('each pref kind uses its own texts and its own token', async () => {
    atFriend();
    for (const kind of ['available', 'recording', 'licence'] as const) {
      const r = await renderMail(env.ctx, kind, 'de', { title: 'Nordlicht', body: 'Ein Text aus der Mitteilung' }, { userId: actor });
      expect(r.subject).toBe('Nordlicht');
      expect(r.text).toContain('Ein Text aus der Mitteilung');
      expect(r.text).not.toContain(msg('de', `mail.${kind}.body`, { app: 'FriendFlix' }));
      expect(r.text).toContain(msg('de', `mail.${kind}.reason`, { app: 'FriendFlix' }));
      // no link in the notice: the button opens the app
      expect(r.text).toContain(`${msg('de', `mail.${kind}.button`)}: ${ORIGIN}/`);
      expect(r.headers['List-Unsubscribe']).toContain(unsubscribeToken(env.ctx.encKey, actor, kind));
    }
  });

  it('a pref kind without its recipient or without PUBLIC_URL throws', async () => {
    atFriend();
    await expect(renderMail(env.ctx, 'available', 'de', { title: 'Nordlicht' })).rejects.toThrow();
    await expect(renderMail(env.ctx, 'available', 'de', { title: 'Nordlicht' }, { userId: null })).rejects.toThrow();
    env.ctx.cfg = { ...cfg, PUBLIC_URL: '' };
    await expect(renderMail(env.ctx, 'available', 'de', { title: 'Nordlicht' }, { userId: actor })).rejects.toThrow();
  });

  it('an unknown kind throws', async () => {
    atFriend();
    await expect(renderMail(env.ctx, 'digest' as MailKind, 'de', {}, { userId: actor })).rejects.toThrow(/unknown mail kind/);
    await expect(renderMail(env.ctx, 'toString' as MailKind, 'de', {}, { userId: actor })).rejects.toThrow(/unknown mail kind/);
  });

  it('welcome and invite have no unsubscribe header', async () => {
    atFriend();
    const w = await renderMail(env.ctx, 'welcome', 'de', { name: 'Anna Beispiel' }, { userId: actor });
    expect(w.headers).toEqual({ 'Auto-Submitted': 'auto-generated', 'Content-Language': 'de' });
    expect(w.subject).toBe(msg('de', 'mail.welcome.subject', { app: 'FriendFlix' }));
    expect(w.text).toContain(msg('de', 'mail.welcome.heading', { name: 'Anna Beispiel' }));
    expect(w.text).toContain(msg('de', 'mail.welcome.body', { app: 'FriendFlix' }));
    expect(w.text).toContain(msg('de', 'mail.welcome.body2', { app: 'FriendFlix' }));
    expect(w.text).toContain(`FriendFlix öffnen: ${ORIGIN}/`);
    expect(w.text).toContain(`E-Mail-Einstellungen: ${ORIGIN}/me/account#mail`);
    expect(w.text).toContain(msg('de', 'mail.welcome.reason', { app: 'FriendFlix' }));
    expect(`${w.html}${w.text}`).not.toContain('unsubscribe');
    const i = await renderMail(env.ctx, 'invite', 'de', INVITE, { userId: null });
    expect(i.headers).toEqual({ 'Auto-Submitted': 'auto-generated', 'Content-Language': 'de' });
    expect(`${i.html}${i.text}`).not.toContain('unsubscribe');
    expect(`${i.html}${i.text}`).not.toContain('/me/account');
    // the test mail keeps exactly its stage A headers
    expect((await renderMail(env.ctx, 'test', 'de', {}, { userId: actor })).headers).toEqual({ 'Auto-Submitted': 'auto-generated', 'Content-Language': 'de' });
  });

  it('notice title with markup is escaped', async () => {
    atFriend();
    const r = await renderMail(env.ctx, 'available', 'de', { title: '<b>"Nordlicht"</b> ist jetzt verfügbar', link: '/requests' }, { userId: actor });
    expect(r.html).toContain('&lt;b&gt;&quot;Nordlicht&quot;&lt;/b&gt;');
    expect(r.html).not.toContain('<b>"Nordlicht"');
    expect(r.subject).toBe('<b>"Nordlicht"</b> ist jetzt verfügbar');
    expect(r.subject).not.toMatch(/[\r\n]/);
    const nl = await renderMail(env.ctx, 'available', 'de', { title: 'Nordlicht\r\nBcc: ben@friend.example.com', body: '<script>x</script>' }, { userId: actor });
    expect(nl.subject).not.toMatch(/[\r\n]/);
    expect(nl.html).not.toContain('<script>');
    expect(nl.html).toContain('&lt;script&gt;');
    // a notice message is rendered in the mail's language
    const msgTitle = await renderMail(env.ctx, 'available', 'en', { title: m('title.available', { title: '<i>Nordlicht</i>' }) }, { userId: actor });
    expect(msgTitle.subject).toBe(msg('en', 'title.available', { title: '<i>Nordlicht</i>' }));
    expect(msgTitle.html).toContain('&lt;i&gt;Nordlicht&lt;/i&gt;');
    expect(msgTitle.html).not.toContain('<i>Nordlicht');
  });

  it('invite renders link, inviter and date in the stored language', async () => {
    atFriend();
    const r = await renderMail(env.ctx, 'invite', 'en', INVITE, { userId: null });
    expect(r.subject).toBe(msg('en', 'mail.invite.subject', { inviter: 'Anna Beispiel', app: 'FriendFlix' }));
    expect(r.subject).toContain('Anna Beispiel');
    expect(r.html).toContain('lang="en"');
    expect(r.html).toContain(`href="${INVITE.link}"`);
    expect(r.text).toContain(`${msg('en', 'mail.invite.button')}: ${INVITE.link}`);
    expect(r.text).toContain(msg('en', 'mail.invite.body', { inviter: 'Anna Beispiel', app: 'FriendFlix' }));
    expect(r.text).toContain(msg('en', 'mail.invite.expires', { date: { date: INVITE.expiresAt } }));
    expect(r.text).toContain('2026');
    expect(r.text).toContain(msg('en', 'mail.invite.reason', { inviter: 'Anna Beispiel', app: 'FriendFlix' }));
    const esc2 = await renderMail(env.ctx, 'invite', 'de', { ...INVITE, inviter: '<b>Anna</b>\r\nBcc: x' }, { userId: null });
    expect(esc2.html).not.toContain('<b>Anna');
    expect(esc2.subject).not.toMatch(/[\r\n]/);
  });

  it('a link that is not a relative path drops the button', async () => {
    atFriend();
    for (const link of ['javascript:alert(1)', 'https://evil.example.com/', '//evil.example.com/x', '/\\evil.example.com/x', 'downloads', ' /downloads']) {
      const r = await renderMail(env.ctx, 'available', 'de', { title: 'Nordlicht', link }, { userId: actor });
      expect(r.html, link).not.toContain(msg('de', 'mail.available.button'));
      expect(r.text, link).not.toContain(msg('de', 'mail.available.button'));
      expect(`${r.html}${r.text}`, link).not.toContain('evil.example.com');
      expect(r.html, link).not.toContain('javascript:');
      // the mail still renders, with its unsubscribe link
      expect(r.text, link).toContain('Diese E-Mails abbestellen:');
    }
  });

  it('every stage B kind stays under 100 000 bytes', async () => {
    atFriend();
    await setBrand({ name: 'N'.repeat(24), byline: 'B'.repeat(32), website: 'https://friend.example.com/' });
    await setSymbol(PNG_SIG, 'image/png', MAX_INLINE_SYMBOL_BYTES);
    const long = 'Nordlicht '.repeat(30);
    const cases: Array<[MailKind, Record<string, unknown>]> = [
      ['welcome', { name: long }],
      ['invite', { ...INVITE, inviter: long }],
      ['available', { title: long, body: long, link: '/requests' }],
      ['recording', { title: long, body: long, link: '/live/recordings' }],
      ['licence', { title: licenceTitle(), body: long, link: '/downloads' }],
    ];
    for (const [kind, params] of cases) {
      const r = await renderMail(env.ctx, kind, 'de', params, { userId: actor });
      expect(r.attachments, kind).toHaveLength(1);
      expect(Buffer.byteLength(r.html), kind).toBeLessThan(100_000);
      expect(r.html, kind).not.toMatch(/<img[^>]+src="http/);
    }
  });

  it('bad params throw', async () => {
    atFriend();
    await expect(renderMail(env.ctx, 'invite', 'de', { link: 'ftp://x' })).rejects.toThrow();
    await expect(renderMail(env.ctx, 'invite', 'de', { ...INVITE, link: 'javascript:alert(1)' })).rejects.toThrow();
    await expect(renderMail(env.ctx, 'invite', 'de', { ...INVITE, expiresAt: 'morgen' })).rejects.toThrow();
    await expect(renderMail(env.ctx, 'welcome', 'de', {}, { userId: actor })).rejects.toThrow();
    await expect(renderMail(env.ctx, 'available', 'de', { body: 'x' }, { userId: actor })).rejects.toThrow();
    await expect(renderMail(env.ctx, 'recording', 'de', { title: 7 }, { userId: actor })).rejects.toThrow();
  });
});
