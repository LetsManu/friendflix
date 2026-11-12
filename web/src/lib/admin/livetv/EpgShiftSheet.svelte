<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Programm-Zeit verschieben…* (spec §9.2, ruling 42): the effective offset of one channel with where it comes from (`shiftFromLine`),
   * a stepper in 30-minute steps from −12 to +14 h (picker.ts), *Speichern* (PATCH `epgShiftMin`) and *Zurücksetzen* (PATCH `null`:
   * back to the list's or the source's value). The *Jetzt* line shows the programme of the PATCH answer's `now` (the offset applied), so
   * a save is previewed at once; its height is reserved (two lines), so neither it nor the sheet moves. The sheet stays open after a
   * save; every answer goes to the list through `changed`.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { failText, nowLine, patchChannel, shiftFromLine, type AdminChannel } from './channels';
  import { SHIFT_MAX, SHIFT_MIN, shiftLabel, stepShift } from './picker';
  import SheetFrame from './SheetFrame.svelte';

  export let channel: AdminChannel;
  export let returnTo: (() => HTMLElement | null) | null = null;

  const dispatch = createEventDispatcher<{ close: void; changed: AdminChannel }>();
  let c = channel;
  let draft = c.epgShift.min;
  $: key = `ltv-ch-shift:${c.id}`;
  $: busy = $busyKeys.has(key);

  async function send(epgShiftMin: number | null, done: string) {
    const r = await runAction({ key, run: () => patchChannel(c.id, { epgShiftMin }), success: done, error: failText });
    if (!r.ok || !r.value) return;
    c = r.value;
    draft = c.epgShift.min;
    dispatch('changed', c);
  }
</script>

<SheetFrame title={tr('adminLive.ch.shift.title', { name: c.name })} {returnTo} on:close={() => dispatch('close')}>
  <div class="eff">
    <span class="lbl">{$t('adminLive.ch.shift.current')}</span>
    <p class="val" data-from>{shiftFromLine(c)}</p>
  </div>

  <div class="stepper" role="group" aria-label={$t('adminLive.ch.shift.set')}>
    <button type="button" class="st" aria-label={$t('adminLive.ch.shift.earlier')} title={$t('adminLive.ch.shift.earlier')} disabled={draft <= SHIFT_MIN || busy} on:click={() => (draft = stepShift(draft, -1))}>
      <Icon name="chevron-left" size={20} />
    </button>
    <output class="amount" data-value aria-live="polite">{shiftLabel(draft)}</output>
    <button type="button" class="st" aria-label={$t('adminLive.ch.shift.later')} title={$t('adminLive.ch.shift.later')} disabled={draft >= SHIFT_MAX || busy} on:click={() => (draft = stepShift(draft, 1))}>
      <Icon name="chevron-right" size={20} />
    </button>
  </div>
  <p class="hint">{$t('adminLive.ch.shift.hint')}</p>

  <div class="eff">
    <span class="lbl">{$t('adminLive.ch.shift.now')}</span>
    <p class="val now" data-now aria-live="polite">{nowLine(c.now)}</p>
  </div>

  <div class="foot">
    <Button pending={busy && draft !== c.epgShift.min} disabled={draft === c.epgShift.min || busy} on:click={() => send(draft, tr('adminLive.ch.shift.saved'))}>{$t('adminLive.ch.shift.save')}</Button>
    <Button variant="secondary" disabled={c.epgShift.from !== 'channel' || busy} on:click={() => send(null, tr('adminLive.ch.shift.resetDone'))}>{$t('adminLive.ch.shift.reset')}</Button>
  </div>
</SheetFrame>

<style>
  .lbl { display: block; font-size: .85rem; font-weight: 700; color: rgba(255, 255, 255, .8); margin-bottom: .2rem; }
  .val { margin: 0; overflow-wrap: anywhere; }
  /* the Jetzt line reserves two lines: a long title or "Kein Programm verfügbar" never moves the buttons below it */
  .now { min-height: 3.1em; font-weight: 600; }
  .stepper { display: flex; align-items: center; gap: .6rem; }
  .st { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: rgba(255, 255, 255, .12); color: #fff; }
  .st:hover:not(:disabled) { background: rgba(255, 255, 255, .2); }
  .st:disabled { opacity: .4; }
  .amount { min-width: 7rem; text-align: center; font-size: 1.25rem; font-weight: 800; font-variant-numeric: tabular-nums; }
  .hint { margin: 0; font-size: .9rem; color: rgba(255, 255, 255, .8); }
  .foot { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
  .foot :global(.spinner) { width: 18px; height: 18px; }
</style>
