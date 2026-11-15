<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * An updater job's steps as the shared animated list (StepList.svelte, rows only: the card around it has its own progress and
   * result), for Admin → Live-TV (enable / disable / remove). Admin → Update shows its jobs with the full list (bar and note).
   */
  import { t } from '#lib/i18n';
  import StepList from './StepList.svelte';
  import { jobFlow } from './steps';
  import type { StepName, UpdaterJob } from './updater';

  export let job: Pick<UpdaterJob, 'state' | 'step' | 'steps'> & { action: string };
  /** which steps to list; default: the update's (visibleSteps) */
  export let steps: StepName[] | null = null;
  // $t: re-read on a language switch
  $: flow = (void $t, jobFlow({ id: '', from: null, to: '', startedAt: '', finishedAt: null, error: null, ...job } as UpdaterJob, { steps }));
</script>

<StepList {flow} bar={false} note={false} />
