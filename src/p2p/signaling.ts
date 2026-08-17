import { EventEmitter } from "node:events";
import pc from "picocolors";
import { packSdpPayload, unpackSdpPayload } from "../utils/crypto";

export const DEFAULT_GLOBAL_RELAY = process.env.SIGNAL_RELAY || "wss://relay.bun-p2p.dev";
export const DEFAULT_LOCAL_RELAY = "ws://127.0.0.1:8765";

export interface SignalData {
  sdp?: string;
  sdpType?: "offer" | "answer" | "pranswer" | "rollback";
  candidate?: string;
  mid?: string;
}

export interface SignalingMessage {
  type: "join" | "signal" | "peer-joined" | "peer-left" | "ping" | "pong" | "error";
  room: string;
  role?: "host" | "client";
  peerId: string;
  target?: string;
  data?: SignalData;
  message?: string;
}

export interface ManualPayload {
  role: "host" | "client";
  room?: string;
  sdp: string;
  sdpType: "offer" | "answer";
  candidates: Array<{ candidate: string; mid: string }>;
  fingerprint?: string;
}

/**
 * WebSocket-based Room Signaling Client
 */
export class WebSocketSignalingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private isClosed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly serverUrl: string,
    public readonly room: string,
    public readonly role: "host" | "client",
    public readonly peerId: string
  ) {
    super();
  }

  /**
   * Safely emit error only if listeners are registered, preventing unhandled exception crashes.
   */
  private emitSafeError(err: unknown): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  public connect(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      let isSettled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          this.close();
          const err = new Error(
            `Failed to connect to signaling server at ${this.serverUrl} (connection timed out after ${timeoutMs}ms). Please ensure the signaling server is running.`
          );
          this.emitSafeError(err);
          reject(err);
        }
      }, timeoutMs);

      try {
        this.ws = new WebSocket(this.serverUrl);

        const onOpen = () => {
          if (isSettled) return;
          isSettled = true;
          cleanup();

          if (this.ws) {
            // Send join message
            const joinMsg: SignalingMessage = {
              type: "join",
              room: this.room,
              role: this.role,
              peerId: this.peerId,
            };
            this.ws.send(JSON.stringify(joinMsg));

            // Start heartbeat
            this.pingInterval = setInterval(() => {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "ping", room: this.room, peerId: this.peerId }));
              }
            }, 15000);

            this.emit("connected");
            resolve();
          }
        };

        const onError = (evt: Event | Error) => {
          if (!isSettled) {
            isSettled = true;
            cleanup();
            const err = new Error(
              `Failed to connect to signaling server at ${this.serverUrl}. Please ensure the signaling server is running.`
            );
            this.emitSafeError(err);
            reject(err);
          } else {
            this.emitSafeError(evt);
          }
        };

        const onMessage = (event: MessageEvent) => {
          try {
            const msg: SignalingMessage = JSON.parse(event.data.toString());
            if (msg.type === "pong" || msg.type === "ping") return;

            if (msg.type === "peer-joined") {
              this.emit("peer-joined", msg.peerId);
            } else if (msg.type === "peer-left") {
              this.emit("peer-left", msg.peerId);
            } else if (msg.type === "signal" && msg.data) {
              this.emit("signal", msg.data, msg.peerId);
            } else if (msg.type === "error") {
              this.emitSafeError(new Error(msg.message || "Signaling error"));
            }
          } catch (e) {
            this.emitSafeError(e);
          }
        };

        const onClose = () => {
          cleanup();
          if (this.pingInterval) clearInterval(this.pingInterval);
          if (!isSettled) {
            isSettled = true;
            const err = new Error(
              `Failed to connect to signaling server at ${this.serverUrl} (connection closed). Please ensure the signaling server is running.`
            );
            this.emitSafeError(err);
            reject(err);
            return;
          }
          if (!this.isClosed) {
            this.emit("disconnected");
          }
        };

        this.ws.onopen = onOpen;
        this.ws.onerror = onError;
        this.ws.onmessage = onMessage;
        this.ws.onclose = onClose;
      } catch (e) {
        cleanup();
        isSettled = true;
        this.emitSafeError(e);
        reject(e);
      }
    });
  }

  public sendSignal(data: SignalData, target?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling WebSocket is not connected");
    }

    const msg: SignalingMessage = {
      type: "signal",
      room: this.room,
      role: this.role,
      peerId: this.peerId,
      target,
      data,
    };

    this.ws.send(JSON.stringify(msg));
  }

  public close(): void {
    this.isClosed = true;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

/**
 * Built-in High-Performance Bun WebSocket Signaling Server
 */
export function startSignalingServer(port = 8765, host = "0.0.0.0"): { server: ReturnType<typeof Bun.serve>; close: () => void } {
  interface ClientData {
    room?: string;
    role?: "host" | "client";
    peerId?: string;
  }

  const rooms = new Map<string, Set<any>>();

  const server = Bun.serve<ClientData>({
    port,
    hostname: host,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", activeRooms: rooms.size }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (server.upgrade(req, { data: {} })) {
        return undefined;
      }
      return new Response("⚡ bun-p2p Signaling Server Active", { status: 200 });
    },
    websocket: {
      open(ws) {
        // Connected
      },
      message(ws, rawMsg) {
        try {
          const msg = JSON.parse(rawMsg.toString()) as SignalingMessage;
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", room: msg.room, peerId: msg.peerId }));
            return;
          }

          if (msg.type === "join") {
            ws.data.room = msg.room;
            ws.data.role = msg.role;
            ws.data.peerId = msg.peerId;

            if (!rooms.has(msg.room)) {
              rooms.set(msg.room, new Set());
            }
            const roomSet = rooms.get(msg.room)!;
            roomSet.add(ws);

            // Notify others in room
            for (const client of roomSet) {
              if (client !== ws) {
                client.send(
                  JSON.stringify({
                    type: "peer-joined",
                    room: msg.room,
                    peerId: msg.peerId,
                    role: msg.role,
                  })
                );
              }
            }
            return;
          }

          if (msg.type === "signal") {
            const roomSet = rooms.get(msg.room);
            if (!roomSet) return;

            for (const client of roomSet) {
              if (client !== ws) {
                if (!msg.target || client.data.peerId === msg.target) {
                  client.send(JSON.stringify(msg));
                }
              }
            }
          }
        } catch {
          // ignore malformed
        }
      },
      close(ws) {
        const room = ws.data.room;
        if (room && rooms.has(room)) {
          const roomSet = rooms.get(room)!;
          roomSet.delete(ws);
          for (const client of roomSet) {
            client.send(
              JSON.stringify({
                type: "peer-left",
                room,
                peerId: ws.data.peerId,
              })
            );
          }
          if (roomSet.size === 0) {
            rooms.delete(room);
          }
        }
      },
    },
  });

  return {
    server,
    close: () => {
      server.stop();
    },
  };
}

/**
 * Ensures a signaling server is running. If not already active on port, spawns embedded server.
 */
export function ensureSignalingServer(port = 8765, host = "0.0.0.0"): {
  server: ReturnType<typeof Bun.serve> | null;
  isEmbedded: boolean;
  close: () => void;
} {
  try {
    const inst = startSignalingServer(port, host);
    return {
      server: inst.server,
      isEmbedded: true,
      close: inst.close,
    };
  } catch {
    return {
      server: null,
      isEmbedded: false,
      close: () => {},
    };
  }
}

/**
 * Manual Air-gapped Exchange Utilities
 */
export function serializeManualPayload(payload: ManualPayload): string {
  return packSdpPayload(payload);
}

export function deserializeManualPayload(encoded: string): ManualPayload {
  return unpackSdpPayload<ManualPayload>(encoded);
}
