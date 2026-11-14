<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The server's HEVC conversion on the Systemcheck's encoder line: its state ("HEVC-Umwandlung: bereit · 2,4-fache Echtzeit") and
   * "HEVC jetzt prüfen", which starts the timed probe in the background, asks every 2 s until it has stored its result (3 minutes at
   * most) and then fires `done` (the Systemcheck reloads with fresh inputs).
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { apiCode } from '#lib/api';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { toast } from '#lib/ui/toast';
  import { checkHevc, HEVC_POLL_MAX_MS, HEVC_POLL_MS, HEVC_STATES, hevcLineText, loadHevcCheck, type HevcState } from './health';

  /** params.hevc / params.speed of the encoder line (absent while the conversion is off) */
  export let state: string | undefined = undefined;
  export let speed: number | undefined = undefined;
  const dispatch = createEventDispatcher<{ done: void }>();
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  onDestroy(() => { gone = true; clearTimeout(timer); });
  const sleep = (ms: number) => new Promise<void>((res) => { timer = setTimeout(res, ms); });

  async function run() {
    if (busy) return;
    busy = true;
    try {
      const r = await checkHevc();
      for (let waited = 0; r.started && waited < HEVC_POLL_MAX_MS && !gone; waited += HEVC_POLL_MS) {
        await sleep(HEVC_POLL_MS);
        if (!(await loadHevcCheck()).running) break;
      }
      if (!gone) dispatch('done');
    } catch (e) {
      const code = apiCode(e);
      toast.error($t(code === 'busy' ? 'adminContent.health.hevc.busy' : code === 'sessions_unknown' ? 'adminContent.health.hevc.unknown' : code === 'already_running' ? 'adminContent.health.hevc.running' : 'adminContent.health.hevc.failed'));
    }
    busy = false;
  }
  const known = (s: string | undefined): s is HevcState => typeof s === 'string' && (HEVC_STATES as readonly string[]).includes(s);
  // $t as an argument: the line follows a language switch (hevcLineText reads the same store)
  const lineOf = (s: string | undefined, sp: number | undefined, _tr: unknown) => (known(s) ? hevcLineText({ state: s, speed: sp }) : '');
  $: text = lineOf(state, speed, $t);
</script>

<div class="hevc">
  {#if text}<span class="hl">{text}</span>{/if}
  <Button variant="secondary" icon="refresh" pending={busy} on:click={run}>{$t('syscheck.action.hevc')}</Button>
</div>

<style>
  .hevc { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .8rem; }
  .hl { color: var(--mut); font-size: .85rem; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
</style>
