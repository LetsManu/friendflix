<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { pageStore } from '#lib/page';
  import { goto } from '$app/navigation';
  import { api } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { autofocus } from '#lib/actions';
  import { isNotFound, loadList, removeFromList, removeMember, roleLabel, setMember, type ListDetail } from '#lib/lists';

  const page = pageStore();
  $: id = $page.params.id!;
  let data: ListDetail | null = null, missing = false, loadFailed = false, err = '';
  let editing = false, name = '', desc = '', renameBtn: HTMLButtonElement | undefined;
  let friends: Array<{ id: string; name: string }> = [], friendsLoaded = false, pick = '', pickRole: 'editor' | 'viewer' = 'viewer';
  /** keys of running mutations (`save`, `invite`, `del`, `rm:<item>`, `role:<user>`, `mem:<user>`): their buttons are disabled meanwhile */
  let busy = new Set<string>();
  const isBusy = (k: string) => busy.has(k);
  const setBusy = (k: string, on: boolean) => { if (on) busy.add(k); else busy.delete(k); busy = busy; };

  /** Only a 404 means the list is gone; other failures keep what is on screen (or offer a retry on first load). */
  async function load() {
    try { data = await loadList(id); missing = false; loadFailed = false; }
    catch (e) {
      if (isNotFound(e)) missing = true;
      else if (data) err = err || 'Die Liste konnte nicht aktualisiert werden.';
      else loadFailed = true;
    }
  }
  async function retry() { loadFailed = false; data = null; await load(); }
  /** refresh after the list was changed through a card's list picker */
  const refresh = (e: CustomEvent<{ listId: string }>) => { if (e.detail.listId === id) void load(); };
  onMount(() => { void load(); api('/api/me').then((r) => (me = r.id ?? '')).catch(() => undefined); });
  $: owner = data?.list.role === 'owner';
  $: member = data?.list.role === 'owner' || data?.list.role === 'editor' || data?.list.role === 'viewer'; // anything else (guest of a featured list) is read-only
  $: canEdit = data?.list.role === 'owner' || data?.list.role === 'editor';
  $: candidates = friends.filter((f) => !data?.members.some((m) => m.id === f.id));
  $: if (owner && !friendsLoaded) { friendsLoaded = true; api('/api/friends').then((r) => (friends = r.friends)).catch(() => (friendsLoaded = false)); }

  const errText = (e: any) => ({ too_many_members: 'Die Liste hat schon 20 Personen.', bad_member: 'Diese Person kann nicht eingeladen werden.' } as Record<string, string>)[e?.body?.error] ?? 'Das hat nicht geklappt.';
  /** runs a mutation, then always re-syncs with the server (also after a failure); resolves true when the mutation succeeded */
  async function run(key: string, fn: () => Promise<unknown>): Promise<boolean> {
    if (isBusy(key)) return false;
    err = ''; setBusy(key, true);
    let ok = true;
    try { await fn(); } catch (e: any) { ok = false; err = errText(e); }
    finally { await load(); setBusy(key, false); }
    return ok;
  }
  const remove = (itemId: string) => run('rm:' + itemId, () => removeFromList(id, itemId));
  const invite = () => pick && run('invite', async () => { await setMember(id, pick, pickRole); pick = ''; });
  async function changeRole(e: Event & { currentTarget: HTMLSelectElement }, m: { id: string; role: string }) {
    const sel = e.currentTarget, value = sel.value as 'editor' | 'viewer';
    if (!(await run('role:' + m.id, () => setMember(id, m.id, value)))) sel.value = m.role; // the select must not keep a role the server refused
  }
  async function save() {
    if (!name.trim()) return;
    if (await run('save', () => api(`/api/lists/${id}`, { method: 'PATCH', body: { name: name.trim(), description: desc.trim() || null } }))) await closeEdit();
  }
  function startEdit() { name = data!.list.name; desc = data!.list.description ?? ''; err = ''; editing = true; }
  async function closeEdit() { editing = false; err = ''; await tick(); renameBtn?.focus(); }
  async function del() {
    if (isBusy('del') || !confirm(`Liste „${data!.list.name}“ für alle löschen?`)) return;
    err = ''; setBusy('del', true);
    try { await api(`/api/lists/${id}`, { method: 'DELETE' }); await goto('/lists'); } catch { err = 'Das hat nicht geklappt.'; }
    setBusy('del', false);
  }
  async function leave(userId: string) {
    if (isBusy('mem:' + userId) || !confirm(userId === me ? 'Liste verlassen?' : 'Mitglied entfernen?')) return;
    err = ''; setBusy('mem:' + userId, true);
    try { await removeMember(id, userId); if (userId === me) await goto('/lists'); else await load(); } catch { err = 'Das hat nicht geklappt.'; }
    setBusy('mem:' + userId, false);
  }
  let me = '';
