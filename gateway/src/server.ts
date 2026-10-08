import { readFileSync } from 'node:fs';
import { createGateway } from './gateway.js';

/** Reads VAR or the file referenced by VAR_FILE (Docker secrets). */
const need = (k: string) => {
  const f = process.env[`${k}_FILE`];
  const v = f ? readFileSync(f, 'utf8').trim() : process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const { server } = createGateway({
  jellyfinUrl: need('JELLYFIN_URL'),
  backendUrl: need('BACKEND_URL'),
  internalSecret: need('INTERNAL_SECRET'),
  metricsToken: process.env.METRICS_TOKEN || undefined,
});
const port = Number(process.env.PORT ?? 4000);
server.listen(port, '0.0.0.0', () => console.log(`gateway listening on :${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
