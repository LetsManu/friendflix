<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The foot of the E-Mail card (mail stage A): the status line (GET /api/admin/mail/status) and *Testmail senden* with its result
   * line. The test goes to the admin's own address only. Both lines keep their space whether they show text or not, so nothing in the
   * card moves when a result arrives; the result fades in (opacity only). The status is read on mount, after every test and whenever
   * `reload` changes (the page bumps it after the card's group was saved or tested). Only the result line is a live region, so a test is announced once.
   */
  import { fmtDateTime, t, type TKey, type TParams } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { loadMailStatus, sendTestMail, statusLine, testError, testResultText, type MailStatus, type ResultTone, type TestMailResult } from './mail';

  /** bumped by the page after the mail group was saved: the status is read again */
  export let reload = 0;

  const BUSY = 'set:mail:test';
  let status: MailStatus | null = null;
  /** the first read failed (there is no earlier line to keep) */
  let failed = false;
  /** the last test's answer (the text follows a language switch); `n` restarts the fade for a repeated answer */
  let answer: { r: TestMailResult | { error: string }; n: number } | null = null;
  let seq = 0;

  /** `_after`: only there so a change of `reload` runs it again */
  async function refresh(_after?: number): Promise<void> {
    const mine = ++seq;
    try {
      const s = await loadMailStatus();
      if (mine === seq) { status = s; failed = false; }
    } catch {
      // keep an earlier line; without one, say so (the card itself still works)
      if (mine === seq && status === null) failed = true;
    }
  }
  $: void refresh(reload);

  async function test(): Promise<void> {
    const res = await runAction({ key: BUSY, run: sendTestMail, error: false });
    if (res.skipped) return;
    answer = { r: res.ok && res.value ? res.value : testError(res.error), n: (answer?.n ?? 0) + 1 };
    await refresh();
  }

  $: tx = (key: string, params?: TParams) => $t(key as TKey, params);
  $: line = status ? statusLine(status, tx, (iso) => fmtDateTime(iso)) : failed ? $t('settings.mail.statusFailed') : '';
  $: result = answer ? testResultText(answer.r, tx) : null;
  $: tone = (result?.tone ?? 'none') as ResultTone | 'none';
  /** nothing to send with: not set up, or the status is still loading (a failed load leaves the button to the server's answer) */
  $: offline = status === null ? !failed : !status.configured;
</script>

<div class="mail">
  <p class="status" data-testid="mail-status">{line}</p>
  <div class="act">
    <Button variant="secondary" icon="send" pending={$busyKeys.has(BUSY)} disabled={offline} aria-describedby="mail-test-hint" on:click={test}>{$t('settings.mail.test')}</Button>
    <span id="mail-test-hint" class="hint">{$t('settings.mail.testHint')}</span>
  </div>
  <p class="result {tone}" data-testid="mail-result" role="status">
    {#if result && answer}{#key answer.n}<span class="txt">{result.text}</span>{/key}{/if}
  </p>
</div>

<style>
  .mail { display: grid; gap: .6rem; margin-top: .6rem; padding-top: .8rem; border-top: 1px solid var(--line); min-width: 0; }
  /* both lines keep their room: two lines on a wide card, more on a phone (the longest status has four parts) */
  .status { margin: 0; min-height: 2.9em; line-height: 1.45; color: var(--mut); font-size: .92rem; overflow-wrap: anywhere; }
  .act { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .9rem; min-width: 0; }
  .hint { color: var(--mut); font-size: .88rem; min-width: 0; }
  /* border-box (app.css): the padding is inside the reserved height, so a tone never changes it */
  .result { margin: 0; min-height: calc(2.9em + .9rem); padding: .45rem .6rem; line-height: 1.45; font-size: .92rem; overflow-wrap: anywhere; border-radius: 6px; }
  .result.ok { background: var(--wash-ok); color: var(--ok); }
  .result.warn { background: var(--wash-warn); color: var(--fg); }
  .result.err { background: var(--wash-err); color: var(--fg); }
  .txt { animation: fade-in .22s ease-out both; }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
  @media (max-width: 720px) {
    .status { min-height: 5.8em; }
    .result { min-height: calc(4.35em + .9rem); }
  }
  @media (prefers-reduced-motion: reduce) { .txt { animation: none; } }
</style>
