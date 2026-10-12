<script lang="ts">
  import { intlLocale } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, ApiError } from '#lib/api';
  import TrailerButton from '#lib/TrailerButton.svelte';
  import { episodeKey, loadReminders, movieKey, removeReminder } from '#lib/reminders';

  let q = $page.url.searchParams.get('q') ?? '', results: any[] = [], mine: any[] = [], msg = '', busy = false, mineErr = '', requesting = new Set<string>();
  let quota: { limit: number | null; used: number; remaining: number | null; resetsAt: string } | null = null;
  $: full = quota !== null && quota.limit !== null && (quota.remaining ?? 0) <= 0;
  const day = (iso: string) => new Date(iso).toLocaleDateString(intlLocale());
  const limitMsg = (resetsAt: string) => `Limit erreicht – neue Wünsche ab ${day(resetsAt)}`;
  const loadQuota = async () => { try { quota = await api('/api/requests/quota'); } catch { /* optional */ } };
  const label: Record<string, string> = { nicht_angefragt: '', angefragt: 'Angefragt', in_arbeit: 'In Arbeit', teilweise: 'Teilweise verfügbar', verfuegbar: 'Verfügbar', abgelehnt: 'Abgelehnt', entfernt: 'Entfernt' };
  const cls: Record<string, string> = { verfuegbar: 'ok', in_arbeit: 'warn', angefragt: 'warn', abgelehnt: 'err' };

  let reminders: any[] = [];
  const loadRem = async () => { try { reminders = (await api('/api/reminders')).reminders; } catch { reminders = []; } };
  async function unremind(r: any) {
    try { await removeReminder(r.kind === 'tmdb' ? movieKey(r.mediaType, r.tmdbId) : episodeKey(r.itemId), r.id); reminders = reminders.filter((x) => x.id !== r.id); } catch { msg = 'Erinnerung konnte nicht entfernt werden.'; }
  }
  async function loadMine() {
    try { mine = (await api('/api/requests/mine')).requests; mineErr = ''; } catch { mineErr = 'Deine Wünsche konnten nicht geladen werden.'; }
  }
  async function search() {
    if (q.trim().length < 2) return;
    busy = true; msg = '';
    try { results = (await api(`/api/seerr/search?q=${encodeURIComponent(q.trim())}`)).results; } catch { msg = 'Suche derzeit nicht möglich.'; }
    busy = false;
  }
  async function request(r: any) {
    const k = `${r.mediaType}:${r.tmdbId}`;
    if (requesting.has(k)) return;
    requesting.add(k); requesting = requesting; msg = '';
    try {
      await api('/api/requests', { method: 'POST', body: { mediaType: r.mediaType, tmdbId: r.tmdbId } });
      r.status = 'angefragt'; results = results; msg = `„${r.title}“ wurde gewünscht. Ein Admin gibt es frei.`; loadMine(); loadQuota();
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && e.body?.error === 'request_limit') { msg = limitMsg(e.body.resetsAt); loadQuota(); }
      else msg = e instanceof ApiError && e.status === 409 ? 'Dafür gibt es schon einen Wunsch.' : 'Wunsch konnte nicht gestellt werden.';
    }
    requesting.delete(k); requesting = requesting;
  }
  onMount(() => { void loadReminders(); loadRem(); loadMine(); loadQuota(); if (q) search(); });
</script>

<h1>Wünsche</h1>
<form class="flex" on:submit|preventDefault={search}>
  <input placeholder="Film oder Serie suchen …" bind:value={q} style="width:100%;max-width:480px" />
  <button disabled={busy}>Suchen</button>
</form>
{#if quota && quota.limit !== null}<p class:warn={full} class:muted={!full}>{#if full}{limitMsg(quota.resetsAt)}{:else}Noch {quota.remaining} von {quota.limit} Wünschen diesen Monat{/if}</p>{/if}
<div role="status">{#if msg && !(full && msg.startsWith('Limit erreicht'))}<p class="warn">{msg}</p>{/if}</div>
<div class="grid" style="margin-top:1rem">
  {#each results as r}
    <div class="card">
      {#if r.poster}<img loading="lazy" src={r.poster} alt={r.title} />{:else}<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />{/if}
      <div class="t">{r.title}<small>{r.year ?? ''} · {r.mediaType === 'tv' ? 'Serie' : 'Film'}</small>
        {#if r.status === 'nicht_angefragt' || r.status === 'abgelehnt'}<button style="margin-top:.4rem;width:100%" disabled={full || requesting.has(`${r.mediaType}:${r.tmdbId}`)} on:click={() => request(r)}>Wünschen</button>
        {:else}<span class={cls[r.status]}>{label[r.status]}</span>{/if}
        {#if r.status !== 'verfuegbar'}<div style="margin-top:.4rem"><TrailerButton mediaType={r.mediaType} tmdbId={r.tmdbId} title={r.title} /></div>{/if}
      </div>
    </div>
  {/each}
</div>
<h2 style="margin-top:2rem">Meine Wünsche</h2>
{#if mineErr}<p class="err" role="alert">{mineErr} <button type="button" class="sec" on:click={loadMine}>Erneut versuchen</button></p>{:else if !mine.length}<p class="muted">Noch nichts gewünscht.</p>{/if}
<table><tbody>{#each mine as m}<tr><td>{m.title}</td><td>{m.mediaType === 'tv' ? 'Serie' : 'Film'}</td><td class={cls[m.status]}>{label[m.status] ?? m.status}</td><td class="muted">{new Date(m.createdAt).toLocaleDateString(intlLocale())}</td></tr>{/each}</tbody></table>
<h2 style="margin-top:2rem">Erinnerungen</h2>
{#if !reminders.length}<p class="muted">Keine aktiven Erinnerungen. Mit „Erinnere mich“ erfährst du, sobald ein Titel verfügbar ist.</p>{/if}
<table><tbody>{#each reminders as r (r.id)}<tr><td>{r.title}</td><td>{r.kind === 'episode' ? 'Folge' : r.mediaType === 'tv' ? 'Serie' : 'Film'}</td><td class="muted">{r.releaseDate ? new Date(r.releaseDate).toLocaleDateString(intlLocale()) : 'Termin offen'}</td><td><button class="sec" aria-label="Erinnerung für {r.title} entfernen" on:click={() => unremind(r)}>Entfernen</button></td></tr>{/each}</tbody></table>
