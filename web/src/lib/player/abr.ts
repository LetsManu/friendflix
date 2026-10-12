// Adaptive quality decisions. Pure: time comes from the injected now(), no DOM.

export type RungKey = 'original' | '1080p' | '720p' | '480p' | '360p';
export const LADDER: Array<{ key: RungKey; bps: number }> = [
  { key: 'original', bps: Infinity },
  { key: '1080p', bps: 8_000_000 },
  { key: '720p', bps: 4_000_000 },
  { key: '480p', bps: 1_500_000 },
  { key: '360p', bps: 800_000 },
];

export type Decision =
  | { do: 'none' }
  | { do: 'switch'; bps: number; reason: 'stall' | 'network' | 'up' }
  | { do: 'fail' };

const FLOOR = 800_000;
const START = 4_000_000;
const HEADROOM = 0.7; // use at most 70% of the estimate
const UP_FACTOR = 0.6; // step up only with estimate >= next / 0.6
const STALL_MS = 2000;
const STALL_COUNT = 3;
const STALL_WINDOW_MS = 60_000;
const DOWN_COOLDOWN_MS = 10_000;
const UP_HOLD_MS = 30_000;
const UP_EVERY_MS = 60_000;
const UP_BUFFER_SEC = 20;

const FINITE = LADDER.filter((r) => Number.isFinite(r.bps)).map((r) => r.bps);

function highestFinite(limit: number): number {
  for (const b of FINITE) if (b <= limit) return b;
  return FLOOR;
}

/** Rung (bit/s) to start with / aim for. Infinity = original. Never below 360p. */
export function pickRung(estimate: number | null, cap: number, sourceBps?: number): number {
  if (estimate === null) return Math.max(FLOOR, Math.min(START, highestFinite(cap)));
  const usable = estimate * HEADROOM;
  if (sourceBps !== undefined && sourceBps <= cap && sourceBps <= usable) return Infinity;
  return Math.max(FLOOR, highestFinite(Math.min(cap, usable)));
}

export class AbrController {
  private now: () => number;
  private cap: number;
  private pinned: boolean;
  private cur: number;
  private stalls: number[] = [];
  private lastDown = -Infinity;
  private lastUp = -Infinity;
  private upSince: number | null = null;

  constructor(o: { now: () => number; cap: number; pinned?: number }) {
    this.now = o.now;
    this.cap = o.cap;
    this.pinned = o.pinned !== undefined;
    this.cur = o.pinned !== undefined ? o.pinned : pickRung(null, o.cap);
  }

  get current(): number {
    return this.cur;
  }

  onStall(ms: number): Decision {
    const t = this.now();
    this.stalls.push(t);
    this.stalls = this.stalls.filter((s) => t - s <= STALL_WINDOW_MS);
    if (ms > STALL_MS || this.stalls.length >= STALL_COUNT) return this.down('stall', true);
    return { do: 'none' };
  }

  onNetworkError(): Decision {
    return this.down('network', false);
  }

  onTick(s: { estimate: number | null; bufferSec: number }): Decision {
    if (this.pinned) return { do: 'none' };
    const next = this.nextUp();
    if (next === null || s.estimate === null || s.estimate < next / UP_FACTOR) {
      this.upSince = null;
      return { do: 'none' };
    }
    const t = this.now();
    if (this.upSince === null) this.upSince = t;
    if (t - this.upSince < UP_HOLD_MS || s.bufferSec < UP_BUFFER_SEC || t - this.lastUp < UP_EVERY_MS) {
      return { do: 'none' };
    }
    this.cur = next;
    this.lastUp = t;
    this.upSince = null;
    return { do: 'switch', bps: next, reason: 'up' };
  }

  /** lowest finite rung above the current one that the cap allows */
  private nextUp(): number | null {
    for (let i = FINITE.length - 1; i >= 0; i--) {
      if (FINITE[i] > this.cur && FINITE[i] <= this.cap) return FINITE[i];
    }
    return null;
  }

  private down(reason: 'stall' | 'network', cooldown: boolean): Decision {
    if (this.cur <= FLOOR) return { do: 'fail' };
    const t = this.now();
    if (cooldown && t - this.lastDown < DOWN_COOLDOWN_MS) return { do: 'none' };
    const next = LADDER.map((r) => r.bps).find((b) => b < this.cur) ?? FLOOR;
    this.cur = next;
    this.lastDown = t;
    this.stalls = [];
    this.upSince = null;
    return { do: 'switch', bps: next, reason };
  }
}
