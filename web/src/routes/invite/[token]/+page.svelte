<script lang="ts">
  import { intlLocale } from '#lib/i18n';
  import Logo from '#lib/Logo.svelte';
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  let info: { roleLabel: string; expiresAt: string; enrollUrl?: string } | null = null, invalid = false;
  const token = $page.params.token!;
  onMount(async () => {
    const r = await fetch(`/api/invite/${token}`);
    if (r.ok) info = await r.json(); else invalid = true;
  });
</script>

<svelte:head><title>Einladung – FriendFlix</title></svelte:head>
<div class="auth">
  <a class="logo" href="/"><Logo wordmark size={40} /></a>
  <main class="card" id="main">
    {#if invalid}
      <h1>Einladung ungültig</h1><p class="muted">Der Link ist abgelaufen oder wurde bereits benutzt. Bitte frag nach einem neuen Link.</p>
    {:else if info}
      <h1>Du wurdest eingeladen</h1>
      <p>Konto-Typ: <b>{info.roleLabel}</b><br /><span class="muted">Gültig bis {new Date(info.expiresAt).toLocaleString(intlLocale())}</span></p>
      {#if info.enrollUrl}
        <p>Lege dein Konto an und richte die Zwei-Faktor-Anmeldung ein (Authenticator-App oder Sicherheitsschlüssel). Danach bist du direkt angemeldet und freigeschaltet.</p>
        <p><a class="btn" href={info.enrollUrl}>Konto anlegen &amp; loslegen</a></p>
        <p class="muted small">Du hast schon ein Konto? <a href="/auth/login?invite={token}">Anmelden &amp; freischalten</a></p>
      {:else}
        <p>Melde dich mit deinem bestehenden Konto an – dein Zugang wird automatisch freigeschaltet.</p>
        <p><a class="btn" href="/auth/login?invite={token}">Anmelden &amp; freischalten</a></p>
      {/if}
      <p class="muted small">Die Zwei-Faktor-Anmeldung (TOTP oder WebAuthn) ist für alle Pflicht.</p>
    {:else}<p class="muted" role="status">Prüfe Einladung …</p>{/if}
  </main>
</div>

<style>
  .auth { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; background: linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,.9)), radial-gradient(circle at 20% 10%, #5a0b14, #000 60%); }
  .logo { display: inline-flex; align-self: flex-start; }
  .card { background: rgba(0,0,0,.78); padding: 2.4rem clamp(1.4rem, 5vw, 4rem); border-radius: 8px; width: min(100%, 460px); margin: auto; }
  h1 { font-size: 2rem; } .small { font-size: .85rem; }
</style>
