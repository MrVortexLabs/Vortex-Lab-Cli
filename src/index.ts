#!/usr/bin/env bun
import { Command } from "commander";
import pc from "picocolors";
import qrcode from "qrcode-terminal";
import { P2PPeer } from "./p2p/webrtc";
import {
  WebSocketSignalingClient,
  startSignalingServer,
  ensureSignalingServer,
  serializeManualPayload,
  deserializeManualPayload,
  DEFAULT_GLOBAL_RELAY,
  DEFAULT_LOCAL_RELAY,
  type ManualPayload,
} from "./p2p/signaling";
import { hostTerminalSession, joinTerminalSession } from "./terminal/pty";
import { FileTransferEngine } from "./transfer/stream";
import { generatePeerId } from "./utils/crypto";
import { TerminalUI } from "./ui/terminal";
import { runInteractiveWizard } from "./ui/wizard";
import { getPrimaryLanIp, generateShortRoomCode, parseConnectionString } from "./utils/network";
import { connectManually } from "./p2p/manual";

const program = new Command();

program
  .name("bun-p2p")
  .description("⚡ Zero-relay, E2EE real-time terminal pair-programming and file streaming via WebRTC")
  .version("1.0.0");

/**
 * Establish a WebRTC connection via WebSocket Signaling Server
 */
async function connectViaSignaling(
  role: "host" | "client",
  room: string,
  relayUrl: string,
  isLocal = false
): Promise<P2PPeer> {
  const peerId = generatePeerId();
  const peer = new P2PPeer({ role });

  // If local mode is active on host, ensure in-process signaling server is running
  if (role === "host" && (isLocal || relayUrl.includes("127.0.0.1") || relayUrl.includes("localhost"))) {
    const serverCheck = ensureSignalingServer(8765, "0.0.0.0");
    if (serverCheck.isEmbedded) {
      TerminalUI.registerCleanup(() => serverCheck.close());
    }
  }

  const signaling = new WebSocketSignalingClient(relayUrl, room, role, peerId);

  // Attach error listeners to prevent EventEmitter unhandled crashes
  signaling.on("error", () => {
    // Handled in catch block
  });

  peer.on("error", (err) => {
    console.error(pc.red("\n[bun-p2p] Peer connection error:"), err instanceof Error ? err.message : err);
  });

  TerminalUI.printBanner(`Connecting Session: ${pc.cyan(room)}`);
  console.log(pc.dim("  Signaling Relay: ") + pc.white(relayUrl));
  console.log(pc.dim("  Peer ID:         ") + pc.white(peerId));
  console.log(pc.dim("  Role:            ") + pc.bold(role === "host" ? pc.green("HOST") : pc.blue("CLIENT")));

  if (role === "host") {
    if (isLocal || relayUrl.includes("127.0.0.1") || relayUrl.includes("localhost")) {
      const lanIp = getPrimaryLanIp();
      console.log(pc.dim("  Scope:           ") + pc.yellow("Local LAN (In-Process Broker)"));
      console.log(`\n  ${pc.bold(pc.yellow("📍 Local Session Key:"))} ${pc.bold(pc.white(`${room}@${lanIp}`))}`);
      console.log(pc.dim("\n  Share with your LAN peer:"));
      console.log(pc.cyan(`    vtx join ${room}@${lanIp}\n`));
    } else {
      console.log(pc.dim("  Scope:           ") + pc.green("Global WAN (Cross-Network / Internet)"));
      console.log(`\n  ${pc.bold(pc.green("🔑 Global Session Key:"))} ${pc.bold(pc.white(room))}`);
      console.log(pc.dim("\n  Share with your peer:"));
      console.log(pc.cyan(`    vtx join ${room}\n`));
    }
  }

  console.log(pc.dim("  Status:          ") + pc.yellow("Connecting to signaling broker..."));

  // Forward local descriptions and candidates to signaling server
  peer.on("local-description", (sdp, sdpType) => {
    try {
      signaling.sendSignal({ sdp, sdpType });
    } catch {
      // ignored if not connected yet
    }
  });

  peer.on("local-candidate", (candidate, mid) => {
    try {
      signaling.sendSignal({ candidate, mid });
    } catch {
      // ignored
    }
  });

  // When another peer joins or announces presence, replay credentials if host
  signaling.on("peer-joined", () => {
    if (role === "host") {
      if (peer.localDescription) {
        try {
          signaling.sendSignal({
            sdp: peer.localDescription.sdp,
            sdpType: peer.localDescription.type,
          });
        } catch {
          // ignore
        }
      }
      for (const c of peer.pendingCandidates) {
        try {
          signaling.sendSignal({ candidate: c.candidate, mid: c.mid });
        } catch {
          // ignore
        }
      }
    }
  });

  try {
    await signaling.connect(10000);
    console.log(pc.green("✔ Connected to signaling broker. Waiting for peer..."));
    // If host and offer is already generated, send it
    if (role === "host" && peer.localDescription) {
      signaling.sendSignal({
        sdp: peer.localDescription.sdp,
        sdpType: peer.localDescription.type,
      });
      for (const c of peer.pendingCandidates) {
        signaling.sendSignal({ candidate: c.candidate, mid: c.mid });
      }
    }
  } catch (err: any) {
    TerminalUI.restoreTerminalState();
    console.error(pc.red(`\n✖ Could not connect to signaling server at ${relayUrl}`));
    console.error(pc.dim("  Reason: ") + pc.white(err?.message || "Connection failed"));
    console.error(pc.dim("\n  Tips:"));
    console.error(pc.dim("  • Run with '--local' for local offline/LAN signaling."));
    console.error(pc.dim("  • Or pass '--manual' to use 100% offline / air-gapped Base64 token pairing."));
    peer.close();
    process.exit(1);
  }

  // Handle incoming signals from peer
  signaling.on("signal", (data) => {
    try {
      if (data.sdp && data.sdpType) {
        peer.setRemoteDescription(data.sdp, data.sdpType);
      }
      if (data.candidate && data.mid) {
        peer.addRemoteCandidate(data.candidate, data.mid);
      }
    } catch {
      // ignore malformed remote signals
    }
  });

  signaling.on("peer-left", () => {
    console.log(pc.yellow("\n[bun-p2p] Peer disconnected from room."));
  });

  // Wait for WebRTC DataChannels to become ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Don't timeout host while waiting for client to join
      if (role === "client") {
        reject(new Error("Peer connection timed out. Make sure host is online in this room."));
      }
    }, 45000);

    peer.on("connected", () => {
      clearTimeout(timeout);
      // Once connected, signaling is no longer required!
      signaling.close();
      resolve();
    });
  });

  TerminalUI.printConnectionCard({
    room,
    role,
    mode: "collab",
    sas: peer.sas || undefined,
    latencyMs: peer.currentRtt,
  });

  return peer;
}

