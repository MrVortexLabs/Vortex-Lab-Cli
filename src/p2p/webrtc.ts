import { EventEmitter } from "node:events";
import type { PeerConnection, DataChannel } from "node-datachannel";
import { getNodeDataChannel } from "./native-loader";
import { generateSAS } from "../utils/crypto";

export interface P2PConnectionOptions {
  peerName?: string;
  iceServers?: string[];
  role: "host" | "client";
}

export interface ControlMessage {
  type:
    | "handshake"
    | "handshake-ack"
    | "ping"
    | "pong"
    | "resize"
    | "mode-change"
    | "file-start"
    | "file-chunk-ack"
    | "file-end"
    | "file-ack"
    | "disconnect";
  payload?: any;
  timestamp?: number;
}

export class P2PPeer extends EventEmitter {
  private pc: PeerConnection;
  private controlDc: DataChannel | null = null;
  private ptyDc: DataChannel | null = null;
  private fileDc: DataChannel | null = null;
  public pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  private remoteCandidatesQueue: Array<{ candidate: string; mid: string }> = [];
  private remoteDescriptionSet = false;
  private isConnected = false;
  private isClosed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  public localDescription: { sdp: string; type: "offer" | "answer" } | null = null;
  public remoteDescription: { sdp: string; type: "offer" | "answer" } | null = null;
  public sas: { words: string[]; code: string; emoji: string } | null = null;
  public currentRtt = 0;

  constructor(public readonly options: P2PConnectionOptions) {
    super();

    const nd = getNodeDataChannel();
    const iceServers = options.iceServers || [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302",
      "stun:global.stun.twilio.com:3478",
      "stun:stun.cloudflare.com:3478",
    ];

    this.pc = new nd.PeerConnection(options.peerName || options.role, {
      iceServers,
    });

    this.setupPeerConnection();

    if (options.role === "host") {
      this.initHostChannels();
    }
  }

  private emitSafeError(err: unknown): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  private setupPeerConnection(): void {
    this.pc.onLocalDescription((sdp: string, type: string) => {
      this.localDescription = { sdp, type: type as "offer" | "answer" };
      this.emit("local-description", sdp, type);
    });

    this.pc.onLocalCandidate((candidate: string, mid: string) => {
      this.pendingCandidates.push({ candidate, mid });
      this.emit("local-candidate", candidate, mid);
    });

    this.pc.onStateChange((state: string) => {
      this.emit("state-change", state);
      if (state === "closed" || state === "failed") {
        this.handleDisconnect();
      }
    });

    this.pc.onDataChannel((dc: DataChannel) => {
      try {
        const label = dc.getLabel();
        this.attachDataChannel(label, dc);
      } catch (err) {
        this.emitSafeError(err);
      }
    });
  }

  private initHostChannels(): void {
    try {
      const control = this.pc.createDataChannel("control");
      this.attachDataChannel("control", control);

      const pty = this.pc.createDataChannel("pty");
      this.attachDataChannel("pty", pty);

      const file = this.pc.createDataChannel("file");
      this.attachDataChannel("file", file);
    } catch (err) {
      this.emitSafeError(err);
    }
  }

  private attachDataChannel(label: string, dc: DataChannel): void {
    if (label === "control") {
      this.controlDc = dc;
    } else if (label === "pty") {
      this.ptyDc = dc;
    } else if (label === "file") {
      this.fileDc = dc;
    }

    dc.onOpen(() => {
      this.checkAllChannelsReady();
    });

    dc.onClosed(() => {
      this.emit("channel-closed", label);
    });

    dc.onError((err: string) => {
      this.emitSafeError(new Error(`DataChannel [${label}] error: ${err}`));
    });

    dc.onMessage((data: string | Buffer) => {
      try {
        if (label === "control") {
          this.handleControlData(data);
        } else if (label === "pty") {
          const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
          this.emit("pty-data", buf);
        } else if (label === "file") {
          const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
          this.emit("file-data", buf);
        }
      } catch (err) {
        this.emitSafeError(err);
      }
    });
  }

  private checkAllChannelsReady(): void {
    const ready =
      this.controlDc?.isOpen() &&
      this.ptyDc?.isOpen() &&
      this.fileDc?.isOpen();

    if (ready && !this.isConnected) {
      this.isConnected = true;
      this.startPingLoop();
      this.deriveSAS();
      this.emit("connected");
    }
  }

  private deriveSAS(): void {
    try {
      const localDesc = this.localDescription?.sdp || "";
      const remoteDesc = this.remoteDescription?.sdp || "";
      if (localDesc && remoteDesc) {
        this.sas = generateSAS(localDesc, remoteDesc);
      }
    } catch {
      // Fallback
    }
  }

