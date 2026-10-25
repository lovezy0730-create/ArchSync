import type { WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PresenceParticipant, WsServerMessage } from '@archsync/contracts';

const PALETTE = [
  '#58a6ff',
  '#3fb950',
  '#bc8cff',
  '#f0883e',
  '#e5534b',
  '#39c5cf',
  '#d2a8ff',
  '#7ee787',
  '#ffa657',
  '#ff7b72',
];

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_MESSAGES_PER_SECOND = 10;

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('presence.update'),
    projectId: z.string().min(1),
    payload: z
      .object({
        cursor: z
          .object({ x: z.number().finite(), y: z.number().finite() })
          .nullable()
          .optional(),
        selectedModuleId: z.string().min(1).nullable().optional(),
        editingField: z.string().max(64).nullable().optional(),
        mode: z.enum(['view', 'edit']).optional(),
      })
      .default({}),
  }),
  z.object({ type: z.literal('presence.ping'), projectId: z.string().min(1) }),
]);

interface Session {
  participant: PresenceParticipant;
  socket: WebSocket;
  msgTimestamps: number[];
}

/**
 * In-memory presence rooms. Sessions are keyed by a server-generated id;
 * the client-declared display name is only a label, never an auth identity.
 */
export class PresenceHub {
  private rooms = new Map<string, Map<string, Session>>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ttlSeconds: number) {}

  start(): void {
    this.sweeper = setInterval(() => this.sweep(), 5_000);
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const room of this.rooms.values()) {
      for (const s of room.values()) s.socket.close(1001, 'server shutdown');
    }
    this.rooms.clear();
  }

  private room(projectId: string): Map<string, Session> {
    const existing = this.rooms.get(projectId);
    if (existing) return existing;
    const created = new Map<string, Session>();
    this.rooms.set(projectId, created);
    return created;
  }

  handleConnection(socket: WebSocket, projectId: string, displayName: string): void {
    const sessionId = `s-${randomUUID().slice(0, 8)}`;
    const color = PALETTE[
      Number.parseInt(createHash('sha256').update(displayName).digest('hex').slice(0, 8), 16) %
        PALETTE.length
    ]!;
    const participant: PresenceParticipant = {
      sessionId,
      userId: `u-${createHash('sha256').update(displayName).digest('hex').slice(0, 8)}`,
      name: displayName,
      color,
      cursor: null,
      selectedModuleId: null,
      editingField: null,
      mode: 'view',
      lastSeenAt: new Date().toISOString(),
    };
    const session: Session = { participant, socket, msgTimestamps: [] };
    this.room(projectId).set(sessionId, session);

    this.send(socket, { type: 'hello', sessionId, userId: participant.userId, color, projectId });
    this.send(socket, { type: 'presence.roster', projectId, participants: this.rosterOf(projectId, sessionId) });
    this.broadcast(projectId, { type: 'presence.changed', projectId, participant }, sessionId);

    socket.on('message', (data: unknown) => {
      const raw = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
      if (raw.length > MAX_MESSAGE_BYTES) return; // silently drop oversized frames
      if (!this.allowRate(session)) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const msg = ClientMessageSchema.safeParse(parsed);
      if (!msg.success) {
        this.send(socket, { type: 'server.error', code: 'invalid_message', message: msg.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      session.participant.lastSeenAt = new Date().toISOString();
      if (msg.data.type === 'presence.ping') return;
      const p = msg.data.payload;
      if (p.cursor !== undefined) session.participant.cursor = p.cursor ?? null;
      if (p.selectedModuleId !== undefined) session.participant.selectedModuleId = p.selectedModuleId ?? null;
      if (p.editingField !== undefined) session.participant.editingField = p.editingField ?? null;
      if (p.mode !== undefined) session.participant.mode = p.mode;
      this.broadcast(projectId, { type: 'presence.changed', projectId, participant: session.participant }, sessionId);
    });

    socket.on('close', () => {
      const room = this.rooms.get(projectId);
      if (room?.delete(sessionId)) {
        this.broadcast(projectId, { type: 'presence.left', projectId, sessionId });
        if (room.size === 0) this.rooms.delete(projectId);
      }
    });
  }

  publishSnapshot(projectId: string, snapshotId: string, version: number): void {
    this.broadcast(projectId, { type: 'snapshot.published', projectId, snapshotId, version });
  }

  rosterOf(projectId: string, excludeSessionId?: string): PresenceParticipant[] {
    const room = this.rooms.get(projectId);
    if (!room) return [];
    return [...room.values()]
      .filter((s) => s.participant.sessionId !== excludeSessionId)
      .map((s) => s.participant);
  }

  onlineCount(projectId: string): number {
    return this.rooms.get(projectId)?.size ?? 0;
  }

  private allowRate(session: Session): boolean {
    const now = Date.now();
    session.msgTimestamps = session.msgTimestamps.filter((t) => now - t < 1_000);
    if (session.msgTimestamps.length >= MAX_MESSAGES_PER_SECOND) return false;
    session.msgTimestamps.push(now);
    return true;
  }

  private sweep(): void {
    const deadline = Date.now() - this.ttlSeconds * 1_000;
    for (const [projectId, room] of this.rooms) {
      for (const [sessionId, s] of room) {
        if (Date.parse(s.participant.lastSeenAt) < deadline) {
          s.socket.close(1000, 'presence timeout');
          room.delete(sessionId);
          this.broadcast(projectId, { type: 'presence.left', projectId, sessionId });
        }
      }
      if (room.size === 0) this.rooms.delete(projectId);
    }
  }

  private send(socket: WebSocket, message: WsServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  private broadcast(projectId: string, message: WsServerMessage, excludeSessionId?: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    for (const [sessionId, s] of room) {
      if (excludeSessionId && sessionId === excludeSessionId) continue;
      this.send(s.socket, message);
    }
  }
}

export function allowedOrigin(origin: string | undefined, host: string): boolean {
  if (!origin) return true; // non-browser clients (tests, tooling)
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === host ||
      (host === 'localhost' && hostname === '127.0.0.1') ||
      (host === '127.0.0.1' && hostname === 'localhost')
    );
  } catch {
    return false;
  }
}
