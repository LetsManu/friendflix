<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * A provider or stream URL typed into a Live-TV sheet (F13): a password-type field with *anzeigen* / *verbergen* (44 px), since such
   * URLs often carry a user name and password. Goes into a `Field` slot:
   *   <Field label="…" let:id let:describedby let:invalid><SecretInput {id} {describedby} {invalid} bind:value={url} /></Field>
   */
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';

  export let id: string;
  export let value = '';
  export let placeholder = '';
  export let disabled = false;
  export let describedby: string | undefined = undefined;
  export let invalid: 'true' | undefined = undefined;
  let shown = false;
</script>

<div class="secret">
  <input {id} type={shown ? 'text' : 'password'} bind:value maxlength={2048} autocomplete="off" spellcheck="false" {placeholder} {disabled}
    aria-describedby={describedby} aria-invalid={invalid} />
  <button type="button" class="eye" aria-pressed={shown} aria-controls={id} {disabled} on:click={() => (shown = !shown)}>
    <Icon name={shown ? 'eye-off' : 'eye'} size={18} /><span>{shown ? $t('adminLive.src.hide') : $t('adminLive.src.show')}</span>
  </button>
</div>

<style>
  .secret { display: flex; gap: .5rem; min-width: 0; }
  .secret input { flex: 1; min-width: 0; }
  .eye { flex: none; min-height: 44px; min-width: 44px; display: inline-flex; align-items: center; gap: .35rem; padding: 0 .8rem; border-radius: 12px; background: rgba(255, 255, 255, .08); color: #fff; border: 1px solid rgba(255, 255, 255, .2); font-weight: 600; }
  .eye:disabled { opacity: .5; }
</style>
