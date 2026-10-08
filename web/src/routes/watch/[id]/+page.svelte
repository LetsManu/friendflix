<script lang="ts">
  import { page } from '$app/stores';
  import { api, type Item } from '$lib/api';
  import Player from '$lib/Player.svelte';
  let video: HTMLVideoElement | null = null;
  let item: Item | null = null, nextEp: Item | null = null;
  $: id = $page.params.id!;
  $: api(`/api/items/${id}`).then(async (r) => {
    item = r.item; nextEp = null;
    if (item?.type === 'Episode' && item.seriesId) nextEp = (await api(`/api/library/nextup`)).items.find((e: Item) => e.seriesId === item!.seriesId && e.id !== id) ?? null;
  });
</script>
{#if item}<h2>{item.seriesName ? `${item.seriesName} – ` : ''}{item.name}</h2>{/if}
{#key id}
  <Player itemId={id} bind:video on:ended={() => nextEp && (location.href = `/watch/${nextEp.id}`)} />
{/key}
{#if nextEp}<p><a class="btn sec" href="/watch/{nextEp.id}">Nächste Folge ▶</a></p>{/if}
