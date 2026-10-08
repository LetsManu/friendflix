<script lang="ts">
  import { onMount } from 'svelte';
  import type { Item } from '$lib/api';
  import Row from '$lib/Row.svelte';

  export let title: string;
  export let load: () => Promise<Item[]>;
  export let href = '';
  let items: Item[] | null = null;
  let el: HTMLDivElement;

  /** Fetches only when the row approaches the viewport (keeps the first paint fast, spares Jellyfin). */
  onMount(() => {
    const io = new IntersectionObserver((e) => {
      if (e[0]?.isIntersecting) {
        io.disconnect();
        load().then((r) => (items = r)).catch(() => (items = []));
      }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  });
</script>

<div bind:this={el}><Row {title} {items} {href} /></div>
