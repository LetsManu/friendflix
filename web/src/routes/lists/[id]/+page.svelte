<script lang="ts">
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  import { goto } from '$app/navigation';
  import { api } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { loadList, removeFromList, removeMember, roleLabel, setMember, type ListDetail } from '#lib/lists';

  const page = pageStore();
  $: id = $page.params.id!;
  let data: ListDetail | null = null, missing = false, err = '';
  let editing = false, name = '', desc = '';
  let friends: Array<{ id: string; name: string }> = [], pick = '', pickRole: 'editor' | 'viewer' = 'viewer';

  async function load() {
    try { data = await loadList(id); missing = false; } catch { missing = true; }
  }
  onMount(async () => {
    await load();
    if (data?.list.role === 'owner') api('/api/friends').then((r) => (friends = r.friends)).catch(() => undefined);
  });
  $: owner = data?.list.role === 'owner';
  $: canEdit = data?.list.role === 'owner' || data?.list.role === 'editor';
  $: candidates = friends.filter((f) => !data?.members.some((m) => m.id === f.id));

  async function run(fn: () => Promise<unknown>) {
    err = '';
    try { await fn(); await load(); } catch (e: any) { err = ({ too_many_members: 'Die Liste hat schon 20 Personen.', bad_member: 'Diese Person kann nicht eingeladen werden.' } as Record<string, string>)[e?.body?.error] ?? 'Das hat nicht geklappt.'; }
  }
  const remove = (itemId: string) => run(() => removeFromList(id, itemId));
  const invite = () => pick && run(async () => { await setMember(id, pick, pickRole); pick = ''; });
  async function save() {
    await run(() => api(`/api/lists/${id}`, { method: 'PATCH', body: { name: name.trim(), description: desc.trim() || null } }));
    if (!err) editing = false;
  }
  function startEdit() { name = data!.list.name; desc = data!.list.description ?? ''; editing = true; }
  async function del() {
    if (!confirm(`Liste „${data!.list.name}“ für alle löschen?`)) return;
    try { await api(`/api/lists/${id}`, { method: 'DELETE' }); await goto('/lists'); } catch { err = 'Das hat nicht geklappt.'; }
  }
  async function leave(userId: string) {
    if (!confirm(userId === me ? 'Liste verlassen?' : 'Mitglied entfernen?')) return;
    try { await removeMember(id, userId); if (userId === me) await goto('/lists'); else await load(); } catch { err = 'Das hat nicht geklappt.'; }
  }
  let me = '';
  onMount(() => { api('/api/me').then((r) => (me = r.id ?? '')).catch(() => undefined); });
</script>

<svelte:head><title>{data?.list.name ?? 'Liste'} – FriendFlix</title></svelte:head>
{#if missing}
  <h1>Liste nicht gefunden</h1><a class="btn" href="/lists">Zu den Listen</a>
{:else if !data}
  <div class="tiles">{#each Array(6) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else}
  <div class="head">
    <div>
      {#if editing}
        <form on:submit|preventDefault={save}>
          <input type="text" maxlength="60" aria-label="Name" bind:value={name} />
          <input type="text" maxlength="280" aria-label="Beschreibung" placeholder="Beschreibung (optional)" bind:value={desc} />
          <button type="submit" disabled={!name.trim()}>Speichern</button>
          <button type="button" class="sec" on:click={() => (editing = false)}>Abbrechen</button>
        </form>
      {:else}
        <h1>{data.list.name}</h1>
        {#if data.list.description}<p class="muted">{data.list.description}</p>{/if}
        <p class="muted">{roleLabel[data.list.role]} · von {data.list.owner.name}</p>
      {/if}
    </div>
    <div class="acts">
      {#if owner && !editing}<button class="sec" on:click={startEdit}>Umbenennen</button><button class="sec" on:click={del}>Liste löschen</button>{/if}
      {#if !owner}<button class="sec" on:click={() => leave(me)} disabled={!me}>Liste verlassen</button>{/if}
    </div>
  </div>
  {#if err}<p class="err" role="alert">{err}</p>{/if}
  {#if data.hiddenCount}<p class="muted">{data.hiddenCount} {data.hiddenCount === 1 ? 'Titel ist' : 'Titel sind'} für dieses Profil nicht sichtbar.</p>{/if}

  {#if !data.items.length}<p class="muted">Noch keine Titel. Füge welche über das Listen-Symbol bei einem Titel hinzu.</p>
  {:else}
    <div class="tiles">
      {#each data.items as i (i.id)}
        <div class="slot">
          <Card item={{ ...i, caption: (i.addedBy ? `von ${i.addedBy.name}` : '') + (i.note ? (i.addedBy ? ' · ' : '') + i.note : '') || undefined }} />
          {#if canEdit}<button class="sec rm" on:click={() => remove(i.id)} aria-label={`${i.name} aus der Liste entfernen`}>Entfernen</button>{/if}
        </div>
      {/each}
    </div>
  {/if}

  <section class="members">
    <h2>Mitglieder</h2>
    <ul>
      {#each data.members as m (m.id)}
        <li><span>{m.name}</span><span class="badge">{roleLabel[m.role]}</span>
          {#if owner && m.role !== 'owner'}
            <select aria-label={`Rolle von ${m.name}`} value={m.role} on:change={(e) => run(() => setMember(id, m.id, e.currentTarget.value as 'editor' | 'viewer'))}>
              <option value="editor">Bearbeiter</option><option value="viewer">Leser</option>
            </select>
            <button class="sec" on:click={() => leave(m.id)}>Entfernen</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if owner}
      <form class="invite" on:submit|preventDefault={invite}>
        <select aria-label="Person einladen" bind:value={pick}><option value="">Person einladen …</option>{#each candidates as f}<option value={f.id}>{f.name}</option>{/each}</select>
        <select aria-label="Rolle" bind:value={pickRole}><option value="viewer">Leser</option><option value="editor">Bearbeiter</option></select>
        <button type="submit" disabled={!pick}>Einladen</button>
      </form>
    {/if}
  </section>
{/if}

<style>
  .head { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
  .acts { display: flex; gap: .5rem; flex-wrap: wrap; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; }
  .muted { color: var(--mut); }
  .err { color: var(--err, #e5646e); }
  .rm { margin-top: .4rem; }
  .members { margin-top: 2rem; max-width: 640px; }
  .members ul { list-style: none; padding: 0; margin: 0 0 1rem; }
  .members li { display: flex; gap: .6rem; align-items: center; padding: .4rem 0; flex-wrap: wrap; }
  .badge { font-size: .72rem; border: 1px solid rgba(255,255,255,.4); padding: 0 .4rem; border-radius: 3px; }
</style>
