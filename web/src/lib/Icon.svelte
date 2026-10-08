<script lang="ts">
  /** Small own SVG icon set (stroke icons, 24x24). Decorative unless `label` is given. */
  export let name: string;
  export let size = 24;
  export let label = '';
  export let fill = false;
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'} focusable="false">
  {#if name === 'play'}<path d="M7 4.5v15a1 1 0 001.5.86l12-7.5a1 1 0 000-1.72l-12-7.5A1 1 0 007 4.5z" fill="currentColor" stroke="none" />
  {:else if name === 'plus'}<path d="M12 5v14M5 12h14" />
  {:else if name === 'check'}<path d="M5 13l4 4L19 7" />
  {:else if name === 'info'}<circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
  {:else if name === 'search'}<circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
  {:else if name === 'bell'}<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0" />
  {:else if name === 'chevron-left'}<path d="M15 5l-7 7 7 7" />
  {:else if name === 'chevron-right'}<path d="M9 5l7 7-7 7" />
  {:else if name === 'chevron-down'}<path d="M5 9l7 7 7-7" />
  {:else if name === 'arrow-left'}<path d="M19 12H5M12 19l-7-7 7-7" />
  {:else if name === 'shuffle'}<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  {:else if name === 'heart'}<path d="M12 21s-8-5.2-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 5.8-8 11-8 11z" />
  {:else if name === 'x'}<path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'users'}<circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 010 6M18 15c2 .5 3 2 3 5" />
  {:else if name === 'user'}<circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
  {:else if name === 'monitor'}<path d="M3 5h18v11H3zM8 21h8M12 16v5" />
  {:else if name === 'log-out'}<path d="M9 21H5V3h4M16 17l5-5-5-5M21 12H9" />
  {:else if name === 'bar-chart'}<path d="M5 20V10M12 20V4M19 20v-7" />
  {:else if name === 'calendar'}<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" />
  {:else if name === 'star'}<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z" />
  {:else if name === 'shield'}<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
  {:else if name === 'film'}<path d="M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M16 9h4M4 15h4M16 15h4" />
  {:else if name === 'home'}<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />
  {:else if name === 'menu'}<path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === 'vote'}<path d="M4 8h16v12H4zM8 8V4h8v4M9 13l2 2 4-4" />
  {:else if name === 'gift'}<path d="M4 9h16v4H4zM6 13v7h12v-7M12 9v11M12 9S9 9 9 6.500 12 5 12 9zM12 9s3 0 3-2.500S12 5 12 9z" />
  {/if}
</svg>

<style>svg { display: block; flex: none; }</style>
