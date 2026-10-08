import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { keyFromBase64 } from './crypto.js';
import { migrate } from './db.js';
import { JellyfinClient } from './jellyfin/client.js';
import { JellyfinService } from './jellyfin/service.js';
import { RedisKV } from './kv.js';
import { createAuthentikProvider } from './oidc.js';
import { SeerrClient } from './seerr/client.js';
import { loadRoles } from './roles.js';
import { pollJellyfinSessions } from './routes/internal.js';
import { parties } from './routes/party.js';
import { calendarNotifications, pollTick } from './routes/polls.js';
import { resolveRequestedPolls } from './polls.js';
import type { Ctx } from './ctx.js';

const cfg = loadConfig();
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
await migrate(pool);
const kv = new RedisKV(new Redis(cfg.REDIS_URL));
const encKey = keyFromBase64(cfg.APP_ENC_KEY);
const client = new JellyfinClient(cfg.JELLYFIN_URL, cfg.JELLYFIN_ADMIN_API_KEY);

const ctx: Ctx = {
  cfg, kv, db: pool, encKey, fetchImpl: fetch,
  oidc: await createAuthentikProvider(cfg),
  jf: new JellyfinService(client, kv, encKey),
  seerr: new SeerrClient(cfg.SEERR_URL, cfg.SEERR_API_KEY),
  roles: loadRoles(cfg.ROLE_TEMPLATES),
};

const app = await buildApp(ctx);
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });

const timers: NodeJS.Timeout[] = [];
timers.push(setInterval(() => parties.tick(), 1000));
timers.push(setInterval(() => void pollTick(ctx).catch((e) => app.log.warn({ e }, 'poll tick failed')), 5_000));
timers.push(setInterval(() => void resolveRequestedPolls(ctx).catch((e) => app.log.warn({ e }, 'resolve failed')), 60_000));
timers.push(setInterval(() => void calendarNotifications(ctx).catch((e) => app.log.warn({ e }, 'calendar job failed')), 3600_000));
if (cfg.BACKGROUND_JOBS === 'true') {
  timers.push(setInterval(() => void pollJellyfinSessions(ctx).catch((e) => app.log.warn({ e }, 'session poll failed')), 10_000));
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    timers.forEach(clearInterval);
    void app.close().then(() => process.exit(0));
  });
}
