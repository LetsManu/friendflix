<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { appName, t, type TKey } from './index';
  import { markParams, richParts } from './rich';
  /**
   * an already translated message without interpolated values, e.g. {$t('shell.help.deviceD')} (allowed markup: see rich.ts). Not for
   * a message with `{app}`: the instance's name would be parsed as markup; use `key` (it inserts the name as a value)
   */
  export let text = '';
  /** or: a message key plus values; the values (and the instance's name for `{app}`) are inserted as plain text after the markup was parsed (never markup) */
  export let key: TKey | null = null;
  export let params: Record<string, string | number | null | undefined> = {};
  /** called when one of its internal links is clicked (e.g. to close a dialog) */
  export let onLink: (href: string) => void = () => undefined;
  $: values = { app: $appName, ...params };
  $: parts = key ? richParts($t(key, markParams(values)), values) : richParts(text);
</script>

{#each parts as p, i (i)}{#if p.kind === 'b'}<b>{p.text}</b>{:else if p.kind === 'kbd'}<kbd>{p.text}</kbd>{:else if p.kind === 'a'}<a href={p.href} on:click={() => onLink(p.href)}>{p.text}</a>{:else}{p.text}{/if}{/each}
