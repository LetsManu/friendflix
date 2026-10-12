<script lang="ts">
  /** FriendFlix mark (coral tile, "F" whose middle bar is a play button). `wordmark` adds the lettering next to it. */
  export let size = 32;
  export let wordmark = false;
  export let label = 'FriendFlix';
  /** soft drop shadow (header over video); off by default: a filter per instance costs a paint layer (cards, rows) */
  export let shadow = false;
  const uid = 'ffl' + Math.random().toString(36).slice(2, 7);
</script>

<span class="logo" class:wm={wordmark} class:shadow role={wordmark ? undefined : 'img'} aria-label={wordmark ? undefined : label}>
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="{uid}g" x1="8" y1="2" x2="56" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff6b81" /><stop offset="1" stop-color="#e23c5b" /></linearGradient>
    </defs>
    <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#{uid}g)" />
    <path fill="#fff" d="M19 18a4 4 0 0 1 4-4h23a4 4 0 0 1 0 8H28v28a4.500 4.500 0 0 1-9 0z" />
    <path fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round" d="M33.500 29.500 45.500 36 33.500 42.500z" />
  </svg>
  {#if wordmark}<span class="txt" aria-label={label}>FriendFlix</span>{/if}
</span>

<style>
  .logo { display: inline-flex; align-items: center; gap: .55rem; line-height: 1; }
  svg { flex: none; }
  .shadow svg { filter: drop-shadow(0 2px 6px rgba(0, 0, 0, .45)); }
  .txt { font-weight: 800; letter-spacing: -.01em; font-size: clamp(1.15rem, 2.1vw, 1.55rem); color: #fff; }
  @media (max-width: 420px) { .txt { display: none; } }
</style>