// ---------------- COMMAND: host ----------------
program
  .command("host")
  .description("Host a shared terminal session (Global Internet by default)")
  .option("-r, --room <room>", "Session Key / Room ID", generateShortRoomCode("VTX"))
  .option("-m, --mode <mode>", "Collaboration mode: 'collab' (interactive) or 'view' (read-only)", "collab")
  .option("-s, --shell <shell>", "Custom shell command (e.g. /bin/zsh, /bin/bash)")
  .option("--relay <url>", "Signaling WebSocket URL")
  .option("--local", "Use local LAN in-process signaling broker")
  .option("--manual", "Use offline/air-gapped Base64 SDP token exchange")
  .option("--no-qr", "Disable QR code rendering in manual mode")
  .action(async (opts) => {
    try {
      const mode = opts.mode === "view" ? "view" : "collab";
      let peer: P2PPeer;

      if (opts.manual) {
        peer = await connectManually("host", { showQr: opts.qr });
      } else {
        const relayUrl = opts.relay || (opts.local ? DEFAULT_LOCAL_RELAY : DEFAULT_GLOBAL_RELAY);
        peer = await connectViaSignaling("host", opts.room, relayUrl, Boolean(opts.local));
      }

      await hostTerminalSession(peer, {
        mode,
        shell: opts.shell,
        room: opts.room,
      });
    } catch (err: any) {
      TerminalUI.restoreTerminalState();
      console.error(pc.red("\n[bun-p2p] Host Error:"), err?.message || err);
      process.exit(1);
    }
  });

