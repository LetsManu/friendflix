// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The clean-up rule of ReauthDialog.svelte: a re-authentication holds provider sessions (a password attempt and, with the passkey
 * alternative, a prepared passkey attempt) until it is finished or cancelled. Closing the dialog in any state before that (loading, a step,
 * a refused passkey) cancels it, and so does a start that returns after the dialog was closed.
 */
export interface ReauthLife {
  /** the flow ended on its own (accepted, or its success screen is showing): nothing is left to cancel */
  finish(): void;
  /** the dialog is closed: cancels unless the flow already ended */
  close(): Promise<void>;
  /** a start came back: false (and the new sessions are cancelled) when the dialog was closed meanwhile */
  started(): boolean;
}

export function reauthLife(cancel: () => Promise<unknown>): ReauthLife {
  let over = false;
  return {
    finish() { over = true; },
    async close() {
      const live = !over;
      over = true;
      if (live) await cancel().catch(() => undefined);
    },
    started() {
      if (!over) return true;
      void cancel().catch(() => undefined);
      return false;
    },
  };
}
