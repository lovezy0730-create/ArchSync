import type {
  PresenceParticipant,
  WsServerMessage,
} from '@archsync/contracts';

export type PresenceStatus = 'connecting' | 'open' | 'closed';

export interface PresenceClientCallbacks {
  onStatus: (status: PresenceStatus) => void;
  onSelf: (info: { sessionId: string; userId: string; color: string }) => void;
  onParticipants: (participants: PresenceParticipant[]) => void;
  onParticipantLeft: (sessionId: string) => void;
  onSnapshotPublished: (version: number) => void;
}

/**
 * Presence WebSocket client with jittered exponential-backoff reconnect.
 * Cursor updates are throttled client-side; the server additionally rate
 * limits at 10 msg/s per session.
 */
export class PresenceClient {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastCursorSend = 0;
  private pendingCursor: { x: number; y: number } | null = null;

  constructor(
    private readonly projectId: string,
    private readonly userName: string,
    private readonly callbacks: PresenceClientCallbacks,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.callbacks.onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws?projectId=${encodeURIComponent(this.projectId)}&user=${encodeURIComponent(this.userName)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.callbacks.onStatus('open');
      this.pingTimer ??= setInterval(() => this.ping(), 15_000);
    };
    ws.onmessage = (event) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as WsServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello':
          this.callbacks.onSelf({ sessionId: msg.sessionId, userId: msg.userId, color: msg.color });
          break;
        case 'presence.roster':
          this.callbacks.onParticipants(msg.participants);
          break;
        case 'presence.changed':
          this.callbacks.onParticipants([msg.participant]);
          break;
        case 'presence.left':
          this.callbacks.onParticipantLeft(msg.sessionId);
          break;
        case 'snapshot.published':
          this.callbacks.onSnapshotPublished(msg.version);
          break;
        case 'server.error':
          console.warn('[archsync ws]', msg.code, msg.message);
          break;
      }
    };
    ws.onclose = () => {
      this.callbacks.onStatus('closed');
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    const base = Math.min(30_000, 500 * 2 ** this.attempts);
    const jitter = Math.random() * 250;
    this.reconnectTimer = setTimeout(() => this.open(), base + jitter);
  }

  sendCursor(position: { x: number; y: number }): void {
    this.pendingCursor = position;
    const now = Date.now();
    if (now - this.lastCursorSend < 50) return;
    this.lastCursorSend = now;
    this.rawSend({
      type: 'presence.update',
      projectId: this.projectId,
      payload: { cursor: this.pendingCursor },
    });
    this.pendingCursor = null;
  }

  flushCursor(): void {
    if (this.pendingCursor) {
      this.rawSend({
        type: 'presence.update',
        projectId: this.projectId,
        payload: { cursor: this.pendingCursor },
      });
      this.pendingCursor = null;
    }
  }

  sendSelection(moduleId: string | null): void {
    this.rawSend({
      type: 'presence.update',
      projectId: this.projectId,
      payload: { selectedModuleId: moduleId },
    });
  }

  sendEditing(editingField: string | null): void {
    this.rawSend({
      type: 'presence.update',
      projectId: this.projectId,
      payload: { editingField, mode: editingField ? 'edit' : 'view' },
    });
  }

  ping(): void {
    this.rawSend({ type: 'presence.ping', projectId: this.projectId });
  }

  private rawSend(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
