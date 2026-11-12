<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The *Eigene Streams* card (spec §9.1, §3.5): one row per own feed. A pulled feed shows its kind; a push feed its port, the
   * stream-id hint ("ff-AB12CD…"), the state chip *Sendet* / *Keine Übertragung* (from livetv's ingest state), the rejected
   * handshakes of the last hour, and "Port {p} liegt nicht mehr im Bereich" when `LIVETV_SRT_PORTS` moved away from it. Menu:
   * *Zugangsdaten neu erzeugen* (confirm, then the one-time result), *Neuen Port zuweisen*, *Löschen* (confirm; frees the port).
   * Under the rows the line naming the UDP ports. The chips and the ports line keep their place while the ingest state loads.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { busyKeys, runAction } from '#lib/ui/action';
  import ActionMenu from '#lib/ui/ActionMenu.svelte';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import { deleteChannel, ingestView, listFeeds, newCredentials, newPort, type FeedChannel, type IngestView, type PushResult, type SourceView } from './api';
  import { portsLine } from './sources';

  export let source: SourceView;

  const dispatch = createEventDispatcher<{ add: HTMLElement | null; result: { name: string; push: PushResult; trigger: HTMLElement | null } }>();

  let feeds: FeedChannel[] | null = null, failed = false;
  /** null while loading; false = livetv did not answer (the chips say "unknown") */
  let ingest: IngestView | null | false = null;

  export async function reload() {
    try { feeds = (await listFeeds(source.id)).channels; failed = false; } catch { failed = true; }
    try { ingest = await ingestView(); } catch { ingest = false; }
  }
  onMount(reload);

  $: stateOf = (id: string) => (ingest ? ingest.feeds.find((f) => f.channelId === id) ?? null : null);
  $: ports = ingest ? portsLine(ingest.ports) : '';

  /** the row's menu button: the result sheet gives the focus back to it */
  let list: HTMLUListElement | undefined;
  const menuOf = (f: FeedChannel): HTMLElement | null => {
    const btns = list?.querySelector(`li[data-feed="${CSS.escape(f.id)}"] .side`)?.querySelectorAll('button');
    return btns?.length ? btns[btns.length - 1]! : null;
  };
  async function regenerate(f: FeedChannel) {
    const trigger = menuOf(f);
    if (!(await confirm({ title: tr('adminLive.push.regenerate'), body: tr('adminLive.push.regenerateBody'), confirmLabel: tr('adminLive.push.regenerate') }))) return;
    const r = await runAction({ key: `ltv-feed:${f.id}`, run: () => newCredentials(f.id) });
    if (r.ok && r.value) dispatch('result', { name: f.name, push: r.value, trigger });
  }
  async function movePort(f: FeedChannel) {
    const r = await runAction({ key: `ltv-feed:${f.id}`, run: () => newPort(f.id), success: (v) => tr('adminLive.push.portMoved', { port: String(v?.port ?? '') }) });
    if (r.ok) await reload();
  }
  async function remove(f: FeedChannel) {
    const ok = await confirm({ title: tr('adminLive.push.deleteTitle', { name: f.name }), body: f.push ? tr('adminLive.push.deleteBodyPush') : tr('adminLive.push.deleteBody'), danger: true, confirmLabel: tr('adminLive.push.delete') });
    if (!ok) return;
    const r = await runAction({
      key: `ltv-feed:${f.id}`,
      apply: () => { const prev = feeds; feeds = (feeds ?? []).filter((x) => x.id !== f.id); return () => { feeds = prev; }; },
      run: () => deleteChannel(f.id),
      success: tr('adminLive.push.deleted'),
    });
    if (r.ok) void reload();
  }
  const items = (f: FeedChannel) => [
    ...(f.push ? [
      { id: 'cred', label: tr('adminLive.push.regenerate'), icon: 'key', run: () => regenerate(f) },
      { id: 'port', label: tr('adminLive.push.newPort'), icon: 'refresh', run: () => movePort(f) },
    ] : []),
    { id: 'del', label: tr('adminLive.push.delete'), icon: 'x', danger: true, run: () => remove(f) },
  ];
</script>

<AdminCard title={$t('adminLive.src.kindOwn')}>
  <svelte:fragment slot="actions">
    <Button variant="secondary" icon="plus" on:click={(e) => dispatch('add', e.currentTarget instanceof HTMLElement ? e.currentTarget : null)}>{$t('adminLive.push.add')}</Button>
  </svelte:fragment>
  <p class="kind"><span class="chip">{$t('adminLive.src.kindOwn')}</span></p>

  {#if failed}
    <p class="msg" role="alert"><Icon name="alert" size={18} /><span>{$t('adminLive.push.loadFailed')}</span></p>
  {:else if !feeds}
    <div class="rows" aria-hidden="true"><Skeleton h="3.4rem" /><Skeleton h="3.4rem" /></div>
  {:else if !feeds.length}
    <p class="muted">{$t('adminLive.push.empty')}</p>
  {:else}
    <ul class="rows" bind:this={list}>
      {#each feeds as f (f.id)}
        {@const st = stateOf(f.id)}
        <li class="row" data-feed={f.id}>
          <div class="main">
            <span class="name">{#if f.number !== null}<span class="num">{f.number}</span>{/if}{f.name}</span>
            {#if f.push}
              <span class="facts">
                <span>{$t('adminLive.push.portLine', { port: String(f.push.port) })}</span>
                <code>{f.push.idHint}…</code>
              </span>
              {#if !f.push.inRange}<span class="gone"><Icon name="alert" size={16} />{$t('adminLive.push.portGone', { port: String(f.push.port) })}</span>{/if}
              {#if st && st.rejected1h > 0}<span class="rej">{$t('adminLive.push.rejected', { n: st.rejected1h })}</span>{/if}
            {:else}
              <span class="facts">{$t('adminLive.push.pulled', { kind: $t(`adminLive.push.kinds.${f.kind}`) })}</span>
            {/if}
          </div>
          <div class="side">
            {#if f.push}
              <!-- the chip's box is there before the ingest state arrives -->
              <span class="chipbox">
                {#if ingest === null}<Skeleton w="7.5rem" h="1.5rem" />
                {:else if st}<StatusPill tone={st.state === 'receiving' ? 'ok' : 'muted'} icon={st.state === 'receiving' ? 'cast' : 'x'} label={st.state === 'receiving' ? $t('adminLive.push.receiving') : $t('adminLive.push.idle')} />
                {:else}<StatusPill tone="muted" icon="info" label={$t('adminLive.push.unknown')} />{/if}
              </span>
            {/if}
            <ActionMenu label={$t('adminLive.push.actions', { name: f.name })} title={f.name} busy={$busyKeys.has(`ltv-feed:${f.id}`)} items={items(f)} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="ports" data-ports>{ports}</p>
</AdminCard>

<style>
  .kind { margin: -.4rem 0 .6rem; }
  .chip { display: inline-block; font-size: .78rem; font-weight: 700; padding: .1rem .55rem; border-radius: 99px; border: 1px solid currentColor; }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  .row { display: flex; align-items: center; gap: .6rem 1rem; padding: .55rem .2rem .55rem .8rem; border-radius: 12px; background: rgba(var(--fr-scrim-rgb, 18, 16, 24), .25); min-width: 0; min-height: 3.4rem; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
  .name { font-weight: 700; overflow-wrap: anywhere; }
  .num { font-variant-numeric: tabular-nums; margin-right: .5rem; color: rgba(255, 255, 255, .72); }
  .facts { display: flex; flex-wrap: wrap; gap: .2rem .8rem; font-size: .88rem; color: rgba(255, 255, 255, .85); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  .gone { display: inline-flex; gap: .3rem; align-items: center; font-size: .85rem; font-weight: 600; }
  .gone :global(svg) { color: var(--err); flex: none; }
  .rej { font-size: .85rem; color: rgba(255, 255, 255, .85); }
  .side { flex: none; display: flex; align-items: center; gap: .4rem; }
  .chipbox { display: inline-flex; min-width: 7.5rem; justify-content: flex-end; }
  .msg { display: flex; gap: .45rem; align-items: flex-start; margin: 0; }
  .msg :global(svg) { color: var(--err); flex: none; }
  .muted { margin: 0; }
  /* the ports line holds two lines from the start: it fills in when the ingest state arrives */
  .ports { margin: .8rem 0 0; min-height: 2.6em; line-height: 1.3; font-size: .88rem; color: rgba(255, 255, 255, .85); overflow-wrap: anywhere; }
  @media (max-width: 560px) {
    .row { flex-wrap: wrap; }
    .side { width: 100%; justify-content: space-between; }
    .chipbox { justify-content: flex-start; }
  }
</style>
