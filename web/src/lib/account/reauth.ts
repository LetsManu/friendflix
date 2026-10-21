// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-authentication for sensitive account actions (backend reauth.ts): such an action answers 401 `reauth_required`
 * (api() does not treat it as a lost session). The page asks for a fresh sign-in with `reauthenticate(next)`, which happens in place:
 * the in-app dialog (ReauthDialog through the one <ReauthHost/> in the root layout) runs the sign-in inside FriendFlix, and the page
 * repeats its action once when it resolves true. Only when the in-app sign-in is not available (the classic sign-in mode, the
 * backend cannot say, or no host is mounted) the browser goes through the classic forced sign-in at the identity provider
 * (/auth/reauth) and back to `next`. A classic sign-in as somebody else comes back as `/me/account?reauth=failed`.
 *
 *   if (isReauthError(e) && again && (await reauthenticate('/me/account?delete=1'))) return remove(false);
 */
import { writable, type Readable } from 'svelte/store';
import { ApiError } from '#lib/api';
import { flowConfig } from '#lib/auth/flow';

/** /auth/reauth URL that returns to `next` (a same-site path; the backend falls back to /me/account for anything else) */
export const reauthHref = (next: string): string => '/auth/reauth?next=' + encodeURIComponent(next);

/** the classic forced sign-in (the identity provider's own page); the page leaves */
export function startReauth(next: string): void {
  location.href = reauthHref(next);
}

/** true for the 401 `reauth_required` answer of an action that needs a recent sign-in */
export const isReauthError = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 401 && (e.body as { error?: unknown } | null)?.error === 'reauth_required';

/** the open in-app re-authentication: `next` is where the dialog's own redirects (passkey, classic fallback) come back to */
export interface ReauthRequest { id: number; next: string }

const cur = writable<ReauthRequest | null>(null);
let active: { req: ReauthRequest; done: Promise<boolean>; resolve: (ok: boolean) => void } | null = null;
let hosts = 0, seq = 0;
/** read through a function: `active` changes across an await, which narrowing does not see */
const current = () => active;

/** the open request, for the host */
export const reauthRequest: Readable<ReauthRequest | null> = { subscribe: cur.subscribe };

/** whether the in-app re-authentication can run here: a mounted host and the in-app sign-in mode (backend loginUi 'app') */
export async function inAppReauth(): Promise<boolean> {
  if (!hosts) return false;
  try {
    return (await flowConfig()).mode === 'app';
  } catch {
    return false; // the backend cannot say: the classic page always works
  }
}

/**
 * Asks for a fresh sign-in, in place. Resolves true once the person signed in again (repeat the action once; a second
 * `reauth_required` is an error, not another round), false when they gave up. Without the in-app sign-in it starts the classic
 * redirect to `next` and never settles (the page leaves, like api() on a lost session). A request while one is open shares it.
 */
export async function reauthenticate(next: string): Promise<boolean> {
  if (active) return active.done;
  if (!(await inAppReauth())) {
    startReauth(next);
    return new Promise<boolean>(() => {});
  }
  const opened = current(); // another caller may have opened it while the config loaded
  if (opened) return opened.done;
  let resolve!: (ok: boolean) => void;
  const done = new Promise<boolean>((r) => { resolve = r; });
  active = { req: { id: ++seq, next }, done, resolve };
  cur.set(active.req);
  return done;
}

/** the host's answer: true = signed in again, false = closed */
export function finishReauth(ok: boolean): void {
  if (!active) return;
  const a = active;
  active = null;
  cur.set(null);
  a.resolve(ok);
}

/** The host registers itself (so reauthenticate() knows a dialog can open); returns the unregister function. */
export function registerReauthHost(): () => void {
  hosts++;
  return () => {
    hosts--;
    if (!hosts) finishReauth(false);
  };
}
