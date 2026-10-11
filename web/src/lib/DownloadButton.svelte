<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { downloads, fetchOptions, getMe, getSupport, initManager, pause, progressPct, removeDownload, requestDownload, resume, stateLabel, viewFor, type DownloadOptions } from '#lib/offline/manager';
  import { SUPPORT_HINT, type Support } from '#lib/offline/opfs';
  import { fmtBytes, type QualityId } from '#lib/offline/size';

  /** movie or episode id */
  export let itemId: string;
  /** episodes: enables "nächste Folgen" */
  export let seriesId = '';
  /** small icon-only variant for episode rows */
  export let compact = false;

  let support: Support = { ok: false };
  let allowed = false, ready = false;
  let open = false, opts: DownloadOptions | null = null, loading = false, err = '', busy = false;
  let quality: QualityId = 'hd', audioLang = '', subs = new Set<string>(), count = 1;

  onMount(async () => {
    support = getSupport();
    if (support.ok) {
      const me = await getMe();
      allowed = Boolean(me?.downloads?.allowed);
      if (allowed) void initManager();
    } else if (support.reason !== 'tv') {
      allowed = Boolean((await getMe())?.downloads?.allowed);
    }
    ready = true;
  });

  $: v = viewFor($downloads, itemId);
  $: pctNow = v ? progressPct(v) : 0;

  async function openSheet() {
    open = true; err = ''; opts = null; loading = true;
    try {
      opts = await fetchOptions(itemId);
      let saved = '';
      try { saved = localStorage.getItem('ff_dl_quality') ?? ''; } catch { /* ignore */ }
      const ids = opts.qualities.map((q) => q.id);
      quality = (ids.includes(saved as QualityId) ? saved : ids.includes('hd') ? 'hd' : ids[0] ?? 'hd') as QualityId;
      audioLang = '';
      subs = new Set();
      count = 1;
    } catch (e: any) { err = e?.body?.error === 'downloads_disabled' || e?.status === 404 ? 'Downloads sind nicht verfügbar.' : 'Optionen konnten nicht geladen werden.'; }
    loading = false;
  }
  $: est = opts?.qualities.find((q) => q.id === quality)?.estBytes ?? 0;
  $: left = opts ? opts.quota.max - opts.quota.used : 0;
  $: eff = Math.max(1, Math.min(count, left || 1));
  function toggleSub(l: string) { const n = new Set(subs); if (n.has(l)) n.delete(l); else n.add(l); subs = n; }

  async function start() {
    if (!opts) return;
    busy = true; err = '';
    try { localStorage.setItem('ff_dl_quality', quality); } catch { /* ignore */ }
    try {
      await requestDownload(count > 1 && seriesId
        ? { seriesId, fromEpisodeId: itemId, count, quality, audioLang: audioLang || undefined, subLangs: [...subs] }
        : { itemId, quality, audioLang: audioLang || undefined, subLangs: [...subs] });
      open = false;
    } catch (e: any) {
      const code = e?.body?.error;
      err = code === 'quota_exceeded' ? 'Du hast die maximale Anzahl an Downloads erreicht.' : e?.status === 429 ? 'Zu viele Anfragen. Bitte später erneut versuchen.' : 'Download konnte nicht gestartet werden.';
    }
    busy = false;
  }

  let menu = false;
  function main() {
    if (!v) return void openSheet();
    if (v.state === 'downloading' || v.state === 'queued' || v.state === 'preparing') return void (menu = !menu);
    if (v.state === 'paused' || v.state === 'error') return void (menu = !menu);
    if (v.state === 'done') return void (menu = !menu);
    void openSheet();
  }
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { open = false; menu = false; } };
</script>

