<svelte:head><title>Profile – FriendFlix</title></svelte:head>
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { AVATARS, avatarBg, initial } from '#lib/avatars';
  import Icon from '#lib/Icon.svelte';
  import PinPad from '#lib/PinPad.svelte';

  interface Profile { id: string; name: string; avatar: string; isOwner: boolean; hasPin: boolean; active: boolean }
  let profiles: Profile[] = [], max = 5, activeId: string | null = null, loaded = false;
  let manage = false, loadErr = '';
  let pinFor: Profile | null = null, pinErr = '', pinBusy = false;
  // editor: null = closed, {} without id = new profile
  let ed: { id?: string; name: string; avatar: string; hasPin: boolean; isOwner: boolean; pin: string; currentPin: string; removePin: boolean } | null = null;
  let edErr = '', edBusy = false;

  $: ownerActive = profiles.some((p) => p.active && p.isOwner);
  $: canCreate = ownerActive && profiles.length < max;
  const canEdit = (p: Profile) => ownerActive || p.active;

  async function load() {
    try {
      const r = await api('/api/profiles');
      profiles = r.profiles; max = r.max ?? 5; activeId = r.activeId ?? null;
      // a session without a chosen profile has no "active" owner: the owner (when unlocked) manages, otherwise nothing to manage
      loadErr = '';
    } catch { loadErr = 'Die Profile konnten nicht geladen werden.'; } finally { loaded = true; }
  }
  onMount(load);

  function done() {
    const next = new URLSearchParams(location.search).get('next');
    location.href = next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
  }

  async function choose(p: Profile, pin?: string) {
    if (manage) return openEdit(p);
    if (p.hasPin && pin === undefined) { pinFor = p; pinErr = ''; return; }
    pinBusy = true; pinErr = '';
    try {
      await api(`/api/profiles/${p.id}/select`, { method: 'POST', body: pin === undefined ? {} : { pin } });
      done();
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : '';
      if (code === 'pin_required') { pinFor = p; pinErr = ''; }
      else if (code === 'pin_wrong') { pinFor = p; pinErr = 'Falsche PIN. Bitte noch einmal versuchen.'; }
      else if (code === 'pin_locked') { pinFor = p; pinErr = 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut probieren.'; }
      else { pinFor = p; pinErr = 'Auswählen hat nicht geklappt. Bitte erneut versuchen.'; }
    } finally { pinBusy = false; }
  }

  function openEdit(p?: Profile) {
    edErr = '';
    ed = p
      ? { id: p.id, name: p.name, avatar: p.avatar, hasPin: p.hasPin, isOwner: p.isOwner, pin: '', currentPin: '', removePin: false }
      : { name: '', avatar: AVATARS[profiles.length % AVATARS.length][0], hasPin: false, isOwner: false, pin: '', currentPin: '', removePin: false };
  }
  const bad = (pin: string) => pin !== '' && !/^\d{4}$/.test(pin);

  async function save() {
    if (!ed) return;
    const name = ed.name.trim();
    if (!name || name.length > 20) { edErr = 'Der Name muss 1 bis 20 Zeichen lang sein.'; return; }
    if (bad(ed.pin) || bad(ed.currentPin)) { edErr = 'Eine PIN besteht aus genau 4 Ziffern.'; return; }
    edBusy = true; edErr = '';
    try {
      let id = ed.id;
      if (!id) {
        const r = await api('/api/profiles', { method: 'POST', body: { name, avatar: ed.avatar, ...(ed.pin ? { pin: ed.pin } : {}) } });
        id = r?.id ?? r?.profile?.id;
      } else {
        const cur = profiles.find((p) => p.id === id);
        if (cur && (cur.name !== name || cur.avatar !== ed.avatar)) await api(`/api/profiles/${id}`, { method: 'PATCH', body: { name, avatar: ed.avatar } });
        if (ed.pin || ed.removePin) {
          await api(`/api/profiles/${id}/pin`, { method: 'PUT', body: { pin: ed.removePin ? null : ed.pin, ...(ed.currentPin ? { currentPin: ed.currentPin } : {}) } });
        }
      }
      ed = null; await load();
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : '';
      edErr = code === 'max_profiles' ? `Es sind höchstens ${max} Profile möglich.`
        : code === 'jellyfin' ? 'Der Medienserver hat das Profil nicht angelegt. Bitte später erneut versuchen.'
        : e instanceof ApiError && e.status === 409 ? 'Dieser Name ist schon vergeben.'
        : code === 'pin_wrong' || (e instanceof ApiError && e.status === 403) ? 'Die aktuelle PIN stimmt nicht.'
        : code === 'pin_locked' ? 'Zu viele Fehlversuche. Bitte später erneut probieren.'
        : 'Speichern hat nicht geklappt.';
    } finally { edBusy = false; }
  }
  async function remove() {
    if (!ed?.id || !confirm(`Profil „${ed.name}“ wirklich löschen? Verlauf, Merkliste und Fortschritt dieses Profils gehen verloren.`)) return;
    edBusy = true; edErr = '';
    try { await api(`/api/profiles/${ed.id}`, { method: 'DELETE' }); ed = null; await load(); }
    catch (e) { edErr = e instanceof ApiError && e.body?.error === 'jellyfin' ? 'Der Medienserver hat das Löschen abgelehnt. Bitte später erneut versuchen.' : 'Löschen hat nicht geklappt.'; }
    finally { edBusy = false; }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && ed && !pinFor) { e.preventDefault(); e.stopPropagation(); ed = null; }
  }
