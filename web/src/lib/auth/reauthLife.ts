// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The clean-up rule of ReauthDialog.svelte: a re-authentication holds provider sessions (a password attempt and, with the passkey
 * alternative, a prepared passkey attempt) until it is finished or cancelled. Closing the dialog in any state after a start came back
 * (a step, a refused passkey) cancels it. Nothing is cancelled that does not exist: closing before the first start was sent sends no
 * request at all (the flow cookies may not even be set yet, and the server would answer 403), and closing while a start is in flight
 * leaves the cancel to that start's return (`started()`), when its jar and the CSRF cookie exist.
 */
export interface ReauthLife {
  /** the flow ended on its own (accepted, or its success screen is showing): nothing is left to cancel */
  finish(): void;
  /** the dialog is closed: cancels unless the flow already ended or no start has come back yet */
  close(): Promise<void>;
  /** about to send a start: false (send nothing) when the dialog was closed meanwhile */
  starting(): boolean;
  /** a start came back: false (and the new sessions are cancelled) when the dialog was closed meanwhile */
  started(): boolean;
}

export function reauthLife(cancel: () => Promise<unknown>): ReauthLife {
  let over = false;
  let inFlight = 0;
  let opened = false;
  return {
    finish() { over = true; },
    async close() {
      const live = !over;
      over = true;
      if (live && opened && inFlight === 0) await cancel().catch(() => undefined);
    },
    starting() {
      if (over) return false;
      inFlight++;
      return true;
    },
    started() {
      if (inFlight > 0) inFlight--;
      opened = true;
      if (!over) return true;
      void cancel().catch(() => undefined);
      return false;
    },
  };
}
