<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  let info: { roleLabel: string; expiresAt: string; enrollUrl?: string } | null = null, invalid = false;
  const token = $page.params.token!;
  onMount(async () => {
    const r = await fetch(`/api/invite/${token}`);
    if (r.ok) info = await r.json(); else invalid = true;
  });
</script>

<svelte:head><title>Einladung – FriendFlix</title></svelte:head>
<div class="auth">
  <a class="logo" href="/">FRIENDFLIX</a>
  <main class="card" id="main">
    {#if invalid}
      <h1>Einladung ungültig</h1><p class="muted">Der Link ist abgelaufen oder wurde bereits benutzt. Bitte frag nach einem neuen Link.</p>
    {:else if info}
      <h1>Du wurdest eingeladen</h1>
      <p>Konto-Typ: <b>{info.roleLabel}</b><br /><span class="muted">Gültig bis {new Date(info.expiresAt).toLocaleString('de-DE')}</span></p>
      <ol>
        {#if info.enrollUrl}<li>Lege zuerst dein Konto an und richte die Zwei-Faktor-Anmeldung ein (Authenticator-App oder Sicherheitsschlüssel).<br /><a class="btn sec" href={info.enrollUrl} target="_blank" rel="noopener">Konto anlegen</a></li>{/if}
        <li>Melde dich danach an – dein Zugang wird automatisch freigeschaltet.<br /><a class="btn" href="/auth/login?invite={token}">Anmelden &amp; freischalten</a></li>
      </ol>
      <p class="muted small">Die Zwei-Faktor-Anmeldung (TOTP oder WebAuthn) ist für alle Pflicht.</p>
    {:else}<p class="muted" role="status">Prüfe Einladung …</p>{/if}
  </main>
</div>

<style>
  .auth { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; background: linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,.9)), radial-gradient(circle at 20% 10%, #5a0b14, #000 60%); }
  .logo { color: var(--acc); font-weight: 900; letter-spacing: .06em; font-size: 2rem; align-self: flex-start; }
  .card { background: rgba(0,0,0,.78); padding: 2.4rem clamp(1.4rem, 5vw, 4rem); border-radius: 8px; width: min(100%, 460px); margin: auto; }
  h1 { font-size: 2rem; } ol { padding-left: 1.2rem; display: grid; gap: 1.4rem; } .small { font-size: .85rem; }
</style>
