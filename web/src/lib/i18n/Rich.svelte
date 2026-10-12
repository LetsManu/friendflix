<script lang="ts">
  import { richParts } from './rich';
  /** an already translated message, e.g. {$t('shell.help.deviceD')} (allowed markup: see rich.ts) */
  export let text: string;
  /** called when one of its internal links is clicked (e.g. to close a dialog) */
  export let onLink: (href: string) => void = () => undefined;
  $: parts = richParts(text);
</script>

{#each parts as p, i (i)}{#if p.kind === 'b'}<b>{p.text}</b>{:else if p.kind === 'kbd'}<kbd>{p.text}</kbd>{:else if p.kind === 'a'}<a href={p.href} on:click={() => onLink(p.href)}>{p.text}</a>{:else}{p.text}{/if}{/each}
