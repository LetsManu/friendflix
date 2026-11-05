<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- The probe screen of the LG TV app (diagnostic, English only, like the Samsung one). Full screen, large type. On the pairing page
     it is a small strip at the bottom instead, so the pairing code stays usable; the pairing redirect starts the probe again full screen. -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { isBackKey } from '#lib/spatial';
  import { endLgProbe, failedLgProbeLine, formatLgProbe, realLgDeps, runLgProbe, shouldEndLgProbe, shouldLgProbe, type LgProbeStage } from './probe';

  export let compact = false;
  let on = false, stage: LgProbeStage = 'formats', detail = '', line = '', closed = false;

  function onKey(e: KeyboardEvent) {
    if (!on || !isBackKey(e)) return;
    e.preventDefault(); e.stopPropagation(); // also while running: Back must not reach the layout, which leaves the app on /
    if (stage !== 'done') return;
    if (shouldEndLgProbe(compact, line)) endLgProbe(); // the strip on the pairing page only hides itself while unpaired: the full-screen probe runs after pairing
    closed = true; on = false;
  }

  onMount(() => {
    if (!shouldLgProbe()) return;
    on = true;
    window.addEventListener('keydown', onKey, true);
    void runLgProbe(realLgDeps(), (s, d) => { stage = s; detail = d ?? ''; }).then((r) => { if (!closed) line = formatLgProbe(r); })
      .catch(() => { if (!closed) { line = failedLgProbeLine(); stage = 'done'; } });
  });
  onDestroy(() => { if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey, true); });
</script>

{#if on}
  <div class="probe" class:compact role="status" aria-live="polite">
    {#if stage === 'keys'}
      <p class="big">{detail === 'red' ? 'Press the red button now' : 'Press ⏯ now'}</p>
    {:else if stage === 'home'}
      <p class="big">Testing Change server…</p>
    {:else if stage === 'formats' || stage === 'direct' || stage === 'hls'}
      <p class="big">Testing playback…</p>
    {:else}
      <p class="line">{line}</p>
      <p class="hint">Back: close</p>
    {/if}
  </div>
{/if}

<style>
  .probe { position: fixed; inset: 0; z-index: 99999; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2rem; padding: 4rem; background: #000; color: #fff; text-align: center; }
  .probe.compact { inset: auto 0 0 0; padding: 1rem; gap: .5rem; background: rgba(0, 0, 0, .85); }
  .big { margin: 0; font-size: 4rem; font-weight: 700; }
  .line { margin: 0; font: 600 2.4rem/1.4 ui-monospace, monospace; overflow-wrap: anywhere; }
  .hint { margin: 0; font-size: 1.6rem; opacity: .7; }
  .compact .big { font-size: 1.8rem; } .compact .line { font-size: 1.4rem; } .compact .hint { font-size: 1.1rem; }
</style>
