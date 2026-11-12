<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { t, type TKey } from '#lib/i18n';

  /**
   * The footer hint line of the TV list (spec §11.3): the keys the remote can use here, joined by " · ". The caller passes only
   * what `hintKeys` allows: the D-pad hints always, a shortcut only after this device sent that key. The line is fixed to the
   * bottom edge with a reserved height, so a hint arriving later moves nothing in the list.
   */
  export let keys: TKey[];

  $: text = keys.map((k) => $t(k)).join(' · ');
</script>

<p class="hintline">{text}</p>

<style>
  /* 1u = 1 px at a 1080p viewport; solid black, white text at .78 (contrast far above 4.5:1) */
  .hintline { --u: calc(100vw / 1920); position: fixed; z-index: 30; left: 0; right: 0; bottom: 0; box-sizing: border-box; height: calc(var(--u) * 72); margin: 0; padding: 0 calc(var(--u) * 64) 0 var(--tv-left, 152px);
    background: #000; color: rgba(255, 255, 255, .78); font-size: calc(var(--u) * 28); line-height: calc(var(--u) * 72); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
</style>
