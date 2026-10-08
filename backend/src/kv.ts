import { Redis } from 'ioredis';

/** Minimal key-value store used for sessions, login state and live playback state. */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Keys starting with prefix. */
  keys(prefix: string): Promise<string[]>;
  ping(): Promise<boolean>;
}

export class RedisKV implements KV {
  constructor(private readonly redis: Redis) {}
  get(key: string) {
    return this.redis.get(key);
  }
  async set(key: string, value: string, ttl: number) {
    await this.redis.set(key, value, 'EX', ttl);
  }
  async del(key: string) {
    await this.redis.del(key);
  }
  async keys(prefix: string) {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`, 'COUNT', 200);
      cursor = next;
      out.push(...batch);
    } while (cursor !== '0');
    return out;
  }
  async ping() {
    return (await this.redis.ping()) === 'PONG';
  }
}

export class MemoryKV implements KV {
  private readonly m = new Map<string, { v: string; exp: number }>();
  private live(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) {
      this.m.delete(key);
      return null;
    }
    return e.v;
  }
  async get(key: string) {
    return this.live(key);
  }
  async set(key: string, value: string, ttl = 3600) {
    this.m.set(key, { v: value, exp: Date.now() + ttl * 1000 });
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async keys(prefix: string) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix) && this.live(k) !== null);
  }
  async ping() {
    return true;
  }
}
