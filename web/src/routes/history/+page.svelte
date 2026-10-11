<script lang="ts">
  import { onMount } from 'svelte';
  import { api, img, backdrop, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';

  let items: Item[] | null = null;
  let asking: Item | null = null, error = '';
  onMount(() => { api('/api/history?limit=200').then((r) => (items = r.items)).catch(() => (items = [])); });

  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function label(iso?: string) {
    if (!iso) return 'Früher';
    const d = new Date(iso), diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
    if (diff <= 0) return 'Heute';
    if (diff === 1) return 'Gestern';
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  $: groups = (items ?? []).reduce<Array<{ label: string; items: Item[] }>>((acc, i) => {
    const l = label(i.lastPlayedDate), g = acc[acc.length - 1];
    if (g && g.label === l) g.items.push(i); else acc.push({ label: l, items: [i] });
    return acc;
  }, []);
  const sub = (i: Item) => (i.type === 'Episode' ? `${i.seriesName ?? ''} · S${i.parentIndexNumber ?? '?'}:E${i.indexNumber ?? '?'}` : i.year ? String(i.year) : '');
  const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '');

  async function remove(i: Item, scope: 'item' | 'series') {
    asking = null; error = '';
    const prev = items;
    items = (items ?? []).filter((x) => (scope === 'series' && i.seriesId ? x.seriesId !== i.seriesId && x.id !== i.seriesId : x.id !== i.id));
    try { await api(`/api/history/${i.id}?scope=${scope}`, { method: 'DELETE' }); }
    catch { items = prev; error = 'Entfernen fehlgeschlagen.'; }
  }
  function ask(i: Item) { if (i.type === 'Episode' && i.seriesId) asking = i; else remove(i, 'item'); }
</script>

<svelte:head><title>Verlauf – FriendFlix</title></svelte:head>
<h1>Verlauf</h1>
{#if error}<p class="err" role="alert">{error}</p>{/if}
{#if items === null}<div class="skeleton" style="height:12rem"></div>
{:else if !items.length}<p class="muted">Noch nichts angesehen.</p>
{:else}
  {#each groups as g (g.label)}
    <section>
      <h2>{g.label}</h2>
      <ul>
        {#each g.items as i (i.id)}
          <li>
            <a class="thumb" href={i.type === 'Episode' ? `/watch/${i.id}` : `/item/${i.id}`} aria-label={i.name}>
              {#if i.backdrop}<img loading="lazy" src={backdrop(i.id, 320)} alt="" />{:else if i.image}<img loading="lazy" src={img(i.id, 320)} alt="" />{/if}
            </a>
            <div class="txt">
              <strong>{i.name}</strong>
              <span class="muted">{sub(i)}</span>
              <span class="muted">{time(i.lastPlayedDate)}{i.positionTicks && !i.played ? ' · angefangen' : ''}</span>
            </div>
            <button class="rm" aria-label="Aus Verlauf entfernen" title="Aus Verlauf entfernen" on:click={() => ask(i)}><Icon name="x" size={18} /></button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
{/if}

{#if asking}
  {@const a = asking}
  <div class="dlg" role="dialog" aria-modal="true" aria-label="Aus Verlauf entfernen">
    <div class="box">
      <p>„{a.name}“ aus dem Verlauf entfernen?</p>
      <div class="btns">
        <button on:click={() => remove(a, 'item')}>Nur diese Folge</button>
        <button on:click={() => remove(a, 'series')}>Ganze Serie</button>
        <button class="ghost" on:click={() => (asking = null)}>Abbrechen</button>
      </div>
    </div>
  </div>
{/if}

<style>
  h2 { font-size: 1.05rem; margin: 1.6rem 0 .5rem; color: var(--mut); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  li { display: flex; align-items: center; gap: .8rem; background: var(--surface); border-radius: var(--radius); padding: .4rem .6rem .4rem .4rem; }
  .thumb { flex: 0 0 8rem; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; background: #222; display: block; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .txt { flex: 1; min-width: 0; display: grid; gap: .1rem; }
  .txt strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rm { width: 40px; height: 40px; min-height: 40px; padding: 0; border-radius: 50%; display: grid; place-items: center; background: transparent; border: 1.5px solid rgba(255,255,255,.4); color: #fff; }
  .err { color: var(--err, #e5484d); }
  .dlg { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: grid; place-items: center; z-index: 100; padding: 1rem; }
  .box { background: var(--surface); border-radius: var(--radius); padding: 1.2rem; max-width: 26rem; width: 100%; }
  .btns { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; }
  @media (max-width: 520px) { .thumb { flex-basis: 6rem; } }
</style>
