/**
 * WebSocket transport layer for live collaboration.
 * Manages connection lifecycle and message routing.
 */

type UpdateHandler = (docPath: string, data: Uint8Array, userId: string) => void;
type CursorHandler = (docPath: string, userId: string, anchor: number, head: number) => void;
type SyncVectorHandler = (docPath: string, sv: Uint8Array, userId: string) => void;
type SyncDiffHandler = (docPath: string, diff: Uint8Array, userId: string) => void;
type StatusHandler = (connected: boolean) => void;
type GenericHandler = (docPath: string, data: any, userId: string) => void;

export class CollabTransport {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private userId: string;
  private updateHandlers: UpdateHandler[] = [];
  private cursorHandlers: CursorHandler[] = [];
  private syncVectorHandlers: SyncVectorHandler[] = [];
  private syncDiffHandlers: SyncDiffHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private reviewHandlers: GenericHandler[] = [];
  private permissionHandlers: GenericHandler[] = [];
  private _connected = false;
  private disposed = false;
  private keepaliveInterval: number | null = null;

  constructor(wsUrl: string, userId: string) {
    this.wsUrl = wsUrl;
    this.userId = userId;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.disposed || this.ws) return;

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this._connected = true;
        // Keepalive ping every 5 min to prevent API Gateway idle disconnect (10 min timeout)
        if (this.keepaliveInterval !== null) window.clearInterval(this.keepaliveInterval);
        this.keepaliveInterval = window.setInterval(() => {
          this.send({ action: "ping", ts: Date.now() });
        }, 5 * 60 * 1000);
        this.notifyStatus(true);
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.ws = null;
        if (this.keepaliveInterval !== null) {
          window.clearInterval(this.keepaliveInterval);
          this.keepaliveInterval = null;
        }
        this.notifyStatus(false);
      };

      this.ws.onerror = () => {};

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.userId === this.userId) return; // Ignore own messages

          switch (msg.action) {
            case "update":
              for (const h of this.updateHandlers) {
                h(msg.docPath, base64ToUint8Array(msg.data), msg.userId);
              }
              break;
            case "cursor":
              for (const h of this.cursorHandlers) {
                h(msg.docPath, msg.userId, msg.anchor, msg.head);
              }
              break;
            case "sync-vector":
              for (const h of this.syncVectorHandlers) {
                h(msg.docPath, base64ToUint8Array(msg.sv), msg.userId);
              }
              break;
            case "sync-diff":
              for (const h of this.syncDiffHandlers) {
                h(msg.docPath, base64ToUint8Array(msg.diff), msg.userId);
              }
              break;
            case "review":
              for (const h of this.reviewHandlers) h(msg.docPath, msg, msg.userId);
              break;
            case "permission":
              for (const h of this.permissionHandlers) h(msg.docPath, msg, msg.userId);
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      };
    } catch {
      this._connected = false;
      this.ws = null;
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.keepaliveInterval !== null) {
      window.clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    this.disconnect();
    this.updateHandlers = [];
    this.cursorHandlers = [];
    this.syncVectorHandlers = [];
    this.syncDiffHandlers = [];
    this.statusHandlers = [];
    this.reviewHandlers = [];
    this.permissionHandlers = [];
  }

  subscribe(docPath: string): void {
    this.send({ action: "subscribe", docPath, userId: this.userId });
  }

  unsubscribe(docPath: string): void {
    this.send({ action: "unsubscribe", docPath, userId: this.userId });
  }

  sendUpdate(docPath: string, update: Uint8Array): void {
    this.send({ action: "update", docPath, data: uint8ArrayToBase64(update), userId: this.userId });
  }

  sendCursor(docPath: string, anchor: number, head: number): void {
    this.send({ action: "cursor", docPath, userId: this.userId, anchor, head });
  }

  sendSyncVector(docPath: string, sv: Uint8Array): void {
    this.send({ action: "sync-vector", docPath, sv: uint8ArrayToBase64(sv), userId: this.userId });
  }

  sendSyncDiff(docPath: string, diff: Uint8Array): void {
    this.send({ action: "sync-diff", docPath, diff: uint8ArrayToBase64(diff), userId: this.userId });
  }

  sendReview(docPath: string, data: Record<string, unknown>): void {
    this.send({ action: "review", docPath, userId: this.userId, ...data });
  }

  sendPermission(docPath: string, mode: string): void {
    this.send({ action: "permission", docPath, userId: this.userId, mode });
  }

  onUpdate(handler: UpdateHandler): void { this.updateHandlers.push(handler); }
  onCursor(handler: CursorHandler): void { this.cursorHandlers.push(handler); }
  onSyncVector(handler: SyncVectorHandler): void { this.syncVectorHandlers.push(handler); }
  onSyncDiff(handler: SyncDiffHandler): void { this.syncDiffHandlers.push(handler); }
  onStatus(handler: StatusHandler): void { this.statusHandlers.push(handler); }
  onReview(handler: GenericHandler): void { this.reviewHandlers.push(handler); }
  onPermission(handler: GenericHandler): void { this.permissionHandlers.push(handler); }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private notifyStatus(connected: boolean): void {
    for (const h of this.statusHandlers) h(connected);
  }
}

// ── Base64 helpers ──────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
