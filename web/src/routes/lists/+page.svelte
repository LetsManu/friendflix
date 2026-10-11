<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { img } from '#lib/api';
  import { createList, loadLists, roleLabel, type ListSummary } from '#lib/lists';
  let lists: ListSummary[] | null = null, creating = false, name = '', err = '', busy = false;
  onMount(() => { loadLists().then((l) => (lists = l)).catch(() => (lists = [])); });
  async function create() {
    if (!name.trim() || busy) return;
    busy = true; err = '';
    try { const { id } = await createList(name.trim()); await goto(`/lists/${id}`); }
    catch (e: any) { err = e?.body?.error === 'too_many_lists' ? 'Du hast schon 20 Listen.' : 'Das hat nicht geklappt.'; }
    busy = false;
  }
</script>
<svelte:head><title>Listen – FriendFlix</title></svelte:head>
<div class="head"><h1>Listen</h1>
  {#if creating}
    <form on:submit|preventDefault={create}>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" maxlength="60" placeholder="Name der Liste" aria-label="Name der Liste" bind:value={name} autofocus />
      <button type="submit" disabled={busy || !name.trim()}>Anlegen</button>
      <button type="button" class="sec" on:click={() => { creating = false; name = ''; }}>Abbrechen</button>
    </form>
  {:else}<button on:click={() => (creating = true)}>Neue Liste</button>{/if}
</div>
{#if err}<p class="err" role="alert">{err}</p>{/if}
<p class="muted">Gemeinsame Listen für dich und deine Freunde. Wer eingeladen ist, sieht nur die Titel, die sein Profil sehen darf.</p>
{#if lists === null}<div class="grid">{#each Array(4) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if !lists.length}<p class="muted">Noch keine Listen. Lege eine neue an oder füge einen Titel über das Listen-Symbol hinzu.</p>
{:else}
  <div class="grid">
    {#each lists as l (l.id)}
      <a class="list" href="/lists/{l.id}">
        <div class="mosaic" aria-hidden="true">
          {#each [0, 1, 2, 3] as n}
            {#if l.coverIds[n]}<img src={img(l.coverIds[n], 200)} alt="" loading="lazy" />{:else}<span></span>{/if}
          {/each}
        </div>
        <div class="info">
          <strong>{l.name}</strong>
          <span class="badge">{roleLabel[l.role]}</span>
          <div class="muted">{l.itemCount} {l.itemCount === 1 ? 'Titel' : 'Titel'} · {l.memberCount} {l.memberCount === 1 ? 'Person' : 'Personen'}{l.role !== 'owner' ? ` · von ${l.owner.name}` : ''}</div>
        </div>
      </a>
    {/each}
  </div>
{/if}

<style>
  .head { display: flex; gap: 1rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; margin-top: 1rem; }
  .list { display: block; background: var(--surface); border-radius: var(--radius); overflow: hidden; color: inherit; text-decoration: none; }
  .list:hover, .list:focus-visible { outline: 2px solid var(--acc); }
  .mosaic { display: grid; grid-template-columns: 1fr 1fr; aspect-ratio: 16 / 9; background: #1a1a1a; }
  .mosaic img, .mosaic span { width: 100%; height: 100%; object-fit: cover; display: block; background: #262626; }
  .info { padding: .7rem .8rem .9rem; }
  .badge { margin-left: .4rem; font-size: .72rem; border: 1px solid rgba(255,255,255,.4); padding: 0 .4rem; border-radius: 3px; }
  .muted { color: var(--mut); font-size: .85rem; margin-top: .25rem; }
  .err { color: var(--err, #e5646e); }
</style>
