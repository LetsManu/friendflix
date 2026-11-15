<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The start page of a person with neither a library nor a Live-TV channel (roles redesign §3.2): one calm line instead of empty
   * rows. The page asks the server for nothing; the header still offers the account pages.
   */
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
</script>

<section class="none" aria-labelledby="noaccess-h">
  <span class="ic" aria-hidden="true"><Icon name="lock" size={32} /></span>
  <h1 id="noaccess-h">{$t('home.noAccess.title')}</h1>
  <p>{$t('home.noAccess.body')}</p>
</section>

<style>
  .none { min-height: 70vh; min-height: 70dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .6rem; padding: calc(var(--nav-total, 64px) + 2rem) var(--pad-x) 3rem; text-align: center; }
  .ic { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; background: rgba(255, 255, 255, .08); color: var(--mut); }
  h1 { margin: .4rem 0 0; font-size: clamp(1.4rem, 3.5vw, 2rem); line-height: 1.25; }
  p { margin: 0; color: var(--mut); max-width: 32rem; }
</style>
