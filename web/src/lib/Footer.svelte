<script lang="ts">
  import { FOOTER_COLUMNS } from '#lib/menu';
  import Logo from '#lib/Logo.svelte';
  /** opens the help dialog of the layout */
  export let onHelp: () => void = () => undefined;
</script>

<footer class="foot" aria-label="Fußzeile">
  <div class="inner">
    <nav class="cols" aria-label="Weitere Seiten">
      {#each FOOTER_COLUMNS as col, i (i)}
        <ul>{#each col as [href, label] (href)}<li><a {href}>{label}</a></li>{/each}</ul>
      {/each}
    </nav>
    <div class="meta">
      <button type="button" class="help" on:click={onHelp}>Hilfe</button>
      <span class="brand"><Logo size={18} label="" /> FriendFlix · privat unter Freunden</span>
    </div>
  </div>
</footer>

<style>
  .foot { padding: 3rem var(--pad-x) 2.5rem; color: #808080; font-size: .82rem; }
  .inner { max-width: 980px; margin: 0 auto; }
  .cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0 1.2rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { margin: 0; }
  a { display: inline-flex; align-items: center; min-height: 44px; color: #808080; }
  a:hover { text-decoration: underline; color: #b3b3b3; }
  .meta { display: flex; align-items: center; gap: 1.2rem; margin-top: 1.2rem; flex-wrap: wrap; }
  .help { background: transparent; border: 1px solid #808080; color: #808080; font-weight: 400; font-size: .82rem; min-height: 44px; padding: .3rem .9rem; border-radius: 2px; }
  .help:hover:not(:disabled) { background: transparent; color: #fff; border-color: #fff; }
  .brand { display: inline-flex; align-items: center; gap: .45rem; opacity: .85; }
  @media (max-width: 720px) { .foot { display: none; } }
</style>
