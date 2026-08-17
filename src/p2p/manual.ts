import pc from "picocolors";
import qrcode from "qrcode-terminal";
import { P2PPeer } from "./webrtc";
import {
  serializeManualPayload,
  deserializeManualPayload,
  type ManualPayload,
} from "./signaling";
import { TerminalUI } from "../ui/terminal";

export interface ManualConnectionOptions {
  showQr?: boolean;
  timeoutMs?: number;
  onProgress?: (state: string) => void;
}

/**
 * Generate a complete manual offer token with all ICE candidates pre-gathered
 */
export async function createManualOffer(peer: P2PPeer, timeoutMs = 1500): Promise<string> {
  const local = await peer.createOffer(timeoutMs);
  const payload: ManualPayload = {
    role: "host",
    sdp: local.sdp,
    sdpType: "offer",
    candidates: local.candidates,
  };
  return serializeManualPayload(payload);
}

/**
 * Apply a remote manual offer token to a client peer
 */
export function applyManualOffer(peer: P2PPeer, token: string): ManualPayload {
  const payload = deserializeManualPayload(token);
  if (payload.sdpType !== "offer") {
    throw new Error(`Expected offer SDP token, received '${payload.sdpType}'`);
  }
  peer.setRemoteDescription(payload.sdp, payload.sdpType);
  for (const c of payload.candidates) {
    peer.addRemoteCandidate(c.candidate, c.mid);
  }
  return payload;
}

/**
 * Generate a complete manual answer token with all ICE candidates pre-gathered
 */
export async function createManualAnswer(peer: P2PPeer, timeoutMs = 1500): Promise<string> {
  const local = await peer.createAnswer(timeoutMs);
  const payload: ManualPayload = {
    role: "client",
    sdp: local.sdp,
    sdpType: "answer",
    candidates: local.candidates,
  };
  return serializeManualPayload(payload);
}

/**
 * Apply a remote manual answer token to a host peer
 */
export function applyManualAnswer(peer: P2PPeer, token: string): ManualPayload {
  const payload = deserializeManualPayload(token);
  if (payload.sdpType !== "answer") {
    throw new Error(`Expected answer SDP token, received '${payload.sdpType}'`);
  }
  peer.setRemoteDescription(payload.sdp, payload.sdpType);
  for (const c of payload.candidates) {
    peer.addRemoteCandidate(c.candidate, c.mid);
  }
  return payload;
}

/**
 * Interactive air-gapped pairing flow with progress state logging
 */
export async function connectManually(
  role: "host" | "client",
  options: ManualConnectionOptions = {}
): Promise<P2PPeer> {
  const peer = new P2PPeer({ role });
  const timeoutMs = options.timeoutMs || 1500;

  peer.on("error", (err) => {
    console.error(pc.red("\n[bun-p2p] Peer error:"), err instanceof Error ? err.message : err);
  });

  // ICE state change logging
  peer.on("ice-state-change", (state: string) => {
    const stateColor =
      state === "connected" || state === "completed"
        ? pc.green(state)
        : state === "checking"
        ? pc.yellow(state)
        : pc.dim(state);

    console.log(pc.dim("  [WebRTC] ICE State: ") + stateColor);
    options.onProgress?.(state);
  });

  TerminalUI.printBanner(role === "host" ? "Air-Gapped Host Pairing" : "Air-Gapped Client Pairing");

  if (role === "host") {
    console.log(pc.yellow("⏳ Gathering ICE candidates (complete token mode)..."));
    const token = await createManualOffer(peer, timeoutMs);

    console.log(pc.bold(pc.green("\n✔ Host Offer Generated! (Self-Contained Token)")));
    console.log(pc.dim("Share this token with the client peer (or scan QR code):\n"));

    if (options.showQr !== false) {
      try {
        qrcode.generate(token, { small: true });
      } catch {
        // ignore if terminal cannot render
      }
    }

    console.log(pc.bgBlack(pc.cyan(`\n${token}\n`)));

    const answerToken = await TerminalUI.prompt("Paste Client's Answer token: ");
    console.log(pc.yellow("\nApplying Client Answer..."));
    applyManualAnswer(peer, answerToken);
  } else {
    const offerToken = await TerminalUI.prompt("Paste Host's Offer token: ");
    console.log(pc.yellow("\nApplying Host Offer..."));
    applyManualOffer(peer, offerToken);

    console.log(pc.yellow("⏳ Gathering ICE answer candidates..."));
    const answerToken = await createManualAnswer(peer, timeoutMs);

    console.log(pc.bold(pc.green("\n✔ Client Answer Generated! (Self-Contained Token)")));
    console.log(pc.dim("Paste this token back into the Host's terminal:\n"));

    if (options.showQr !== false) {
      try {
        qrcode.generate(answerToken, { small: true });
      } catch {
        // ignore
      }
    }

    console.log(pc.bgBlack(pc.cyan(`\n${answerToken}\n`)));
  }

  console.log(pc.yellow("Establishing direct P2P DataChannels..."));
  await new Promise<void>((resolve) => {
    peer.on("connected", () => {
      resolve();
    });
  });

  TerminalUI.printConnectionCard({
    role,
    mode: "collab",
    sas: peer.sas || undefined,
    latencyMs: peer.currentRtt,
  });

  return peer;
}
