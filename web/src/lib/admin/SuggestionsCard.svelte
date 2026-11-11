<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Status: the counts behind the "not here yet" suggestions, per type (films, series). Why a list is short or empty:
   * few starting titles, or nearly everything recommended is already in the library. Numbers only, loaded once.
   */
  import { onMount } from 'svelte';
  import { fmtNumber, t, type TKey } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { SUGGEST_FIELDS, loadSuggestStats, suggestHint, type SuggestResult, type SuggestType } from './suggestions';

  const TYPES: Array<{ type: SuggestType; label: TKey }> = [{ type: 'movie', label: 'common.movies' }, { type: 'series', label: 'common.series' }];
  let res: Record<SuggestType, SuggestResult | null> = { movie: null, series: null };
  async function load(type: SuggestType) { res[type] = null; res = res; const r = await loadSuggestStats(type); res[type] = r; res = res; }
  onMount(() => { for (const x of TYPES) void load(x.type); });
</script>

<AdminCard title={$t('adminContent.status.sug.title')} description={$t('adminContent.status.sug.intro')} id="st-sug">
  <div class="types" data-testid="sug-card">
    {#each TYPES as x (x.type)}
      {@const r = res[x.type]}
      <div class="one" data-type={x.type}>
        <h3>{$t(x.label)}</h3>
        {#if !r}<Skeleton lines={4} h="1rem" />
        {:else if r.state === 'ok'}
          <dl>
            {#each SUGGEST_FIELDS as k (k)}
              <div><dt>{$t(`adminContent.status.sug.f.${k}` as TKey)}</dt><dd data-field={k}>{fmtNumber(r.stats[k])}</dd></div>
            {/each}
          </dl>
          {@const hint = suggestHint(r.stats)}
          {#if hint}<p class="hint" role="note">{$t(`adminContent.status.sug.hint.${hint}` as TKey)}</p>{/if}
        {:else if r.state === 'failed'}
          <p class="muted">{$t('adminContent.status.sug.failed')}</p>
          <Button variant="secondary" icon="refresh" on:click={() => void load(x.type)}>{$t('ui.retry')}</Button>
        {:else}<p class="muted">{$t(r.state === 'off' ? 'adminContent.status.sug.off' : 'adminContent.status.sug.owner')}</p>{/if}
      </div>
    {/each}
  </div>
</AdminCard>

<style>
  .types { display: grid; gap: 1rem 1.6rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
  .one { min-width: 0; }
  h3 { font-size: .95rem; font-weight: 700; margin: 0 0 .4rem; }
  dl { margin: 0; display: grid; gap: .15rem; font-variant-numeric: tabular-nums; }
  dl > div { display: flex; justify-content: space-between; gap: .8rem; border-bottom: 1px solid rgba(255, 255, 255, .06); padding: .15rem 0; }
  dt { color: var(--mut); font-size: .9rem; min-width: 0; overflow-wrap: anywhere; }
  dd { margin: 0; font-weight: 700; flex: none; }
  .hint { margin: .6rem 0 0; font-size: .9rem; padding: .5rem .7rem; border-left: 3px solid var(--warn, #e0a030); background: rgba(255, 255, 255, .04); border-radius: 6px; }
  p { overflow-wrap: anywhere; }
  .muted { margin: 0 0 .5rem; }
</style>
