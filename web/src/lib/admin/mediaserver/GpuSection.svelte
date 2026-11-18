<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Grafikkarte* (spec "GPU"): what the updater detects (render nodes with their vendor, NVIDIA from the engine), the choice *Aus*,
   * *Intel/AMD (VA-API/QSV)* or *NVIDIA* (each only when detected; a choice stored before stays shown), preselected from the detection
   * when nothing is chosen yet, and the *HDR-Test* with PASS/FAIL per test. The detection line and the two result rows keep their room
   * from the start.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { apiCode } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtList, t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import type { Gpu, GpuInfo, MediaApi, MediaStatus } from './api';
  import { kindName, mediaErrorText } from './model';

  export let api: MediaApi;
  export let call: <T>(fn: () => Promise<T>) => Promise<T>;
  export let gpu: Gpu;
  /** nothing stored yet: the detection picks */
  export let preselect = false;
  export let hdr: MediaStatus['hdr'] = null;
  /** the HDR test can run (a managed server of this kind exists, no job runs) */
  export let canTest = false;
  /** the GPU the running server was deployed with (the test uses that, never the unsaved choice) */
  export let deployed: Gpu | null = null;
  export let testing = false;
  export let disabled = false;
  const dispatch = createEventDispatcher<{ hdr: void }>();

  let info: GpuInfo | null = null, error = '', loading = true;
  onMount(async () => {
    try {
      info = await call(() => api.gpu());
      if (preselect) gpu = info.nvidia ? 'nvidia' : info.dri.length ? 'dri' : 'off';
    } catch (e) {
      error = mediaErrorText(apiCode(e));
    } finally { loading = false; }
  });
  $: options = (['off', 'dri', 'nvidia'] as const).filter((g) => g === 'off' || g === gpu || (g === 'dri' ? Boolean(info?.dri.length) : Boolean(info?.nvidia)));
  $: found = info ? [...info.dri.map((d) => `${$t(`mediaserver.gpu.vendor.${d.vendor === 'other' ? 'generic' : d.vendor}`)} (${d.node})`), ...(info.nvidia ? [$t('mediaserver.gpu.nvidia')] : [])] : [];
  $: line = loading ? $t('mediaserver.gpu.detecting') : error || (found.length ? $t('mediaserver.gpu.found', { list: fmtList(found) }) : $t('mediaserver.gpu.none'));

  let btns: HTMLButtonElement[] = [];
  function key(e: KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + options.length) % options.length;
    gpu = options[j]!;
    btns[j]?.focus();
  }
  const result = (r: 'pass' | 'fail' | undefined) => (r === 'pass' ? tr('mediaserver.gpu.pass') : r === 'fail' ? tr('mediaserver.gpu.fail') : tr('mediaserver.gpu.notRun'));
</script>

<section class="sec" aria-labelledby="ms-gpu-t">
  <h3 id="ms-gpu-t"><Icon name="monitor" size={18} />{$t('mediaserver.gpu.title')}</h3>
  <p class="muted small" class:err={error} data-testid="media-gpu-found">{line}</p>
  <div class="seg" role="radiogroup" aria-label={$t('mediaserver.gpu.label')}>
    {#each options as g, i (g)}
      <button type="button" role="radio" aria-checked={gpu === g} tabindex={gpu === g ? 0 : -1} class:on={gpu === g} {disabled} bind:this={btns[i]}
        on:click={() => (gpu = g)} on:keydown={(e) => key(e, i)}>{$t(`mediaserver.gpu.${g}`)}</button>
    {/each}
  </div>
  <div class="hdr">
    <div class="hdr-head">
      <Button variant="secondary" size="sm" icon="activity" pending={testing} disabled={disabled || !canTest || !deployed || deployed === 'off'} on:click={() => dispatch('hdr')}>{$t('mediaserver.gpu.hdr')}</Button>
      <span class="muted small">{$t('mediaserver.gpu.hdrHint')}</span>
    </div>
    <dl data-testid="media-hdr">
      <div><dt>{$t('mediaserver.gpu.opencl')}</dt><dd class="r-{hdr?.opencl ?? 'none'}">{result(hdr?.opencl)}</dd></div>
      <div><dt>{$t('mediaserver.gpu.qsv')}</dt><dd class="r-{hdr?.qsv ?? 'none'}">{result(hdr?.qsv)}</dd></div>
    </dl>
    <p class="muted tiny">{hdr ? $t('mediaserver.gpu.hdrAt', { time: fmtDateTime(hdr.at), kind: kindName(hdr.kind) }) : ''}</p>
  </div>
</section>

<style>
  .sec { display: grid; gap: .5rem; }
  h3 { display: flex; align-items: center; gap: .45rem; margin: 0; font-size: 1rem; }
  .small { font-size: .88rem; margin: 0; }
  .tiny { font-size: .8rem; margin: 0; min-height: 1.3em; }
  .err { color: var(--err-mark); }
  p.small { min-height: 1.4em; }
  .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 22px; padding: 3px; gap: 3px; max-width: 100%; justify-self: start; }
  .seg button { min-height: 44px; min-width: 44px; padding: .3rem 1rem; border-radius: var(--fr-r-pill); background: transparent; border: 0; color: var(--mut); font-weight: 600; }
  .seg button.on { background: var(--fg); color: var(--bg, #101418); }
  .seg button:not(.on):hover:not(:disabled) { color: var(--fg); background: rgba(255, 255, 255, .07); }
  .hdr { display: grid; gap: .4rem; }
  .hdr-head { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .8rem; }
  dl { margin: 0; display: grid; gap: .2rem; }
  dl div { display: flex; justify-content: space-between; gap: .8rem; padding: .2rem 0; border-top: 1px solid var(--line); }
  dt, dd { margin: 0; }
  dd { font-weight: 700; font-variant-numeric: tabular-nums; }
  .r-pass { color: var(--ok); }
  .r-fail { color: var(--err-mark); }
  .r-none { color: var(--mut); font-weight: 400; }
</style>
