<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The from → to chips under an audit sentence ("Altersfreigabe: ab 12 → ab 16"; auditText.ts), on the audit page, a person's
   * *Audit-Log* tab and a role's *Verlauf*. `glass`: on the history sheet's glass, the darker scrim fill (it only adds contrast).
   *   {#if s.chips.length}<AuditChips chips={s.chips} />{/if}
   */
  import { t } from '#lib/i18n';
  import type { AuditChip } from './auditText';

  export let chips: AuditChip[];
  export let glass = false;
</script>

<ul class="chips" class:glass>
  {#each chips as c (c.label)}<li class="chip">{$t('adminPeople.roles.auditChip', { field: c.label, from: c.from, to: c.to })}</li>{/each}
</ul>

<style>
  .chips { list-style: none; margin: .3rem 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: .4rem; }
  .chip { padding: .2rem .7rem; border-radius: 99px; background: rgba(255, 255, 255, .08); font-size: .85rem; font-weight: 600; overflow-wrap: anywhere; }
  .glass { margin: 0; }
  .glass .chip { border-radius: var(--fr-r-pill, 99px); background: rgba(var(--fr-scrim-rgb), .25); }
</style>
