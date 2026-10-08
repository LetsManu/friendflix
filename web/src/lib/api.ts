export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(`API ${status}`);
  }
}

let csrf = '';
export const setCsrf = (t: string) => (csrf = t);

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !location.pathname.startsWith('/invite/')) {
    location.href = '/auth/login';
    await new Promise(() => undefined);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const img = (id: string, w = 300) => `/media/Items/${id}/Images/Primary?maxWidth=${w}&quality=85`;
export const backdrop = (id: string, w = 1600) => `/media/Items/${id}/Images/Backdrop?maxWidth=${w}&quality=80`;
export const logoUrl = (id: string) => `/media/Items/${id}/Images/Logo?maxWidth=700&quality=90`;
export const ticksToSec = (t: number) => t / 10_000_000;
export const secToTicks = (s: number) => Math.floor(s * 10_000_000);
export const fmtMin = (ticks?: number) => (ticks ? `${Math.round(ticks / 600_000_000)} Min.` : '');
export const fmtClock = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`;
};

export interface Item {
  id: string; name: string; type: string; year?: number; overview?: string; runtimeTicks?: number;
  seriesId?: string; seriesName?: string; seasonId?: string; indexNumber?: number; parentIndexNumber?: number;
  genres: string[]; rating?: string; communityRating?: number; premiereDate?: string; image: boolean; backdrop: boolean; logo: boolean;
  played: boolean; favorite: boolean; positionTicks: number; playedPercentage?: number;
}
export interface Me { id: string; name: string; role: string; roleLabel: string; isAdmin: boolean; csrfToken: string; deviceApproved: boolean }