<svelte:window on:keydown={key} />
{#if ready && support.ok && allowed}
  <span class="dl" class:compact>
    <button type="button" class="dlb" class:sec={!compact} class:on={v?.state === 'done'} aria-haspopup="dialog" aria-label={v ? `Download: ${stateLabel(v)}` : 'Herunterladen'} title={v ? stateLabel(v) : 'Herunterladen'} on:click={main}>
      <Icon name={v?.state === 'done' ? 'check' : 'download'} size={compact ? 20 : 20} />
      {#if !compact}{v ? stateLabel(v) : 'Herunterladen'}{:else if v && v.state !== 'done'}<span class="mini">{v.state === 'preparing' ? v.prep ?? 0 : v.state === 'downloading' ? pctNow : ''}</span>{/if}
    </button>
    {#if v && menu}
      <span class="menu" role="menu">
        <span class="st">{stateLabel(v)}{#if v.state === 'downloading'} · {fmtBytes(v.bytesHave)} von {fmtBytes(v.bytesTotal)}{/if}</span>
        {#if v.state === 'downloading'}<button type="button" role="menuitem" on:click={() => { pause(v.id); menu = false; }}><Icon name="pause" size={16} />Pausieren</button>{/if}
        {#if v.state === 'paused' || v.state === 'error'}<button type="button" role="menuitem" on:click={() => { resume(v.id); menu = false; }}><Icon name="play" size={16} />Fortsetzen</button>{/if}
        {#if v.state === 'done'}<a role="menuitem" href="/downloads">Zu den Downloads</a>{/if}
        <button type="button" role="menuitem" on:click={() => { void removeDownload(v.id); menu = false; }}><Icon name="x" size={16} />{v.state === 'done' ? 'Download löschen' : 'Abbrechen'}</button>
      </span>
    {/if}
    {#if v && v.msg && !compact && v.state !== 'paused'}<span class="muted msg" role="status">{v.msg}</span>{/if}
  </span>
{:else if ready && !support.ok && allowed && support.reason && support.reason !== 'tv' && !compact}
  <span class="muted hint" role="note">{SUPPORT_HINT[support.reason]}</span>
{/if}

{#if open}
  <div class="scrim" on:click={() => (open = false)} role="presentation"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Herunterladen">
    <h3>Herunterladen</h3>
    {#if loading}<div class="skeleton" style="height:8rem"></div>
    {:else if opts}
      <fieldset>
        <legend>Qualität</legend>
        {#each opts.qualities as q}
          <label class="opt"><input type="radio" name="q-{itemId}" value={q.id} bind:group={quality} /><span>{q.label}</span>{#if q.estBytes}<span class="muted">ca. {fmtBytes(q.estBytes * (count > 1 ? eff : 1))}</span>{/if}</label>
        {/each}
      </fieldset>
      {#if seriesId}
        <label class="row">Folgen
          <select bind:value={count}>
            <option value={1}>Nur diese Folge</option>
            {#each [3, 5, 10] as n}<option value={n}>Diese + nächste {n - 1} Folgen</option>{/each}
          </select>
        </label>
      {/if}
      {#if opts.audio.length > 1}
        <label class="row">Sprache
          <select bind:value={audioLang}><option value="">Standard</option>{#each opts.audio as a}<option value={a.lang}>{a.title || a.lang}</option>{/each}</select>
        </label>
      {/if}
      {#if opts.subtitles.length}
        <fieldset><legend>Untertitel</legend>
          <div class="subs">{#each opts.subtitles as s}<label class="chk"><input type="checkbox" checked={subs.has(s.lang)} on:change={() => toggleSub(s.lang)} />{s.title || s.lang}</label>{/each}</div>
        </fieldset>
      {/if}
      <p class="muted small">{opts.quota.used} von {opts.quota.max} Downloads belegt · gültig {opts.days} Tage{#if est} · ca. {fmtBytes(est * eff)} insgesamt{/if}</p>
      {#if left <= 0}<p class="err" role="alert">Du hast die maximale Anzahl an Downloads erreicht. Lösche einen Download unter „Downloads“.</p>{/if}
      <p class="muted small">Der Server bereitet die Datei zuerst vor, das kann etwas dauern. Der Tab muss während des Ladens geöffnet bleiben.</p>
    {/if}
    {#if err}<p class="err" role="alert">{err}</p>{/if}
    <div class="flex">
      <button type="button" disabled={!opts || busy || left <= 0} on:click={start}><Icon name="download" size={18} />{busy ? 'Starte …' : 'Herunterladen'}</button>
      <button type="button" class="sec" on:click={() => (open = false)}>Abbrechen</button>
    </div>
  </div>
{/if}

<style>
  .dl { position: relative; display: inline-flex; flex-direction: column; align-items: flex-start; gap: .3rem; }
  .dlb { display: inline-flex; align-items: center; gap: .5rem; }
  .dlb.on { color: var(--ok); }
  .compact .dlb { width: 40px; min-height: 40px; height: 40px; padding: 0; justify-content: center; border-radius: 50%; background: rgba(42,42,42,.7); border: 1px solid rgba(255,255,255,.35); position: relative; }
  .mini { position: absolute; right: -2px; top: -4px; font-size: .62rem; background: var(--acc); color: #fff; border-radius: 8px; padding: 0 .25rem; line-height: 1.2; }
  .mini:empty { display: none; }
  .menu { position: absolute; top: 100%; left: 0; z-index: 30; min-width: 14rem; margin-top: .3rem; display: flex; flex-direction: column; background: var(--surface-2, #2a2a2a); border-radius: 8px; box-shadow: 0 8px 28px #000a; padding: .3rem; }
  .compact .menu { left: auto; right: 0; }
  .menu button, .menu a { display: flex; gap: .5rem; align-items: center; background: none; border: 0; text-align: left; padding: .6rem .7rem; min-height: 44px; border-radius: 6px; color: var(--fg); }
  .menu button:hover, .menu a:hover { background: rgba(255,255,255,.1); }
  .st { padding: .4rem .7rem; font-size: .85rem; color: var(--mut); }
  .msg, .hint { font-size: .85rem; }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 90; }
  .sheet { position: fixed; z-index: 91; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, 94vw); max-height: 90vh; overflow: auto; background: var(--surface); border-radius: 10px; padding: 1.2rem 1.4rem; box-shadow: 0 20px 60px #000; display: grid; gap: .8rem; }
  .sheet h3 { margin: 0; }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: .2rem; } legend { color: var(--mut); font-size: .85rem; margin-bottom: .3rem; }
  .opt { display: flex; gap: .6rem; align-items: center; min-height: 44px; } .opt .muted { margin-left: auto; }
  .row { display: flex; gap: .8rem; align-items: center; justify-content: space-between; } .row select { max-width: 60%; }
  .subs { display: flex; flex-wrap: wrap; gap: .3rem 1rem; } .chk { display: inline-flex; gap: .45rem; align-items: center; min-height: 44px; }
  .small { font-size: .85rem; margin: 0; }
  @media (max-width: 640px) { .sheet { top: auto; bottom: 0; left: 0; transform: none; width: 100vw; border-radius: 12px 12px 0 0; } }
</style>
