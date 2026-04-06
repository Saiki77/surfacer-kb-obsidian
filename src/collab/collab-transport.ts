/**
 * WebSocket transport layer for live collaboration.
 * Manages connection lifecycle and message routing.
 */

export type CollabMessageType = "update" | "cursor" | "subscribe" | "unsubscribe";

export interface CollabUpdateMessage {
  action: "update";
  docPath: string;
  data: string; // base64-encoded Yjs update
  userId: string;
}

export interface CollabCursorMessage {
  action: "cursor";
  docPath: string;
  userId: string;
  anchor: number;
  head: number;
}

export type CollabMessage = CollabUpdateMessage | CollabCursorMessage;

type UpdateHandler = (docPath: string, data: Uint8Array, userId: string) => void;
type CursorHandler = (docPath: string, userId: string, anchor: number, head: number) => void;
type StatusHandler = (connected: boolean) => void;

export class CollabTransport {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private userId: string;
  private updateHandlers: UpdateHandler[] = [];
  private cursorHandlers: CursorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private _connected = false;
  private disposed = false;

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
        this.notifyStatus(true);
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.ws = null;
        this.notifyStatus(false);
      };

      this.ws.onerror = () => {
        // onclose will fire after onerror
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.action === "update" && msg.userId !== this.userId) {
            const bytes = base64ToUint8Array(msg.data);
            for (const handler of this.updateHandlers) {
              handler(msg.docPath, bytes, msg.userId);
            }
          } else if (msg.action === "cursor" && msg.userId !== this.userId) {
            for (const handler of this.cursorHandlers) {
              handler(msg.docPath, msg.userId, msg.anchor, msg.head);
            }
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
    this.disconnect();
    this.updateHandlers = [];
    this.cursorHandlers = [];
    this.statusHandlers = [];
  }

  subscribe(docPath: string): void {
    this.send({ action: "subscribe", docPath, userId: this.userId });
  }

  unsubscribe(docPath: string): void {
    this.send({ action: "unsubscribe", docPath, userId: this.userId });
  }

  sendUpdate(docPath: string, update: Uint8Array): void {
    const data = uint8ArrayToBase64(update);
    this.send({ action: "update", docPath, data, userId: this.userId });
  }

  sendCursor(docPath: string, anchor: number, head: number): void {
    this.send({ action: "cursor", docPath, userId: this.userId, anchor, head });
  }

  onUpdate(handler: UpdateHandler): void {
    this.updateHandlers.push(handler);
  }

  onCursor(handler: CursorHandler): void {
    this.cursorHandlers.push(handler);
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private notifyStatus(connected: boolean): void {
    for (const handler of this.statusHandlers) {
      handler(connected);
    }
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
