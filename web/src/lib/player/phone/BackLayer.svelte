<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Renderless: while `open`, one shallow history entry (its own token under `key` in page.state) belongs to the open layer, so
   * browser / phone Back closes it (`back`) instead of leaving the page. Closed any other way, the entry is taken back off (one
   * `history.back()`, its popstate ignored). `drop()` pops the entry first and resolves once it is gone, so a navigation that
   * follows (another episode, replacing the watch entry) leaves exactly one Back to the page before the player.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { pushState } from '$app/navigation';
  import { pageStore } from '#lib/page';
  import { registerLayer } from './backlayer';

  export let open = false;
  export let key: 'panel' = 'panel';
  const page = pageStore();
  const dispatch = createEventDispatcher<{ back: void }>();
  let token = '', entered = false, seq = 0;

  const current = () => Boolean(token) && get(page).state[key] === token;
  /** a `history.back()` of ours still on its way: a panel opened meanwhile pushes its entry only after it (or that back pops it) */
  let popping: Promise<void> | null = null;
  function popEntry(): Promise<void> {
    const p = new Promise<void>((r) => {
      const done = () => { clearTimeout(t); removeEventListener('popstate', done); r(); };
      const t = setTimeout(done, 1000); // never hang on a popstate that does not come
      addEventListener('popstate', done);
      history.back(); // its popstate finds no token: ignored
    });
    const q: Promise<void> = p.then(() => { if (popping === q) popping = null; });
    popping = q;
    return q;
  }
  function push() {
    if (!open || token) return;
    token = `${key}:${++seq}:${Date.now()}`;
    entered = false;
    try { pushState('', { ...get(page).state, [key]: token }); } catch { token = ''; } // the router is not ready yet: no entry
  }
  $: sync(open);
  function sync(o: boolean) {
    if (typeof window === 'undefined') return;
    if (o && !token) {
      if (popping) void popping.then(push); else push();
    } else if (!o && token) {
      const pushed = current();
      token = ''; entered = false;
      if (pushed) void popEntry();
    }
  }
  // Back popped our entry (the state held the token and no longer does): the layer closes, the page stays
  $: watch($page.state[key]);
  function watch(st: string | undefined) {
    if (!token) return;
    if (st === token) entered = true;
    else if (entered) { token = ''; entered = false; dispatch('back'); }
  }
  /** takes the entry off (if it is still the current one) and resolves once the browser has popped it */
  export function drop(): Promise<void> {
    const pushed = current();
    token = ''; entered = false;
    if (!pushed) return popping ?? Promise.resolve();
    return popEntry();
  }
  onMount(() => registerLayer(drop));
  // unmounted with the entry still current (the page stays, the player goes): take it off, so Back is not spent on nothing.
  // After a navigation the state no longer holds the token, so nothing is popped then.
  onDestroy(() => { if (typeof window !== 'undefined' && current()) { token = ''; history.back(); } });
</script>