// ---------------- COMMAND: join ----------------
program
  .command("join [connection]")
  .description("Join a remote shared terminal session (e.g. 'VTX-9821' or 'VTX-9821@192.168.1.35')")
  .option("-m, --mode <mode>", "Collaboration mode: 'collab' or 'view'", "collab")
  .option("--relay <url>", "Signaling WebSocket URL")
  .option("--local", "Force local LAN relay")
  .option("--manual", "Use offline/air-gapped Base64 SDP token exchange")
  .option("--no-qr", "Disable QR code rendering in manual mode")
  .action(async (connectionArg, opts) => {
    try {
      const mode = opts.mode === "view" ? "view" : "collab";
      let peer: P2PPeer;

      if (opts.manual) {
        peer = await connectManually("client", { showQr: opts.qr });
      } else {
        let input = connectionArg;
        if (!input) {
          input = await TerminalUI.prompt("Enter Session Key (e.g. VTX-9821 or VTX-9821@192.168.1.35): ");
        }
        const parsed = parseConnectionString(input);
        const relayUrl =
          opts.relay ||
          parsed.relayUrl ||
          (opts.local ? DEFAULT_LOCAL_RELAY : DEFAULT_GLOBAL_RELAY);
        peer = await connectViaSignaling("client", parsed.room, relayUrl, Boolean(opts.local));
      }

      await joinTerminalSession(peer, {
        mode,
        room: connectionArg,
      });
    } catch (err: any) {
      TerminalUI.restoreTerminalState();
      console.error(pc.red("\n[bun-p2p] Join Error:"), err?.message || err);
      process.exit(1);
    }
  });

// ---------------- COMMAND: send ----------------
program
  .command("send <path>")
  .description("Direct memory-to-memory stream file/folder to peer over WebRTC DataChannel")
  .option("-r, --room <room>", "Session Key / Room ID", generateShortRoomCode("VTX"))
  .option("--relay <url>", "Signaling WebSocket URL")
  .option("--local", "Use local LAN in-process signaling broker")
  .option("--manual", "Use offline/air-gapped Base64 SDP token exchange")
  .option("--no-qr", "Disable QR code rendering in manual mode")
  .action(async (targetPath, opts) => {
    try {
      let peer: P2PPeer;

      if (opts.manual) {
        peer = await connectManually("host", { showQr: opts.qr });
      } else {
        const relayUrl = opts.relay || (opts.local ? DEFAULT_LOCAL_RELAY : DEFAULT_GLOBAL_RELAY);
        peer = await connectViaSignaling("host", opts.room, relayUrl, Boolean(opts.local));
      }

      await FileTransferEngine.send(peer, targetPath);
      peer.close();
      TerminalUI.restoreTerminalState();
      process.exit(0);
    } catch (err: any) {
      TerminalUI.restoreTerminalState();
      console.error(pc.red("\n[bun-p2p] Send Error:"), err?.message || err);
      process.exit(1);
    }
  });

// ---------------- COMMAND: receive ----------------
program
  .command("receive [outputDir]")
  .description("Receive streamed files/folders directly from peer over WebRTC DataChannel")
  .option("-r, --room <room>", "Session Key or connection string")
  .option("--relay <url>", "Signaling WebSocket URL")
  .option("--local", "Force local LAN relay")
  .option("--manual", "Use offline/air-gapped Base64 SDP token exchange")
  .option("--no-qr", "Disable QR code rendering in manual mode")
  .action(async (outputDir = "./", opts) => {
    try {
      let peer: P2PPeer;

      if (opts.manual) {
        peer = await connectManually("client", { showQr: opts.qr });
      } else {
        let input = opts.room;
        if (!input) {
          input = await TerminalUI.prompt("Enter Sender's Session Key (e.g. VTX-9821): ");
        }
        const parsed = parseConnectionString(input);
        const relayUrl =
          opts.relay ||
          parsed.relayUrl ||
          (opts.local ? DEFAULT_LOCAL_RELAY : DEFAULT_GLOBAL_RELAY);
        peer = await connectViaSignaling("client", parsed.room, relayUrl, Boolean(opts.local));
      }

      await FileTransferEngine.receive(peer, outputDir);
      peer.close();
      TerminalUI.restoreTerminalState();
      process.exit(0);
    } catch (err: any) {
      TerminalUI.restoreTerminalState();
      console.error(pc.red("\n[bun-p2p] Receive Error:"), err?.message || err);
      process.exit(1);
    }
  });

