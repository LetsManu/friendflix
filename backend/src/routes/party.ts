import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { bus } from '../bus.js';
import type { Ctx } from '../ctx.js';
import { clientMsg, PartyRegistry } from '../party.js';
import { randomToken } from '../crypto.js';
import { requireUser, authenticate } from '../session.js';
import { notify } from '../notify.js';

export const parties = new PartyRegistry();

export async function partyRoutes(app: FastifyInstance, ctx: Ctx) {
  await app.register(websocket, { options: { maxPayload: 4096 } });
  const pre = { preHandler: requireUser(ctx) };
  const origin = new URL(ctx.cfg.PUBLIC_URL).origin;

  const roomInfo = (r: ReturnType<PartyRegistry['get']> & object) => ({
    id: r.id, itemId: r.itemId, title: r.title, hostId: r.hostId, members: r.members.size, startAt: r.startAt,
    hostName: r.members.get(r.hostId)?.name,
  });

  app.post('/api/party', pre, async (req, reply) => {
    const b = z.object({ itemId: z.string().regex(/^[0-9a-f]{32}$/), startInMinutes: z.number().int().min(1).max(24 * 60).optional() }).parse(req.body);
    let item;
    try {
      item = await ctx.jf.item(req.user!, b.itemId); // also proves the creator may access it
    } catch {
      return reply.code(404).send({ error: 'item_not_found' });
    }
    const title = item.seriesName ? `${item.seriesName} – ${item.name}` : item.name;
    const room = parties.create({ id: randomToken(9), itemId: item.id, title, hostId: req.user!.id, startAt: b.startInMinutes ? Date.now() + b.startInMinutes * 60_000 : undefined });
    await audit(ctx, req.user!.id, 'party.create', room.id, { title });
    return { id: room.id };
  });

  app.get('/api/party', pre, async () => ({ rooms: [...parties.rooms.values()].map(roomInfo) }));
  // One tap invitation: friends get an in-app notification (and ntfy/Discord if configured) that opens the room.
  app.post('/api/party/:id/invite', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = parties.get((req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!r.members.has(req.user!.id)) return reply.code(403).send({ error: 'not_in_room' });
    const b = z.object({ userIds: z.array(z.string().uuid()).min(1).max(15) }).parse(req.body);
    const targets = (await ctx.db.query<{ id: string }>('select id from users where id = any($1) and id <> $2 and not disabled', [b.userIds, req.user!.id])).rows;
    let sent = 0;
    for (const t of targets) if (await notify(ctx, { userId: t.id, kind: 'party_invite', title: `${req.user!.name} lädt dich zur Watch-Party ein: ${r.title}`, link: `/party/${r.id}`, dedupe: `party-${r.id}-${t.id}`, external: true })) sent++;
    return { sent };
  });
  app.get('/api/party/:id', pre, async (req, reply) => {
    const r = parties.get((req.params as { id: string }).id);
    return r ? roomInfo(r) : reply.code(404).send({ error: 'not_found' });
  });

  app.get('/ws/party/:id', { websocket: true, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (socket, req) => {
    // Cross-site WebSocket hijacking guard: browsers always send Origin on WS handshakes.
    if (req.headers.origin !== origin || !(await authenticate(ctx, req)) || !req.session!.deviceApproved) return socket.close(4401, 'unauthorized');
    const room = parties.get((req.params as { id: string }).id);
    if (!room) return socket.close(4404, 'room not found');
    if (room.members.size >= 20 && !room.members.has(req.user!.id)) return socket.close(4409, 'room full');
    const user = req.user!;
    const send = (m: unknown) => socket.readyState === 1 && socket.send(JSON.stringify(m));
    room.join(user.id, user.name, send);
    bus.emitT('party.join', { userId: user.id, roomId: room.id });

    let alive = true;
    socket.on('pong', () => (alive = true));
    const hb = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on('message', (raw: Buffer) => {
      let parsed;
      try {
        parsed = clientMsg.safeParse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      room.handle(user.id, parsed.data);
      if (parsed.data.t === 'chat') bus.emitT('party.chat', { userId: user.id, roomId: room.id });
    });
    socket.on('close', () => {
      clearInterval(hb);
      // only remove if this socket is still the current one for the member
      const m = room.members.get(user.id);
      if (m && m.send === send) room.leave(user.id);
    });
  });
}
