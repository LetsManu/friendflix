<script lang="ts">
  import { img, type Item } from '$lib/api';
  export let item: Item;
  $: target = item.type === 'Episode' ? `/watch/${item.id}` : `/item/${item.id}`;
  $: sub = item.type === 'Episode' ? `${item.seriesName ?? ''} S${item.parentIndexNumber ?? '?'}E${item.indexNumber ?? '?'}` : (item.year ?? '');
</script>

<a class="card" href={target}>
  {#if item.image}<img loading="lazy" src={img(item.id)} alt={item.name} />{:else}<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />{/if}
  {#if item.positionTicks && item.runtimeTicks}<div class="bar"><i style="width:{Math.min(100, (item.positionTicks / item.runtimeTicks) * 100)}%"></i></div>{/if}
  <div class="t">{item.name}<small>{sub}</small></div>
</a>
