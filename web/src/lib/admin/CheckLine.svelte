<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One Systemcheck line: status pill (icon + word) and label in a compact row; unless ok, the cause and fix sentences and the actions
   * below it (Zur Einstellung, Details, Anleitung; HEVC jetzt prüfen on the encoder line). null = skeleton at the compact row's height.
   */
  import { createEventDispatcher } from 'svelte';
  import { hasKey, t, trDynamic } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import HevcCheck from './HevcCheck.svelte';
  import { docsHref, lineText, settingHref, statusIcon, statusTone, type CheckLine } from './syscheck';

  export let line: CheckLine | null;
  /** the browser checks are running: a browser line without a result reads "wird geprüft…" */
  export let browserRunning = false;
  const dispatch = createEventDispatcher<{ refresh: void }>();

  // $t as an argument: the texts follow a language switch (lineText reads the same store)
  const textOf = (l: CheckLine | null, _tr: unknown) => (l ? lineText(l) : null);
  $: text = textOf(line, $t);
  $: running = !!line?.placeholder && line.runs === 'browser' && browserRunning;
  $: pillText = line ? (running ? $t('syscheck.browser.running') : $t(`syscheck.status.${line.status}`)) : '';
  /** the encoder line's further advice (the first is its cause), as short sentences */
  const adviceOf = (l: CheckLine | null, _tr: unknown): string[] => {
    const list = l?.id === 'media.encoder' && typeof l.params?.advice === 'string' ? l.params.advice.split(',').slice(1) : [];
    return list.filter((a) => /^[a-z_]+$/.test(a) && hasKey(`syscheck.cause.${a}`)).map((a) => trDynamic(`syscheck.cause.${a}`));
  };
  $: advice = adviceOf(line, $t);
  $: hevc = line?.id === 'media.encoder' && (typeof line.params?.hevc === 'string' || (typeof line.params?.advice === 'string' && /(^|,)hevc_/.test(line.params.advice)));
  $: setting = line?.settingKey ? settingHref(line.settingKey, line.settingGroup) : '';
  $: docs = line?.docs ? docsHref(line.docs) : '';
  $: details = line?.href && /^\/(?!\/)/.test(line.href) ? line.href : '';
  $: open = !!line && !line.placeholder && line.status !== 'ok' && !!(text?.cause || text?.fix || setting || docs || details);
</script>

{#if line && text}
  <div class="row">
    <span class="st"><StatusPill tone={running ? 'info' : statusTone(line.status)} icon={running ? 'clock' : statusIcon(line.status)} label={pillText} /></span>
    <span class="lb">{text.label}</span>
    {#if !open && (text.cause || text.note)}<span class="nt">{[text.cause, text.note].filter(Boolean).join(' ')}</span>{/if}
  </div>
  {#if open || hevc}
    <div class="body">
      {#if open}
        {#if text.cause}<p class="cause">{text.cause}</p>{/if}
        {#if advice.length}<ul class="adv">{#each advice as a (a)}<li>{a}</li>{/each}</ul>{/if}
        {#if text.fix}<p class="fix">{text.fix}</p>{/if}
        {#if text.note}<p class="nt">{text.note}</p>{/if}
      {/if}
      {#if (open && (setting || details || docs)) || hevc}
        <div class="actions">
          {#if open && setting}<Button variant="secondary" icon="settings" href={setting}>{$t('syscheck.action.toSetting')}</Button>{/if}
          {#if open && details}<Button variant="ghost" icon="chevron-right" href={details}>{$t('syscheck.action.details')}</Button>{/if}
          {#if open && docs}<Button variant="ghost" icon="info" href={docs} target="_blank" rel="noopener noreferrer">{$t('syscheck.action.docs')}</Button>{/if}
          {#if hevc}<HevcCheck state={typeof line.params?.hevc === 'string' ? line.params.hevc : undefined} speed={typeof line.params?.speed === 'number' ? line.params.speed : undefined} on:done={() => dispatch('refresh')} />{/if}
        </div>
      {/if}
    </div>
  {/if}
{:else}
  <div class="row sk" aria-hidden="true"><span class="st"><Skeleton w="7rem" h="1.4rem" radius="99px" /></span><span class="lb"><Skeleton w="min(14rem, 70%)" h=".95rem" /></span></div>
{/if}

<style>
  /* the compact row: pill column + label; the skeleton has exactly this height, so nothing moves when results arrive */
  .row { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); align-items: center; column-gap: .8rem; min-height: 44px; padding: .2rem 0; }
  .st { display: flex; min-width: 0; }
  .lb { font-weight: 600; font-size: .95rem; min-width: 0; overflow-wrap: anywhere; }
  .row > .nt { grid-column: 2; margin: 0 0 .2rem; }
  .nt { color: var(--mut); font-size: .85rem; line-height: 1.4; overflow-wrap: anywhere; }
  .body { padding: 0 0 .7rem calc(9.5rem + .8rem); display: grid; gap: .35rem; min-width: 0; }
  .body p { margin: 0; line-height: 1.45; overflow-wrap: anywhere; }
  .cause { font-size: .92rem; }
  .fix { color: var(--mut); font-size: .9rem; }
  .adv { margin: 0; padding-left: 1.1rem; color: var(--mut); font-size: .88rem; line-height: 1.4; display: grid; gap: .2rem; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; margin-top: .2rem; }
  @media (max-width: 560px) {
    .row { grid-template-columns: minmax(0, 1fr); row-gap: .2rem; padding: .45rem 0; }
    .row > .nt { grid-column: 1; }
    .body { padding-left: 0; }
    .actions > :global(*) { flex: 1 1 auto; }
  }
</style>
