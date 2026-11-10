<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Traffic light per dependency (Block 22): worst first, icon + text pill, a link to where it is handled. null = skeleton. */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtNumber, t, type TKey } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import { adviceKeys, checkHevc, HEVC_POLL_MAX_MS, HEVC_POLL_MS, hevcLineText, loadHevcCheck, levelIcon, levelTone, serviceText, sortServices, type ServiceHealth, type ServiceId } from './health';

  export let services: ServiceHealth[] | null;
  const dispatch = createEventDispatcher<{ refresh: void }>();
  let hevcBusy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  const sleep = (ms: number) => new Promise<void>((res) => { timer = setTimeout(res, ms); });
  async function hevcNow() {
    if (hevcBusy) return;
    hevcBusy = true;
    try {
      const r = await checkHevc();
      // the probe runs in the background: ask every 2 s until it has stored its result (or 3 minutes passed)
      for (let waited = 0; r.started && waited < HEVC_POLL_MAX_MS; waited += HEVC_POLL_MS) {
        await sleep(HEVC_POLL_MS);
        if (!(await loadHevcCheck()).running) break;
      }
      dispatch('refresh');
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { error?: string } | null)?.error : undefined;
      toast.error($t(code === 'busy' ? 'adminContent.health.hevc.busy' : code === 'already_running' ? 'adminContent.health.hevc.running' : 'adminContent.health.hevc.failed'));
    }
    hevcBusy = false;
  }
  const META: Record<ServiceId, { icon: string; href?: string }> = {
    media: { icon: 'film', href: '/admin/playback' }, postgres: { icon: 'hard-drive' }, redis: { icon: 'grid' }, gateway: { icon: 'link' },
    oidc: { icon: 'key' }, requests: { icon: 'inbox', href: '/admin/requests' }, tmdb: { icon: 'info', href: '/admin/sources' },
    omdb: { icon: 'star', href: '/admin/sources' }, playbackCheck: { icon: 'play', href: '/admin/playback' }, encoder: { icon: 'activity' },
  };
  $: list = services ? sortServices(services) : null;
  // $t as an argument: the HEVC line follows a language switch too
  const hevcTexts = (l: ServiceHealth[] | null, _tr: unknown) => new Map((l ?? []).flatMap((s) => (s.hevc ? [[s.id, hevcLineText(s.hevc)] as const] : [])));
  const textsOf = (l: ServiceHealth[] | null, _tr: unknown) => new Map((l ?? []).map((s) => [s.id, serviceText(s)]));
  // $t as an argument: the texts follow a language switch (serviceText reads the same store)
  $: texts = textsOf(list, $t);
  $: hevcs = hevcTexts(list, $t);
</script>

<ul class="lights">
  {#each list ?? [null, null, null, null, null, null] as s, i (s?.id ?? i)}
    <li>
      {#if s}
        {@const m = META[s.id] ?? { icon: 'activity' }}
        <svelte:element this={m.href ? 'a' : 'div'} href={m.href} class="svc frost-flat frost-text" class:edge-hover={!!m.href}>
          <span class="hi" aria-hidden="true"><Icon name={m.icon} size={18} /></span>
          <span class="hl">{$t(`adminContent.health.svc.${s.id}` as TKey)}</span>
          <StatusPill tone={levelTone(s.level)} icon={levelIcon(s.level)} label={texts.get(s.id) ?? ''} />
          {#if s.ms !== undefined && s.level !== 'off'}<span class="ms">{$t('adminContent.health.ms', { n: fmtNumber(s.ms) })}</span>{/if}
          {#if s.hevc}
            <span class="hevc">{hevcs.get(s.id) ?? ''}</span>
            <span class="hevcbtn"><Button variant="secondary" size="sm" pending={hevcBusy} on:click={hevcNow}>{$t('adminContent.health.hevc.check')}</Button></span>
          {/if}
          {#if s.advice?.length}<ul class="adv">{#each adviceKeys(s) as k (k)}<li>{$t(k)}</li>{/each}</ul>{/if}
        </svelte:element>
      {:else}<span class="svc sk frost-flat" aria-hidden="true"><Skeleton w="60%" h=".9rem" /><Skeleton w="5rem" h="1.3rem" radius="99px" /></span>{/if}
    </li>
  {/each}
</ul>

<style>
  .lights { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: .6rem; }
  .svc { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; min-height: 64px; padding: .7rem .9rem; color: inherit; border-radius: 16px; }
  .sk { flex-direction: column; align-items: flex-start; justify-content: center; }
  .hi { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,.08); flex: none; }
  .hl { flex: 1; min-width: 6rem; font-weight: 600; font-size: .92rem; }
  .hevc { width: 100%; padding-left: calc(32px + .6rem); color: var(--mut); font-size: .8rem; font-variant-numeric: tabular-nums; }
  .hevcbtn { padding-left: calc(32px + .6rem); }
  .adv { width: 100%; margin: .2rem 0 0; padding: 0 0 0 calc(32px + .6rem + 1rem); color: var(--mut); font-size: .8rem; line-height: 1.4; display: grid; gap: .3rem; }
  .ms { width: 100%; padding-left: calc(32px + .6rem); color: var(--mut); font-size: .78rem; font-variant-numeric: tabular-nums; }
</style>