</script>

<svelte:window on:keydown|capture={onKey} />

<div class="wrap" inert={!!pinFor || !!ed}>
  <h1>{manage ? 'Profile verwalten' : 'Wer schaut gerade?'}</h1>
  {#if loadErr}<p class="err" role="alert">{loadErr} <button class="sec" on:click={load}>Erneut laden</button></p>{/if}
  {#if !loaded}
    <div class="grid2"><div class="skeleton sk"></div><div class="skeleton sk"></div></div>
  {:else}
    <div class="grid2" data-nav>
      {#each profiles as p (p.id)}
        <button class="prof" class:cur={p.id === activeId} data-autofocus={p === profiles[0] ? '' : undefined} aria-label="{p.name}{p.hasPin ? ', mit PIN geschützt' : ''}{manage ? ' bearbeiten' : ''}" disabled={pinBusy} on:click={() => choose(p)}>
          <span class="face" style="background:{avatarBg(p.avatar)}">{initial(p.name)}
            {#if p.hasPin}<span class="lock"><Icon name="lock" size={18} /></span>{/if}
            {#if manage && canEdit(p)}<span class="edit">Bearbeiten</span>{/if}
          </span>
          <span class="nm">{p.name}</span>
        </button>
      {/each}
      {#if manage && canCreate}
        <button class="prof" aria-label="Profil hinzufügen" on:click={() => openEdit()}>
          <span class="face add"><Icon name="plus" size={52} /></span><span class="nm">Profil hinzufügen</span>
        </button>
      {/if}
    </div>
    {#if manage && !ownerActive}<p class="muted">Neue Profile anlegen und löschen kann nur das Hauptprofil.</p>{/if}
    <p><button class="sec" on:click={() => (manage = !manage)}>{manage ? 'Fertig' : 'Profile verwalten'}</button></p>
  {/if}
</div>

{#if pinFor}
  <div class="ov" role="dialog" aria-modal="true" aria-label="PIN für {pinFor.name}">
    <div class="box">
      <span class="face sm" style="background:{avatarBg(pinFor.avatar)}">{initial(pinFor.name)}</span>
      <PinPad title="PIN für {pinFor.name}" error={pinErr} busy={pinBusy} on:submit={(e) => pinFor && choose(pinFor, e.detail)} on:cancel={() => (pinFor = null)} />
      {#if pinFor.isOwner}<button type="button" class="sec forgot" on:click={() => (location.href = '/auth/login?resetPin=1')}>PIN vergessen?</button>{/if}
    </div>
  </div>
{/if}

{#if ed}
  <div class="ov" role="dialog" aria-modal="true" aria-label={ed.id ? 'Profil bearbeiten' : 'Profil hinzufügen'}>
    <form class="box ed" on:submit|preventDefault={save}>
      <h2>{ed.id ? 'Profil bearbeiten' : 'Profil hinzufügen'}</h2>
      <span class="face sm" style="background:{avatarBg(ed.avatar)}">{initial(ed.name)}</span>
      <label>Name<input bind:value={ed.name} maxlength="20" autocomplete="off" data-autofocus required /></label>
      <fieldset data-nav>
        <legend>Farbe</legend>
        <div class="cols">
          {#each AVATARS as [key, label, css]}
            <button type="button" class="sw" class:sel={ed.avatar === key} style="background:{css}" aria-label={label} aria-pressed={ed.avatar === key} on:click={() => ed && (ed.avatar = key)}>{#if ed.avatar === key}<Icon name="check" size={20} />{/if}</button>
          {/each}
        </div>
      </fieldset>
      <fieldset>
        <legend>PIN (optional)</legend>
        {#if ed.hasPin}
          <label>Aktuelle PIN<input bind:value={ed.currentPin} inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" /></label>
          <label class="chk"><input type="checkbox" bind:checked={ed.removePin} /> PIN entfernen</label>
        {/if}
        {#if !ed.removePin}<label>{ed.hasPin ? 'Neue PIN (4 Ziffern)' : 'PIN (4 Ziffern)'}<input bind:value={ed.pin} inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" /></label>{/if}
      </fieldset>
      {#if edErr}<p class="err" role="alert">{edErr}</p>{/if}
      <div class="flex">
        <button type="submit" disabled={edBusy}>{edBusy ? 'Speichere …' : 'Speichern'}</button>
        <button type="button" class="sec" on:click={() => (ed = null)}>Abbrechen</button>
        <span class="sp"></span>
        {#if ed.id && ownerActive && !ed.isOwner}<button type="button" class="sec" disabled={edBusy} on:click={remove}>Profil löschen</button>{/if}
      </div>
    </form>
  </div>
{/if}

<style>
  .wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2rem var(--pad-x); gap: 1rem; }
  h1 { font-size: clamp(1.8rem, 4vw, 3rem); font-weight: 500; margin: 0 0 1rem; }
  .grid2 { display: flex; flex-wrap: wrap; justify-content: center; gap: clamp(.8rem, 2.5vw, 2rem); }
  .prof { flex-direction: column; background: transparent; color: var(--mut); width: clamp(96px, 20vw, 160px); padding: .4rem; gap: .6rem; height: auto; font-weight: 400; }
  .prof:hover:not(:disabled), .prof:focus-visible { background: transparent; color: #fff; }
  .prof:hover .face, .prof:focus-visible .face { box-shadow: 0 0 0 4px #fff; }
  .prof.cur .nm { color: #fff; }
  .nm { font-size: 1.05rem; overflow-wrap: anywhere; }
  .face { position: relative; width: 100%; aspect-ratio: 1; border-radius: 8px; display: grid; place-items: center; font-size: clamp(2.2rem, 6vw, 4rem); font-weight: 800; color: #fff; transition: box-shadow var(--t-fast); }
  .face.sm { width: 72px; font-size: 2rem; margin: 0 auto .5rem; }
  .face.add { background: var(--surface-2); color: var(--mut); }
  .lock { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.65); border-radius: 99px; width: 28px; height: 28px; display: grid; place-items: center; }
  .edit { position: absolute; inset: 0; border-radius: 8px; background: rgba(0,0,0,.55); display: grid; place-items: center; font-size: .95rem; font-weight: 600; }
  .sk { width: 140px; height: 140px; }
  .ov { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.88); display: grid; place-items: center; padding: 1rem; overflow-y: auto; }
  .box { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 1.6rem; display: flex; flex-direction: column; align-items: center; max-width: 100%; }
  .ed { width: min(440px, 100%); align-items: stretch; gap: .8rem; text-align: left; }
  .ed h2 { margin: 0; text-align: center; }
  .ed label { display: flex; flex-direction: column; gap: .25rem; }
  .ed label.chk { flex-direction: row; align-items: center; gap: .5rem; }
  fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .5rem; }
  legend { color: var(--mut); font-size: .9rem; padding: 0; margin-bottom: .3rem; }
  .cols { display: flex; flex-wrap: wrap; gap: .5rem; }
  .sw { width: 44px; padding: 0; border-radius: 8px; box-shadow: 0 0 0 1px rgba(255,255,255,.15); }
  .sw.sel { box-shadow: 0 0 0 3px #fff; }
  .sw:hover:not(:disabled) { filter: brightness(1.15); }
  .sp { flex: 1; }
</style>
