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

<main style="max-width:560px;margin-top:10vh">
  <h1 style="color:var(--acc)">FriendFlix</h1>
  {#if invalid}
    <div class="panel"><h2>Einladung ungültig</h2><p class="muted">Der Link ist abgelaufen oder wurde bereits benutzt. Bitte frag nach einem neuen Link.</p></div>
  {:else if info}
    <div class="panel">
      <h2>Du wurdest eingeladen 🎬</h2>
      <p>Konto-Typ: <b>{info.roleLabel}</b><br /><span class="muted">Gültig bis {new Date(info.expiresAt).toLocaleString('de-DE')}</span></p>
      <ol>
        {#if info.enrollUrl}<li>Lege zuerst dein Konto an und richte die Zwei-Faktor-Anmeldung ein (Authenticator-App oder Sicherheitsschlüssel): <a class="btn sec" href={info.enrollUrl} target="_blank" rel="noopener">Konto anlegen</a></li>{/if}
        <li>Melde dich anschließend an. Dein Zugang wird dabei automatisch freigeschaltet.<br /><br /><a class="btn" href="/auth/login?invite={token}">Anmelden &amp; freischalten</a></li>
      </ol>
      <p class="muted">Die Zwei-Faktor-Anmeldung (TOTP oder WebAuthn) ist für alle Pflicht.</p>
    </div>
  {:else}<p class="muted">Prüfe Einladung …</p>{/if}
</main>