</script>

<svelte:head><title>{data?.list.name ?? 'Liste'} – FriendFlix</title></svelte:head>
{#if missing}
  <h1>Liste nicht gefunden</h1><a class="btn" href="/lists">Zu den Listen</a>
{:else if loadFailed}
  <h1>Konnte nicht geladen werden</h1>
  <p class="err" role="alert">Die Liste ist gerade nicht erreichbar.</p>
  <button type="button" on:click={retry}>Erneut versuchen</button> <a class="btn sec" href="/lists">Zu den Listen</a>
{:else if !data}
  <div class="tiles">{#each Array(6) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else}
  <div class="head">
    <div>
      {#if editing}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <form on:submit|preventDefault={save} on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); void closeEdit(); } }}>
          <input type="text" maxlength="60" aria-label="Name" bind:value={name} use:autofocus />
          <input type="text" maxlength="280" aria-label="Beschreibung" placeholder="Beschreibung (optional)" bind:value={desc} />
          <button type="submit" disabled={!name.trim() || isBusy('save')}>Speichern</button>
          <button type="button" class="sec" disabled={isBusy('save')} on:click={closeEdit}>Abbrechen</button>
        </form>
      {:else}
        <h1>{data.list.name}</h1>
        {#if data.list.description}<p class="muted">{data.list.description}</p>{/if}
        <p class="muted">{roleLabel[data.list.role] ?? 'Gast'} · von {data.list.owner.name}</p>
      {/if}
    </div>
    <div class="acts">
      {#if owner && !editing}<button class="sec" bind:this={renameBtn} on:click={startEdit}>Umbenennen</button><button class="sec" disabled={isBusy('del')} on:click={del}>Liste löschen</button>{/if}
      {#if member && !owner}<button class="sec" on:click={() => leave(me)} disabled={!me || isBusy('mem:' + me)}>Liste verlassen</button>{/if}
    </div>
  </div>
  {#if err}<p class="err" role="alert">{err}</p>{/if}
  {#if data.hiddenCount}<p class="muted">{data.hiddenCount} {data.hiddenCount === 1 ? 'Titel ist' : 'Titel sind'} für dieses Profil nicht sichtbar.</p>{/if}

  {#if !data.items.length}<p class="muted">{member ? 'Noch keine Titel. Füge welche über das Listen-Symbol bei einem Titel hinzu.' : 'Noch keine Titel.'}</p>
  {:else}
    <div class="tiles">
      {#each data.items as i (i.id)}
        <div class="slot">
          <Card item={{ ...i, caption: (i.addedBy ? `von ${i.addedBy.name}` : '') + (i.note ? (i.addedBy ? ' · ' : '') + i.note : '') || undefined }} on:listchanged={refresh} />
          {#if canEdit}<button class="sec rm" disabled={isBusy('rm:' + i.id)} on:click={() => remove(i.id)} aria-label={`${i.name} aus der Liste entfernen`}>Entfernen</button>{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if member}<section class="members">
    <h2>Mitglieder</h2>
    <ul>
      {#each data.members as m (m.id)}
        <li><span>{m.name}</span><span class="badge">{roleLabel[m.role] ?? m.role}</span>
          {#if owner && m.role !== 'owner'}
            <select aria-label={`Rolle von ${m.name}`} value={m.role} disabled={isBusy('role:' + m.id)} on:change={(e) => changeRole(e, m)}>
              <option value="editor">Bearbeiter</option><option value="viewer">Leser</option>
            </select>
            <button class="sec" disabled={isBusy('mem:' + m.id)} on:click={() => leave(m.id)}>Entfernen</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if owner}
      <form class="invite" on:submit|preventDefault={invite}>
        <select aria-label="Person einladen" bind:value={pick}><option value="">Person einladen …</option>{#each candidates as f}<option value={f.id}>{f.name}</option>{/each}</select>
        <select aria-label="Rolle" bind:value={pickRole}><option value="viewer">Leser</option><option value="editor">Bearbeiter</option></select>
        <button type="submit" disabled={!pick || isBusy('invite')}>Einladen</button>
      </form>
    {/if}
  </section>{/if}
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
