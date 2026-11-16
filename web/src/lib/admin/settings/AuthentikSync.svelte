<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Branding an Authentik übertragen* (mail stage C, Controller's call 8), under the E-Mail card's form: shown only while the Authentik
   * API is configured. Name, logo URL and sender are read-only here (they come from Branding and the mail settings). The SMTP checkbox
   * starts unchecked on every load and clears after each transfer: the password goes to Authentik only on an explicit tick (the backend
   * also wants a fresh sign-in, which runs in place). The two result lines keep their room whether they show text or not, and sit
   * below the button, so nothing moves when a result arrives; a result fades in (opacity only).
   */
  import { t, type TKey, type TParams } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { AK_BRANDING_GUIDE, loadAkBranding, partText, syncAkBranding, syncErrorText, type AkBranding, type AkPart, type AkSyncResult } from './akBranding';
  import type { ResultTone } from './mail';

  /** bumped by the page after the mail group was saved: the preview (sender, whether mail is set up) is read again */
  export let reload = 0;

  const BUSY = 'set:ak:branding';
  let preview: AkBranding | null = null;
  let smtp = false;
  /** the last transfer (the text follows a language switch); `n` restarts the fade for a repeated answer */
  let answer: { r: AkSyncResult; smtp: boolean; n: number } | { error: unknown; n: number } | null = null;

  let seq = 0;
  /** `_after`: only there so a change of `reload` runs it again */
  async function load(_after?: number): Promise<void> {
    const mine = ++seq;
    try {
      const p = await loadAkBranding();
      if (mine === seq) preview = p;
    } catch {
      // keep an earlier preview; without one the card stays away (the settings above still work)
    }
  }
  $: void load(reload);

  async function run(): Promise<void> {
    const withSmtp = smtp && Boolean(preview?.smtp.available);
    const res = await runAction({ key: BUSY, run: () => syncAkBranding(withSmtp), error: false });
    if (res.skipped) return;
    smtp = false; // consent is for one transfer
    const n = (answer?.n ?? 0) + 1;
    answer = res.ok && res.value ? { r: res.value, smtp: withSmtp, n } : { error: res.error, n };
  }

  $: tx = (key: string, params?: TParams) => $t(key as TKey, params);
  type Line = { tone: ResultTone; text: string; guide: boolean } | null;
  const guide = (p: AkPart) => p.state === 'failed' && p.code === 'permission';
  let lines: [Line, Line] = [null, null];
  $: lines = !answer ? [null, null]
    : 'r' in answer ? [{ ...partText('brand', answer.r.brand, answer.smtp, tx), guide: guide(answer.r.brand) }, { ...partText('stage', answer.r.stage, answer.smtp, tx), guide: guide(answer.r.stage) }]
    : [{ ...syncErrorText(answer.error, tx), guide: false }, null];
  $: pending = $busyKeys.has(BUSY);
</script>

{#if preview?.available}
  <section class="ak" aria-labelledby="ak-sync-h">
    <h3 id="ak-sync-h">{$t('settings.mail.authentik.title')}</h3>
    <p class="text">{$t('settings.mail.authentik.text')}</p>
    <dl class="rows">
      <div><dt>{$t('settings.mail.authentik.rowTitle')}</dt><dd>{preview.title}</dd></div>
      <div><dt>{$t('settings.mail.authentik.rowLogo')}</dt><dd>{preview.logoUrl ?? $t('settings.mail.authentik.noLogo')}</dd></div>
      <div><dt>{$t('settings.mail.authentik.rowFrom')}</dt><dd>{preview.from ?? $t('settings.mail.authentik.noFrom')}</dd></div>
    </dl>
    <label class="chk" class:off={!preview.smtp.available}>
      <input type="checkbox" bind:checked={smtp} disabled={!preview.smtp.available || pending} aria-describedby="ak-sync-hint" />
      <span>{$t('settings.mail.authentik.smtp')}</span>
    </label>
    <p id="ak-sync-hint" class="hint">{preview.smtp.available ? $t('settings.mail.authentik.smtpHint') : $t('settings.mail.authentik.smtpUnavailable')}</p>
    <div class="act">
      <Button variant="secondary" icon="send" {pending} on:click={run}>{$t('settings.mail.authentik.run')}</Button>
    </div>
    <div class="results" role="status" data-testid="ak-results">
      {#each lines as line, i (i)}
        <p class="line {line?.tone ?? 'none'}" data-testid={i === 0 ? 'ak-brand-result' : 'ak-stage-result'}>
          {#if line && answer}{#key answer.n}<span class="txt">{line.text}{#if line.guide}{' '}<a href={AK_BRANDING_GUIDE} target="_blank" rel="noopener noreferrer">{$t('settings.mail.authentik.guide')}</a>{/if}</span>{/key}{/if}
        </p>
      {/each}
    </div>
  </section>
{/if}

<style>
  .ak { display: grid; gap: .6rem; margin-top: 1rem; padding-top: .8rem; border-top: 1px solid var(--line); min-width: 0; }
  h3 { margin: 0; font-size: 1rem; }
  .text, .hint { margin: 0; color: var(--mut); font-size: .92rem; line-height: 1.45; overflow-wrap: anywhere; }
  .hint { font-size: .88rem; }
  .rows { margin: 0; display: grid; gap: .3rem; min-width: 0; }
  .rows div { display: grid; grid-template-columns: minmax(5.5rem, max-content) minmax(0, 1fr); gap: .8rem; min-width: 0; }
  dt { color: var(--mut); font-size: .92rem; }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-size: .92rem; }
  .chk { display: flex; align-items: center; gap: .6rem; min-height: 44px; cursor: pointer; font-weight: 500; min-width: 0; }
  .chk input { flex: none; width: 1.1rem; height: 1.1rem; margin: 0; }
  .chk.off { cursor: default; color: var(--mut); }
  .act { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .9rem; min-width: 0; }
  .results { display: grid; gap: .4rem; min-width: 0; }
  /* border-box (app.css): the padding is inside the reserved height, so a tone never changes it */
  .line { margin: 0; min-height: calc(4.35em + .9rem); padding: .45rem .6rem; line-height: 1.45; font-size: .92rem; overflow-wrap: anywhere; border-radius: 6px; }
  .line.ok { background: var(--wash-ok); color: var(--ok); }
  .line.warn { background: var(--wash-warn); color: var(--fg); }
  .line.err { background: var(--wash-err); color: var(--fg); }
  .line a { color: inherit; text-decoration: underline; }
  .txt { animation: fade-in .22s ease-out both; }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
  @media (max-width: 720px) {
    .rows div { grid-template-columns: minmax(0, 1fr); gap: 0; }
    .line { min-height: calc(5.8em + .9rem); }
  }
  @media (prefers-reduced-motion: reduce) { .txt { animation: none; } }
</style>