// ---------------- COMMAND: pair ----------------
program
  .command("pair")
  .description("Interactive wizard for air-gapped / offline pairing")
  .action(async () => {
    try {
      TerminalUI.printBanner("Air-Gapped WebRTC Pairing Wizard");
      console.log("1. Host a session (generate Offer)");
      console.log("2. Join a session (input Offer, generate Answer)");
      const choice = await TerminalUI.prompt("\nSelect mode (1 or 2): ");

      if (choice === "1") {
        const peer = await connectManually("host");
        await hostTerminalSession(peer, { mode: "collab" });
      } else {
        const peer = await connectManually("client");
        await joinTerminalSession(peer, { mode: "collab" });
      }
    } catch (err: any) {
      TerminalUI.restoreTerminalState();
      console.error(pc.red("\n[bun-p2p] Pairing Error:"), err?.message || err);
      process.exit(1);
    }
  });

// ---------------- COMMAND: signal-server ----------------
program
  .command("signal-server")
  .description("Start a lightweight, ultra-fast WebSocket signaling coordinator with Bun")
  .option("-p, --port <port>", "Port to listen on", "8765")
  .option("-h, --host <host>", "Host to listen on", "0.0.0.0")
  .action((opts) => {
    try {
      const port = parseInt(opts.port, 10);
      const serverInstance = startSignalingServer(port, opts.host);

      TerminalUI.printBanner("Signaling Server Running");
      console.log(pc.dim("  Listening on:  ") + pc.bold(pc.green(`ws://${opts.host}:${port}`)));
      console.log(pc.dim("  Health check:  ") + pc.cyan(`http://${opts.host}:${port}/health`));
      console.log(pc.dim("  Protocol:      ") + pc.white("Bun native WebSocket RFC 6455"));
      console.log(pc.dim("\nPeers can now connect via:"));
      console.log(pc.yellow(`  bun-p2p host --relay ws://127.0.0.1:${port}`));
      console.log(pc.yellow(`  bun-p2p join <code> --relay ws://127.0.0.1:${port}\n`));
    } catch (err: any) {
      console.error(pc.red("\n[bun-p2p] Server Error:"), err?.message || err);
      process.exit(1);
    }
  });

// ---------------- COMMAND: auto / wizard ----------------
async function launchWizard() {
  await runInteractiveWizard({
    onHost: async ({ room, relayUrl, mode, isGlobal }) => {
      const peer = await connectViaSignaling("host", room, relayUrl, !isGlobal);
      await hostTerminalSession(peer, { mode, room });
    },
    onJoin: async ({ room, relayUrl, mode }) => {
      const peer = await connectViaSignaling("client", room, relayUrl);
      await joinTerminalSession(peer, { mode, room });
    },
    onSend: async ({ targetPath, room, relayUrl, isGlobal }) => {
      const peer = await connectViaSignaling("host", room, relayUrl, !isGlobal);
      await FileTransferEngine.send(peer, targetPath);
      peer.close();
      TerminalUI.restoreTerminalState();
      process.exit(0);
    },
    onReceive: async ({ outputDir, room, relayUrl }) => {
      const peer = await connectViaSignaling("client", room, relayUrl);
      await FileTransferEngine.receive(peer, outputDir);
      peer.close();
      TerminalUI.restoreTerminalState();
      process.exit(0);
    },
    onServer: ({ port, host }) => {
      const serverInstance = startSignalingServer(port, host);
      TerminalUI.printBanner("Signaling Server Running");
      console.log(pc.dim("  Listening on:  ") + pc.bold(pc.green(`ws://${host}:${port}`)));
      console.log(pc.dim("  Health check:  ") + pc.cyan(`http://${host}:${port}/health`));
    },
  });
}

program
  .command("auto")
  .alias("wizard")
  .description("Launch the interactive Auto & Wizard Mode")
  .action(async () => {
    try {
      await launchWizard();
    } catch (err: any) {
      TerminalUI.restoreTerminalState();
      console.error(pc.red("\n[bun-p2p] Wizard Error:"), err?.message || err);
      process.exit(1);
    }
  });

// If no subcommand provided, default to Interactive Wizard
if (process.argv.length <= 2) {
  launchWizard().catch((err) => {
    TerminalUI.restoreTerminalState();
    console.error(pc.red("\n[bun-p2p] Error:"), err?.message || err);
    process.exit(1);
  });
} else {
  program.parse(process.argv);
}