  private handleControlData(data: string | Buffer): void {
    try {
      const str = typeof data === "string" ? data : data.toString("utf-8");
      const msg: ControlMessage = JSON.parse(str);

      if (msg.type === "ping") {
        this.sendControl({ type: "pong", timestamp: msg.timestamp });
        return;
      }

      if (msg.type === "pong" && msg.timestamp) {
        this.currentRtt = Math.max(1, Date.now() - msg.timestamp);
        this.emit("latency", this.currentRtt);
        return;
      }

      if (msg.type === "disconnect") {
        this.handleDisconnect();
        return;
      }

      this.emit("control-msg", msg);
    } catch (e) {
      this.emitSafeError(e);
    }
  }

  private startPingLoop(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.controlDc?.isOpen()) {
        try {
          this.sendControl({ type: "ping", timestamp: Date.now() });
        } catch {
          // ignore
        }
      }
    }, 2500);
  }

  public setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    if (this.remoteDescriptionSet) return;
    try {
      this.remoteDescription = { sdp, type };
      this.pc.setRemoteDescription(sdp, type);
      this.remoteDescriptionSet = true;
      this.deriveSAS();

      // Flush any queued candidates
      while (this.remoteCandidatesQueue.length > 0) {
        const item = this.remoteCandidatesQueue.shift()!;
        try {
          this.pc.addRemoteCandidate(item.candidate, item.mid);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      this.emitSafeError(err);
    }
  }

  public addRemoteCandidate(candidate: string, mid: string): void {
    try {
      if (this.remoteDescriptionSet) {
        this.pc.addRemoteCandidate(candidate, mid);
      } else {
        this.remoteCandidatesQueue.push({ candidate, mid });
      }
    } catch (err) {
      this.emitSafeError(err);
    }
  }

  public sendControl(msg: ControlMessage): boolean {
    try {
      if (this.controlDc && this.controlDc.isOpen()) {
        return this.controlDc.sendMessage(JSON.stringify(msg));
      }
    } catch (err) {
      this.emitSafeError(err);
    }
    return false;
  }

  public sendPty(data: Buffer | Uint8Array | string): boolean {
    try {
      if (this.ptyDc && this.ptyDc.isOpen()) {
        if (typeof data === "string") {
          return this.ptyDc.sendMessage(data);
        }
        return this.ptyDc.sendMessageBinary(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
    } catch (err) {
      this.emitSafeError(err);
    }
    return false;
  }

  public sendFileChunk(data: Buffer | Uint8Array): boolean {
    try {
      if (this.fileDc && this.fileDc.isOpen()) {
        return this.fileDc.sendMessageBinary(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
    } catch (err) {
      this.emitSafeError(err);
    }
    return false;
  }

  public getFileBufferedAmount(): number {
    try {
      return this.fileDc ? this.fileDc.bufferedAmount() : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Flow control for large file streaming: wait until buffered amount drops below threshold
   */
  public async waitForFileDrain(threshold = 256 * 1024): Promise<void> {
    if (!this.fileDc || !this.fileDc.isOpen()) return;

    if (this.fileDc.bufferedAmount() <= threshold) return;

    return new Promise((resolve) => {
      const check = () => {
        if (!this.fileDc || !this.fileDc.isOpen() || this.fileDc.bufferedAmount() <= threshold) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      try {
        this.fileDc.setBufferedAmountLowThreshold(threshold);
        this.fileDc.onBufferedAmountLow(() => {
          resolve();
        });
      } catch {
        // ignore
      }
      setTimeout(check, 20);
    });
  }

  public async gatherAllCandidates(timeoutMs = 1500): Promise<{
    sdp: string;
    sdpType: "offer" | "answer";
    candidates: Array<{ candidate: string; mid: string }>;
  }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
      }, timeoutMs);

      const finish = () => {
        clearTimeout(timer);
        try {
          const desc = this.pc.localDescription();
          if (!desc) {
            reject(new Error("Local description not available after gathering"));
            return;
          }
          resolve({
            sdp: desc.sdp,
            sdpType: desc.type as "offer" | "answer",
            candidates: [...this.pendingCandidates],
          });
        } catch (err) {
          reject(err);
        }
      };

      this.pc.onGatheringStateChange((state: string) => {
        if (state === "complete") {
          finish();
        }
      });

      if (this.pc.gatheringState() === "complete") {
        finish();
      }
    });
  }

  private handleDisconnect(): void {
    if (this.isClosed) return;
    this.isConnected = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.emit("disconnected");
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.isConnected = false;

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    try {
      this.sendControl({ type: "disconnect" });
    } catch {
      // ignore
    }

    try {
      this.controlDc?.close();
      this.ptyDc?.close();
      this.fileDc?.close();
      this.pc.close();
    } catch {
      // ignore
    }

    this.emit("disconnected");
  }
}
